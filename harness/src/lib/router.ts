/**
 * Routeur pré-vol — avant de lancer la VRAIE session sur un message, un appel ÉCLAIR à un modèle
 * léger lit le message et décide {modèle, effort de réflexion} adaptés pour la session qui va
 * vraiment le traiter. But : router les échanges triviaux (« ça va ? », « ok », un emoji) vers un
 * modèle rapide/bon marché et un effort bas, et garder le modèle le plus capable / l'effort le plus
 * haut pour le lourd (code, analyse, décision) — économie de tokens et de latence, sans que ton
 * agent ait à s'auto-moduler après coup ni que l'humain doive y penser à chaque message.
 *
 * Détail du principe et des commandes de pilotage humain : docs/routeur-pre-vol.md.
 *
 * Pattern éprouvé en production ; ce module est GÉNÉRIQUE et AUTONOME — aucune dépendance
 * à une base de données ou un moteur précis. Branche `RouterStore` sur ta propre couche de stockage
 * (SQLite, fichier JSON…) et `EngineOptions` sur les options réelles de ton moteur.
 *
 * GARDE-FOUS (les risques qu'un routeur automatique fait courir, traités explicitement) :
 *  - un `/model` ou `/effort` FIXÉ À LA MAIN par l'humain PRIME toujours — le routeur ne route qu'en
 *    mode auto (voir « pin vs auto » dans la doc) ;
 *  - toute erreur / timeout du routeur → repli sur le défaut sûr (comportement sans routeur), JAMAIS
 *    de réveil bloqué ni retardé au-delà du timeout ;
 *  - décision validée contre une allowlist (modèle/effort inconnu → repli) ; prompt conservateur
 *    (« en cas de doute, monte en gamme ») pour ne jamais sous-doter une tâche difficile ;
 *  - binaire CLI officiel, authentification standard, jamais de clé API injectée dans le sous-process
 *    de classification — les mêmes règles que pour le moteur principal.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { EngineConfig } from "./engine-config.ts";
import { chatOpenAI } from "./engine-openai.ts";
import { runTurn } from "./engine.ts";

/** Modèle qui fait la classification — le plus rapide/économique de ta gamme. */
export const ROUTER_MODEL = "claude-haiku-4-5";

/** Cibles autorisées, du moins au plus capable. Une décision hors liste → repli. Exemples de la
 *  famille Claude (documentés publiquement) — remplace par la gamme que TU utilises réellement. */
export const ROUTE_MODELS = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-1"];
export const ROUTE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Une cible du routeur : l'id du modèle et la ligne qui dit au classificateur quand le choisir. */
export interface RouteModel {
  id: string;
  use: string;
}

/** La gamme par défaut (Claude), dans l'ordre de `ROUTE_MODELS`. */
export const CLAUDE_ROUTE_MODELS: RouteModel[] = [
  { id: "claude-haiku-4-5", use: "trivial (salutation, « ok », « ça va », accusé, emoji, question ultra-simple)." },
  { id: "claude-sonnet-5", use: "moyen (question factuelle courte, petite reformulation, info rapide sans enjeu)." },
  { id: "claude-opus-4-1", use: "complexe (code, analyse, décision, tâche multi-étapes, sujet sensible, ambigu, émotionnel)." },
];

/**
 * La gamme du routeur pour un moteur donné, du moins au plus capable. `claude` sans `MODELE_RAPIDE` ni
 * `MODELE_FORT` : la gamme Claude ci-dessus, inchangée. Sinon : les deux RÔLES de la config
 * (`MODELE_RAPIDE` pour le trivial et le moyen, `MODELE_FORT` pour le complexe), un seul si ce sont les
 * mêmes. PUR.
 */
export function routeModelsFor(cfg: EngineConfig | undefined): RouteModel[] {
  if (!cfg || (cfg.kind === "claude" && !cfg.models.rapide && !cfg.models.fort)) return CLAUDE_ROUTE_MODELS;
  const rapide = cfg.models.rapide ?? cfg.models.fort ?? ROUTER_MODEL;
  const fort = cfg.models.fort ?? (cfg.kind === "claude" ? CLAUDE_ROUTE_MODELS[CLAUDE_ROUTE_MODELS.length - 1].id : rapide);
  if (rapide === fort) return [{ id: fort, use: "tout message (un seul modèle configuré)." }];
  return [
    { id: rapide, use: "trivial ou moyen (salutation, « ok », accusé, question factuelle courte, info rapide sans enjeu)." },
    { id: fort, use: "complexe (code, analyse, décision, tâche multi-étapes, sujet sensible, ambigu, émotionnel)." },
  ];
}

/** Rangs d'une gamme (index dans la liste), pour le plancher et le cliquet. */
export function ranksOf(models: RouteModel[]): Record<string, number> {
  return Object.fromEntries(models.map((m, i) => [m.id, i]));
}

export interface RouteDecision {
  model: string;
  effort: string;
  reason?: string;
}

/** Options moteur minimales que ce module lit/écrit. Étends-la librement (les champs en plus
 *  traversent `routeEngineOpts` intacts) pour coller aux options réelles de ton moteur. */
export interface EngineOptions {
  model?: string;
  effort?: string;
  /** Chemin du binaire CLI de l'agent (défaut : "claude"). */
  bin?: string;
  [key: string]: unknown;
}

/** Surface de stockage clé/valeur attendue — à brancher sur SQLite, un fichier JSON, etc. Même
 *  esprit que `RestartStore` dans `restart-guard.ts` : un module pur, injectable pour les tests. */
export interface RouterStore {
  getSetting(key: string): string | null | undefined;
  setSetting(key: string, value: string): void;
}

/** Rang comparatif {modèle, effort} → sert au plancher (cliquet ou plancher explicite, jamais en
 *  dessous). Un id de modèle INCONNU de cette table prend un rang très élevé (pas 0) : le plancher
 *  ne doit JAMAIS pouvoir DÉGRADER un modèle qu'il ne reconnaît pas — fail open, pas fail-downgrade.
 *  Adapte cette table si tu changes `ROUTE_MODELS`. */
const MODEL_RANK: Record<string, number> = {
  "claude-haiku-4-5": 0,
  "claude-sonnet-5": 1,
  "claude-opus-4-1": 2,
};
const UNKNOWN_MODEL_RANK = 99;
const EFFORT_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

/** Relève `model` au plancher `floor` s'il est en dessous (jamais ne redescend ; un modèle inconnu
 *  de la table n'est jamais touché — voir MODEL_RANK). Absent (aucun modèle résolu) est traité comme
 *  en dessous de tout, comme l'effort absent dans `raiseEffort`. PUR. */
export function raiseModel(model: string | undefined, floor: string, ranks: Record<string, number> = MODEL_RANK): string {
  const cur = model ? (ranks[model] ?? UNKNOWN_MODEL_RANK) : -1;
  const flr = ranks[floor] ?? UNKNOWN_MODEL_RANK;
  return flr > cur ? floor : (model ?? floor);
}
/** Relève `effort` au plancher `floor` s'il est en dessous ou absent (« auto »). PUR. */
export function raiseEffort(effort: string | undefined, floor: string): string {
  const cur = effort ? (EFFORT_RANK[effort] ?? -1) : -1;
  return (EFFORT_RANK[floor] ?? -1) > cur ? floor : (effort ?? floor);
}

/** Plancher {modèle, effort} du cliquet de gamme (ratchet) — même forme que le paramètre `floor` de
 *  `routeEngineOpts`. */
export interface RatchetFloor {
  model: string;
  effort: string;
}

/** Fenêtre d'inactivité par défaut du cliquet : tant qu'un fil reste actif dans ce délai, le
 *  plancher posé (par le routeur OU un pin manuel) ne redescend jamais tout seul ; passé ce délai
 *  sans message, le sujet est considéré clos et le cliquet retombe (repart de zéro au message
 *  suivant). Configurable via `deps.ratchetWindowMs`. */
export const ROUTER_RATCHET_WINDOW_MS_DEFAULT = 45 * 60 * 1000;

function routerRatchetKey(scopeId?: string): string {
  return scopeId ? `router_ratchet:${scopeId}` : "router_ratchet";
}

/** Lit le cliquet actif pour ce scope — `undefined` si absent OU si la fenêtre d'inactivité est
 *  écoulée (dans ce cas on NE le supprime pas explicitement du store ; il sera simplement réécrit
 *  par le prochain tour, cf. `writeRatchet`). PUR. */
export function readRatchet(
  store: Pick<RouterStore, "getSetting">,
  scopeId: string | undefined,
  nowMs: number,
  windowMs: number,
): RatchetFloor | undefined {
  const raw = store.getSetting(routerRatchetKey(scopeId));
  if (!raw) return undefined;
  try {
    const r = JSON.parse(raw) as { model?: unknown; effort?: unknown; at?: unknown };
    if (typeof r.model !== "string" || typeof r.effort !== "string" || typeof r.at !== "number") return undefined;
    if (nowMs - r.at > windowMs) return undefined; // fenêtre d'inactivité écoulée → cliquet retombé
    return { model: r.model, effort: r.effort };
  } catch {
    return undefined;
  }
}

function writeRatchet(store: Pick<RouterStore, "setSetting">, scopeId: string | undefined, floor: RatchetFloor, nowMs: number): void {
  try {
    store.setSetting(routerRatchetKey(scopeId), JSON.stringify({ model: floor.model, effort: floor.effort, at: nowMs }));
  } catch {
    /* best-effort — le cliquet n'est qu'un confort, jamais un blocage */
  }
}

/** Prochain cliquet après un tour dont les options EFFECTIVES (post-pin, post-plancher) sont `opts` :
 *  le max(rang) entre `opts` et le cliquet précédent (`prev`) — jamais en dessous de ce qui était déjà
 *  posé, monte si `opts` est plus haut. Sans `prev` (première pose / fenêtre expirée), le cliquet
 *  démarre à `opts` tel quel. `undefined` seulement si rien d'exploitable. PUR. */
function nextRatchet(opts: EngineOptions, prev: RatchetFloor | undefined, ranks: Record<string, number> = MODEL_RANK): RatchetFloor | undefined {
  if (!opts.model && !prev) return undefined;
  return {
    model: prev ? raiseModel(opts.model, prev.model, ranks) : (opts.model as string),
    effort: prev ? raiseEffort(opts.effort, prev.effort) : (opts.effort ?? "low"),
  };
}

export interface PinState {
  modelPinned: boolean;
  effortPinned: boolean;
}

/** Lit un réglage {model,effort} en préférant la variante SCOPÉE (`<key>:<scopeId>`) si elle existe,
 *  sinon le réglage GLOBAL (`<key>`). Un scope explicite prime pour LUI ; l'absence de scope (ou un
 *  scope sans réglage propre) retombe sur le global. Une valeur scopée VIDE ("") est explicite
 *  (« auto/relâché » pour ce scope) et prime quand même. PUR (lecture store seule). */
export function scopedSetting(store: Pick<RouterStore, "getSetting">, key: string, scopeId?: string): string | null {
  if (scopeId) {
    const scoped = store.getSetting(`${key}:${scopeId}`);
    if (scoped !== null && scoped !== undefined) return scoped;
  }
  const v = store.getSetting(key);
  return v === undefined ? null : v;
}

/**
 * Lit l'état d'épinglage MANUEL {modèle, effort}. Source unique de vérité partagée par
 * `routeEngineOpts` (qui route) et l'affichage (`/status`, entête) — pour que « épinglé » veuille
 * dire la même chose partout. Sentinelles : `model=""` ⇒ défaut (non épinglé) ; `effort` absent ou
 * `"auto"` ⇒ non épinglé. Dès que l'humain tape `/model X` ou `/effort Y` (≠ auto), le champ est
 * « épinglé » et le routeur ne le touche plus, jusqu'à `/model auto` / `/unpin`. PUR.
 *
 * C'est LE point subtil du garde-fou : la valeur seule ne suffit pas à savoir si le champ a été
 * choisi à la main ou vaut son défaut — c'est la sentinelle (vide / "auto") qui distingue les deux,
 * et `/status` la rend visible (cf. `pinSourceLabel`, `engineHeader`).
 */
export function readPins(store: Pick<RouterStore, "getSetting">, scopeId?: string): PinState {
  const model = scopedSetting(store, "model", scopeId);
  const effort = scopedSetting(store, "effort", scopeId);
  return {
    modelPinned: !!model,
    effortPinned: !!effort && effort !== "auto",
  };
}

/** Résout les options moteur effectives : le réglage épinglé (`/model`, `/effort`, en store) prime
 *  sur le défaut passé en `base`. PUR. */
function resolvePinnedOpts(store: RouterStore, base: EngineOptions, scopeId?: string): EngineOptions {
  const model = scopedSetting(store, "model", scopeId);
  const effort = scopedSetting(store, "effort", scopeId);
  return {
    ...base,
    model: model || base.model,
    effort: effort && effort !== "auto" ? effort : undefined,
  };
}

/** Libellé court d'un id de modèle (opus/sonnet/haiku) ou l'id brut si inconnu. Adapte cette table
 *  si tu changes `ROUTE_MODELS`. PUR. */
const SHORT_MODEL: Record<string, string> = {
  "claude-opus-4-1": "opus",
  "claude-sonnet-5": "sonnet",
  "claude-haiku-4-5": "haiku",
};
export function shortModel(model: string | null | undefined): string {
  if (!model) return "défaut";
  return SHORT_MODEL[model] ?? model;
}

/** Étiquette de source du couple {modèle, effort} effectif : "routeur" (choisi auto), "épinglé"
 *  (les deux fixés main), ou "mixte" (l'un fixé, l'autre auto). PUR. */
export function pinSourceLabel(pins: PinState): "routeur" | "épinglé" | "mixte" {
  if (pins.modelPinned && pins.effortPinned) return "épinglé";
  if (!pins.modelPinned && !pins.effortPinned) return "routeur";
  return "mixte";
}

/** Entête « ⊙ modèle/effort · source » à afficher en tête d'une réponse à l'humain (transparence du
 *  choix pré-vol). PUR. */
export function engineHeader(model: string | null | undefined, effort: string | null | undefined, pins: PinState): string {
  const e = effort && effort !== "auto" ? effort : "auto";
  return `⊙ ${shortModel(model)}/${e} · ${pinSourceLabel(pins)}`;
}

/** Bloc d'instruction à injecter dans le prompt (côté daemon) pour que l'agent COMMENCE sa réponse
 *  par l'entête ci-dessus. N'injecte ça qu'en réponse au fil principal (pas aux tiers/groupes). PUR. */
export function engineHeaderHint(model: string | null | undefined, effort: string | null | undefined, pins: PinState): string {
  return `[entête-routeur] Commence ta réponse par cette ligne seule, puis saut de ligne (transparence du choix pré-vol) :\n${engineHeader(model, effort, pins)}`;
}

/** Un tour de conversation gardé dans le buffer roulant du routeur. `text` = message tronqué (voir
 *  ROUTER_CTX_CHARS), `at` = epoch ms. */
export interface RouterTurn {
  text: string;
  at: number;
}

/** Prompt de classification (PUR → testable). Bref et conservateur. `history` (optionnel, plus
 *  ancien d'abord) = les tout derniers messages de CE fil, injectés en lecture seule pour que le
 *  routeur juge le MESSAGE courant à la lumière du fil plutôt qu'isolément — sans `history`,
 *  comportement inchangé. */
export function buildRouterPrompt(ctx: string, history: RouterTurn[] = [], models: RouteModel[] = CLAUDE_ROUTE_MODELS): string {
  const historyBlock =
    history.length === 0
      ? []
      : [
          "",
          "Historique récent de CE fil (pour comprendre le CONTEXTE seulement — ne classe pas ces messages, seulement le MESSAGE ci-dessous) :",
          ...history.map((t) => `- ${t.text}`),
        ];
  return [
    "Tu es un routeur de modèle. Une session d'assistant IA va traiter le MESSAGE ci-dessous.",
    "Choisis le modèle et l'effort de réflexion adaptés. EN CAS DE DOUTE, MONTE en gamme.",
    ...historyBlock,
    "",
    "Modèles :",
    ...models.map((m) => `- ${m.id} : ${m.use}`),
    "",
    "Effort : low (trivial) | medium (moyen) | high (complexe) | xhigh (très complexe) | max (critique).",
    "",
    "Réponds UNIQUEMENT par un objet JSON compact, rien d'autre :",
    '{"model":"<un des modèles ci-dessus>","effort":"<un des efforts>","reason":"<3-6 mots>"}',
    "",
    "MESSAGE :",
    ctx.slice(0, 2000),
  ].join("\n");
}

/** Parse + valide la sortie du routeur (PUR → testable). null si illisible ou hors allowlist. */
export function parseRouterDecision(raw: string, allowed: string[] = ROUTE_MODELS): RouteDecision | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: unknown;
  try {
    o = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (typeof r.model !== "string" || typeof r.effort !== "string") return null;
  if (!allowed.includes(r.model)) return null;
  if (!ROUTE_EFFORTS.includes(r.effort)) return null;
  return {
    model: r.model,
    effort: r.effort,
    reason: typeof r.reason === "string" ? r.reason.slice(0, 80) : undefined,
  };
}

/** Nombre de tours gardés dans le buffer roulant de contexte, et troncature par tour. Bornés bas
 *  exprès (prompt de classification qui reste petit/rapide = tout l'intérêt du routeur pré-vol) :
 *  assez pour que le classificateur voie « on est en plein chantier », pas assez pour peser sur son
 *  coût/latence. */
const ROUTER_CTX_TURNS = 3;
const ROUTER_CTX_CHARS = 200;

function routerCtxKey(scopeId?: string): string {
  return scopeId ? `router_ctx:${scopeId}` : "router_ctx";
}

/** Lit le buffer roulant de CE scope (plus ancien d'abord), [] si absent/illisible. PUR. */
export function readRouterContext(store: Pick<RouterStore, "getSetting">, scopeId?: string): RouterTurn[] {
  const raw = store.getSetting(routerCtxKey(scopeId));
  if (!raw) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (t): t is RouterTurn => !!t && typeof t === "object" && typeof (t as RouterTurn).text === "string" && typeof (t as RouterTurn).at === "number",
    );
  } catch {
    return [];
  }
}

/** Ajoute `text` au buffer roulant de CE scope (tronqué, borné à ROUTER_CTX_TURNS, le plus ancien
 *  tombe). Best-effort : un échec d'écriture ne doit jamais faire échouer le réveil. */
function appendRouterContext(store: Pick<RouterStore, "getSetting" | "setSetting">, scopeId: string | undefined, text: string, nowMs: number): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const history = readRouterContext(store, scopeId);
  history.push({ text: trimmed.slice(0, ROUTER_CTX_CHARS), at: nowMs });
  try {
    store.setSetting(routerCtxKey(scopeId), JSON.stringify(history.slice(-ROUTER_CTX_TURNS)));
  } catch {
    /* best-effort — le contexte n'est qu'un confort, jamais un blocage */
  }
}

/** Appelle le modèle léger pour classer un contexte. Timeout borné ; renvoie null sur TOUTE erreur
 *  (→ repli). cwd = un dossier temporaire (pas l'âme de l'agent) pour rester léger/rapide ; pas de
 *  config MCP (aucun outil nécessaire pour classer un message).
 *
 *  `engine` (optionnel, `readEngineConfig`) : sans lui, ou avec le moteur `claude` sans modèles
 *  nommés, l'appel est celui d'avant (`claude -p … --model ROUTER_MODEL`). Moteur `claude` avec
 *  `MODELE_RAPIDE` : ce modèle classe. Moteur `openai-compatible` : un appel HTTP direct à
 *  `MODELE_RAPIDE`, et la gamme devient les deux rôles (`routeModelsFor`). */
export function classifyRoute(
  ctx: string,
  opts: { bin?: string; timeoutMs?: number; history?: RouterTurn[]; engine?: EngineConfig; fetchFn?: typeof fetch } = {},
): Promise<RouteDecision | null> {
  const models = routeModelsFor(opts.engine);
  const prompt = buildRouterPrompt(ctx, opts.history, models);
  const allowed = models.map((m) => m.id);
  if (opts.engine && opts.engine.kind === "openai-compatible") {
    return chatOpenAI({
      baseUrl: opts.engine.baseUrl as string,
      apiKey: opts.engine.apiKey,
      model: opts.engine.models.rapide as string,
      prompt,
      timeoutMs: opts.timeoutMs ?? 12000,
      fetchFn: opts.fetchFn,
    }).then(
      (r) => (r.ok ? parseRouterDecision(r.text, allowed) : null),
      () => null,
    );
  }
  if (opts.engine && opts.engine.kind === "opencode") {
    // OpenCode démarre en quelques secondes : on lui laisse au moins 30 s pour classer.
    return runTurn(opts.engine, { prompt, role: "rapide", timeoutMs: Math.max(opts.timeoutMs ?? 0, 30_000) }).then(
      (r) => (r.ok ? parseRouterDecision(r.text, allowed) : null),
      () => null,
    );
  }
  const routerModel = opts.engine?.models.rapide ?? ROUTER_MODEL;
  const args = ["-p", prompt, "--output-format", "json", "--model", routerModel, "--permission-mode", "default"];
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // jamais de clé API → auth standard de la sub-session, comme le moteur principal.
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: RouteDecision | null): void => {
      if (done) return;
      done = true;
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.bin ?? opts.engine?.claudeBin ?? "claude", args, { cwd: tmpdir(), env, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* déjà mort */
      }
      finish(null);
    }, opts.timeoutMs ?? 12000);
    timer.unref?.();
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return finish(null);
      try {
        const j = JSON.parse(out) as { result?: string };
        finish(parseRouterDecision(j.result ?? "", allowed));
      } catch {
        finish(null);
      }
    });
  });
}

/**
 * Résout les options moteur en consultant le routeur pré-vol (PUR côté logique ; le seul I/O est
 * `classify`, injectable pour les tests). Combine, par priorité DÉCROISSANTE :
 *   1. réglage manuel de l'humain (`/model`, `/effort` ≠ auto) — toujours respecté ;
 *   2. décision du routeur (si mode auto sur ce champ), éclairée par le CONTEXTE récent du fil
 *      (`history`, cf. `buildRouterPrompt`) — un « vas-y » se juge à la lumière de ce qui précède, pas
 *      isolément. Le classificateur reste libre de juger que le sujet a changé et de redescendre — le
 *      contexte n'est qu'un ÉCLAIRAGE, ce n'est pas encore le filet ci-dessous ;
 *   3. défaut de config (repli si le routeur échoue) ;
 *   4. `floor` (plancher explicite passé par l'appelant, prioritaire) OU, à défaut, le CLIQUET DE
 *      GAMME (`ratchet`) — plancher appliqué en dernier (jamais sur un champ épinglé), ne fait jamais
 *      redescendre : une fois monté sur ce fil (par le routeur OU un pin manuel), y reste tant que le
 *      fil reste actif dans la fenêtre `ROUTER_RATCHET_WINDOW_MS_DEFAULT` (glissante — relancée à
 *      CHAQUE tour, même trivial), retombe seul après (cf. `readRatchet`/`nextRatchet`). C'est le
 *      filet bon marché du cas où le contexte seul n'aurait pas suffi à convaincre le classificateur
 *      (ex. un « vas-y » trivial en plein chantier complexe ne doit pas faire retomber la conversation
 *      sur un modèle léger). Persiste la valeur POST-plancher dans `router_last` (transparence, /status).
 *
 * `scopeId` (optionnel) isole le cliquet ET le buffer de contexte par conversation/canal — sans lui,
 * tous les appels partagent une clé globale (comportement historique, adapté à un agent mono-fil).
 * Passe l'identifiant réel du fil (chat, thread…) dès que ton agent peut parler à plusieurs
 * interlocuteurs ou canaux en parallèle, pour ne pas faire fuiter le contexte/cliquet de l'un vers
 * l'autre.
 */
export async function routeEngineOpts(
  store: RouterStore,
  base: EngineOptions,
  ctx: string,
  deps: {
    classify?: (ctx: string, o: { bin?: string; timeoutMs?: number; history?: RouterTurn[]; engine?: EngineConfig }) => Promise<RouteDecision | null>;
    timeoutMs?: number;
    /** Moteur configuré (`readEngineConfig`) : choisit la gamme et la voie de classification. */
    engine?: EngineConfig;
    nowMs?: number;
    ratchetWindowMs?: number;
  } = {},
  scopeId?: string,
  floor?: RatchetFloor,
): Promise<{ opts: EngineOptions; decision: RouteDecision | null }> {
  const resolved = resolvePinnedOpts(store, base, scopeId);
  const { modelPinned, effortPinned } = readPins(store, scopeId);
  const now = deps.nowMs ?? Date.now();
  const ranks = deps.engine ? ranksOf(routeModelsFor(deps.engine)) : MODEL_RANK;
  // Cliquet : lu AVANT d'appliquer quoi que ce soit, pour servir de plancher à CE tour ; réécrit plus
  // bas (via `nextRatchet`) avec les options EFFECTIVES de ce même tour, fenêtre glissante réarmée à `now`.
  const stored = readRatchet(store, scopeId, now, deps.ratchetWindowMs ?? ROUTER_RATCHET_WINDOW_MS_DEFAULT);
  // Un cliquet posé sous une AUTRE gamme (changement de moteur) ne sert pas de plancher : son modèle
  // n'existe peut-être pas chez ce fournisseur.
  const ratchet = deps.engine && stored && !(stored.model in ranks) ? undefined : stored;
  const effectiveFloor = floor ?? ratchet;
  const applyFloor = (o: EngineOptions): EngineOptions =>
    !effectiveFloor
      ? o
      : {
          ...o,
          model: modelPinned ? o.model : raiseModel(o.model, effectiveFloor.model, ranks),
          effort: effortPinned ? o.effort : raiseEffort(o.effort, effectiveFloor.effort),
        };
  // Contexte roulant de CE scope, lu AVANT d'y ajouter le message courant (cf. `buildRouterPrompt`).
  const history = readRouterContext(store, scopeId);
  // Épilogue commun à TOUTES les issues (pin complet, décision, repli) : le contexte s'accumule et le
  // cliquet se réarme dans tous les cas — y compris quand on économise l'appel de classification (pins
  // complets), car un pin manuel qui monte en gamme doit, lui aussi, poser le cliquet.
  const finish = (opts: EngineOptions, decision: RouteDecision | null): { opts: EngineOptions; decision: RouteDecision | null } => {
    appendRouterContext(store, scopeId, ctx, now);
    const next = nextRatchet(opts, ratchet, ranks);
    if (next) writeRatchet(store, scopeId, next, now);
    return { opts, decision };
  };
  // Rien à router si les deux champs sont fixés à la main : on économise l'appel de classification (le
  // plancher ne s'applique de toute façon jamais à un champ épinglé — pas la peine de le calculer).
  if (modelPinned && effortPinned) return finish(resolved, null);
  const classify = deps.classify ?? classifyRoute;
  const decision = await classify(ctx, { bin: base.bin, timeoutMs: deps.timeoutMs, history, ...(deps.engine ? { engine: deps.engine } : {}) });
  if (!decision) return finish(applyFloor(resolved), null); // repli sûr, plancher/cliquet quand même
  const opts: EngineOptions = applyFloor({
    ...resolved,
    model: modelPinned ? resolved.model : decision.model,
    effort: effortPinned ? resolved.effort : decision.effort,
  });
  try {
    store.setSetting(
      "router_last",
      JSON.stringify({
        at: now,
        model: opts.model,
        effort: opts.effort ?? "auto",
        reason: decision.reason ?? "",
        ctx: ctx.slice(0, 80),
      }),
    );
  } catch {
    /* transparence best-effort — ne jamais faire échouer le réveil */
  }
  return finish(opts, decision);
}
