/**
 * engine-config — QUEL moteur d'inférence fait penser ton compagnon, lu depuis l'environnement (`.env`).
 *
 * Deux moteurs :
 *  - `claude` (défaut) : le CLI officiel Claude Code (`claude -p`), avec ton abonnement. Rien ne change
 *    pour qui l'utilise déjà.
 *  - `openai-compatible` : n'importe quel fournisseur qui parle le protocole OpenAI
 *    (`POST /v1/chat/completions`) : vLLM, LiteLLM, OpenRouter, Together, Groq, Ollama, un serveur
 *    d'entreprise… Les appels simples partent en HTTP direct ; les tours AVEC OUTILS (bash, édition,
 *    MCP) passent par OpenCode, un CLI agentique libre qui accepte ce fournisseur (`engine-opencode.ts`).
 *
 * Les modèles se nomment par RÔLE, jamais par un nom de famille en dur : `MODELE_RAPIDE` (trier, classer,
 * répondre à un « ok ») et `MODELE_FORT` (le vrai travail). Brancher ton API tient en trois lignes :
 *
 *     KINDLE_BASE_URL=https://inference.example.com/v1
 *     KINDLE_API_KEY=sk-...
 *     MODELE_FORT=nom-du-modele
 *
 * (`KINDLE_ENGINE` se déduit alors seul ; `MODELE_RAPIDE` absent = `MODELE_FORT`.)
 *
 * Budgets et quota : seul `claude` sait plafonner un tour en dollars (`--max-budget-usd`) et mesurer un
 * quota d'abonnement. Un fournisseur qui n'en donne pas ne fait rien planter : `limitsOf` le dit
 * (`budgetEnforced: false`, `quota: "illimite"` ou `"non-mesure"`), et c'est à toi de le savoir.
 *
 * Module PUR : `readEngineConfig(env)` prend l'environnement en argument (testable sans rien poser).
 */

export type EngineKind = "claude" | "openai-compatible";
export type ModelRole = "rapide" | "fort";
/** `abonnement` = quota mesuré par le fournisseur (Claude) ; `illimite` = déclaré illimité par toi ;
 *  `non-mesure` = le fournisseur n'en dit rien et tu n'as rien déclaré. */
export type QuotaMode = "abonnement" | "illimite" | "non-mesure";

export interface EngineConfig {
  kind: EngineKind;
  /** URL de base OpenAI (`…/v1`), sans `/chat/completions`. Null pour `claude`. */
  baseUrl: string | null;
  /** Clé du fournisseur. Null pour `claude` (OAuth du CLI, jamais de clé). */
  apiKey: string | null;
  /** Modèle par rôle. `null` (moteur `claude` seulement) = ne pas passer `--model` : le CLI prend le
   *  modèle par défaut du compte, exactement comme avant ce module. */
  models: Record<ModelRole, string | null>;
  /** Plafond en dollars par tour, appliqué seulement si le moteur sait le faire. */
  budgetUsd: number | null;
  quota: QuotaMode;
  /** Mode de permission du CLI Claude pour un tour avec outils (`--permission-mode`). */
  claudePermissionMode: string;
  /** Chemins des binaires (surchargeables pour les tests ou une install hors PATH). */
  claudeBin: string;
  opencodeBin: string;
}

export interface ConfigResult {
  config: EngineConfig | null;
  errors: string[];
  warnings: string[];
}

export const ENGINE_KINDS: EngineKind[] = ["claude", "openai-compatible"];
const KIND_ALIASES: Record<string, EngineKind> = {
  claude: "claude",
  anthropic: "claude",
  "openai-compatible": "openai-compatible",
  openai: "openai-compatible",
  "openai-compat": "openai-compatible",
};

type Env = Record<string, string | undefined>;

function pick(env: Env, ...names: string[]): string | null {
  for (const n of names) {
    const v = env[n]?.trim();
    if (v) return v;
  }
  return null;
}

/** Retire un `/chat/completions` collé par erreur et le `/` final : on veut la base `…/v1`. */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "").replace(/\/+$/, "");
}

export function readEngineConfig(env: Env = process.env): ConfigResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rawKind = pick(env, "KINDLE_ENGINE", "KINDLE_MOTEUR");
  const baseRaw = pick(env, "KINDLE_BASE_URL");
  let kind: EngineKind;
  if (rawKind) {
    const k = KIND_ALIASES[rawKind.toLowerCase()];
    if (!k) {
      errors.push(`KINDLE_ENGINE=« ${rawKind} » inconnu : choisis ${ENGINE_KINDS.join(" ou ")}.`);
      return { config: null, errors, warnings };
    }
    kind = k;
  } else {
    kind = baseRaw ? "openai-compatible" : "claude";
  }

  const fortEnv = pick(env, "MODELE_FORT", "MODEL_STRONG");
  const rapideEnv = pick(env, "MODELE_RAPIDE", "MODEL_FAST");
  const models: Record<ModelRole, string | null> =
    kind === "claude" ? { fort: fortEnv, rapide: rapideEnv } : { fort: fortEnv ?? "", rapide: rapideEnv ?? fortEnv ?? "" };

  let baseUrl: string | null = null;
  let apiKey: string | null = null;
  if (kind === "openai-compatible") {
    if (!baseRaw) errors.push("KINDLE_BASE_URL manque (ex. https://inference.example.com/v1).");
    else if (!/^https?:\/\//.test(baseRaw)) errors.push(`KINDLE_BASE_URL doit commencer par http:// ou https:// (lu : « ${baseRaw} »).`);
    else baseUrl = normalizeBaseUrl(baseRaw);
    apiKey = pick(env, "KINDLE_API_KEY");
    if (!apiKey) warnings.push("KINDLE_API_KEY vide : normal pour un serveur local (Ollama, vLLM sans auth), sinon les appels rendront 401.");
    if (!fortEnv) errors.push("MODELE_FORT manque : le nom exact du modèle chez ton fournisseur (voir `kindle doctor`, qui liste /models).");
  } else if (baseRaw) {
    warnings.push("KINDLE_BASE_URL est posé mais KINDLE_ENGINE=claude : il est ignoré.");
  }

  let budgetUsd: number | null = null;
  const budgetRaw = pick(env, "KINDLE_BUDGET_USD");
  if (budgetRaw) {
    const n = Number(budgetRaw);
    if (!Number.isFinite(n) || n <= 0) errors.push(`KINDLE_BUDGET_USD doit être un nombre > 0 (lu : « ${budgetRaw} »).`);
    else budgetUsd = n;
  }
  if (budgetUsd !== null && kind !== "claude") {
    warnings.push("KINDLE_BUDGET_USD ignoré : ce moteur ne sait pas plafonner un tour en dollars (le coût n'est connu qu'après coup, s'il l'est).");
  }

  const quotaRaw = pick(env, "KINDLE_QUOTA")?.toLowerCase() ?? null;
  let quota: QuotaMode;
  if (quotaRaw === "illimite" || quotaRaw === "illimité" || quotaRaw === "unlimited") quota = "illimite";
  else if (quotaRaw && quotaRaw !== "auto") {
    errors.push(`KINDLE_QUOTA=« ${quotaRaw} » inconnu : auto ou illimite.`);
    quota = "non-mesure";
  } else quota = kind === "claude" ? "abonnement" : "non-mesure";
  if (quota === "non-mesure" && !errors.length) {
    warnings.push("Quota non mesuré : ce fournisseur n'en publie pas. Pose KINDLE_QUOTA=illimite s'il l'est vraiment ; rien n'est bridé dans les deux cas.");
  }

  const permissionMode = pick(env, "KINDLE_CLAUDE_PERMISSION_MODE") ?? "acceptEdits";
  if (permissionMode === "bypassPermissions") {
    if (pick(env, "KINDLE_ALLOW_BYPASS") === "1") {
      warnings.push("bypassPermissions autorisé (KINDLE_ALLOW_BYPASS=1) : un tour avec outils a bash libre, sans demander, avec ton environnement. Sous OpenCode, aucun hook PreToolUse ne tourne. À réserver à un dossier jetable.");
    } else {
      errors.push("KINDLE_CLAUDE_PERMISSION_MODE=bypassPermissions est refusé par défaut : le modèle aurait bash libre sans aucune confirmation. Si tu le veux vraiment, pose aussi KINDLE_ALLOW_BYPASS=1 (et lance dans un dossier jetable).");
    }
  }

  if (errors.length) return { config: null, errors, warnings };
  return {
    config: {
      kind,
      baseUrl,
      apiKey,
      models,
      budgetUsd,
      quota,
      claudePermissionMode: permissionMode,
      claudeBin: pick(env, "KINDLE_CLAUDE_BIN") ?? "claude",
      opencodeBin: pick(env, "KINDLE_OPENCODE_BIN") ?? "opencode",
    },
    errors,
    warnings,
  };
}

/** Le modèle d'un rôle ; `null` = défaut du CLI Claude. */
export function modelFor(cfg: EngineConfig, role: ModelRole): string | null {
  return cfg.models[role];
}

export interface EngineLimits {
  /** Le moteur peut-il refuser de dépasser `budgetUsd` pendant le tour ? */
  budgetEnforced: boolean;
  budgetUsd: number | null;
  /** Le coût d'un tour revient-il chiffré ? (`claude` oui ; un fournisseur OpenAI, rarement.) */
  costReported: boolean;
  quota: QuotaMode;
  /** Une politique de quota doit-elle différer du travail ? Jamais quand le quota n'est pas mesuré :
   *  on ne bride pas sur une mesure qui n'existe pas. */
  quotaCanThrottle: boolean;
}

export function limitsOf(cfg: EngineConfig): EngineLimits {
  const claude = cfg.kind === "claude";
  return {
    budgetEnforced: claude && cfg.budgetUsd !== null,
    budgetUsd: claude ? cfg.budgetUsd : null,
    costReported: claude,
    quota: cfg.quota,
    quotaCanThrottle: cfg.quota === "abonnement",
  };
}

/** Résumé lisible de la config, clé masquée (pour `kindle doctor` et les journaux). */
export function describeConfig(cfg: EngineConfig): string[] {
  const key = cfg.apiKey ? `${cfg.apiKey.slice(0, 3)}…(${cfg.apiKey.length} car.)` : "aucune";
  const lines = [`moteur : ${cfg.kind}`];
  if (cfg.kind === "openai-compatible") lines.push(`base : ${cfg.baseUrl}`, `clé : ${key}`);
  const m = (v: string | null) => v ?? "(défaut du CLI)";
  lines.push(`MODELE_RAPIDE : ${m(cfg.models.rapide)}`, `MODELE_FORT : ${m(cfg.models.fort)}`);
  const l = limitsOf(cfg);
  lines.push(`budget par tour : ${l.budgetEnforced ? `${l.budgetUsd} $ (appliqué)` : "aucun plafond appliqué"}`);
  lines.push(`quota : ${cfg.quota}${l.quotaCanThrottle ? "" : " (rien n'est différé pour quota)"}`);
  return lines;
}
