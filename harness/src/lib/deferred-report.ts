/**
 * deferred-report — le rapport du matin s'écrit la nuit, il part à heure fixe.
 *
 * Problème : une consolidation nocturne (le « rêve », `phase-chain.ts`) finit son rapport vers 4 h-5 h. Le
 * lui envoyer à la minute où il est écrit, c'est réveiller l'humain (ou polluer une conversation qu'il n'a
 * pas mise en sourdine). Le rapport est donc composé la nuit et envoyé à l'heure que l'humain a choisie.
 *
 * LE PARTAGE DES RÔLES. La dernière phase (une session) écrit le texte et le DÉPOSE. Le daemon, sans
 * moteur, l'envoie à l'heure : réveiller une session à 7 h 30 pour recopier un texte déjà écrit coûterait un
 * tour et pourrait le réécrire.
 *
 * TROIS PIÈGES QUE CE MODULE FERME.
 *  1. Un porteur déployé n'est pas un porteur actif : le daemon qui tourne peut être plus vieux que ce
 *     fichier. Le runner signe chaque passage (`HEARTBEAT_KEY`), et le dépôt REFUSE (code 3) quand la
 *     signature manque ou date : la phase envoie alors elle-même. Un dépôt que personne ne porte serait un
 *     rapport perdu en silence.
 *  2. Le rejeu au démarrage (rapports non acquittés) ressuscite la phase au premier redémarrage qui la suit.
 *     Avec un envoi différé, ce rejeu tomberait souvent AVANT l'heure d'envoi, verrait un canal sans rapport,
 *     et pourrait l'envoyer une seconde fois. `reportCarriedFor` lui dit que le rapport de cette nuit est porté.
 *  3. Un envoi coupé en vol (redémarrage pendant l'appel réseau) ne doit ni se perdre ni partir deux fois :
 *     l'état note la tentative AVANT l'appel (`inFlightMs`), et le passage suivant SONDE le fil avant de renvoyer.
 *
 * Et deux politiques : une destination préférée (un canal dédié) puis un repli (le chat principal) après
 * `PREFERRED_ATTEMPTS` échecs, puis un dernier recours hors canal après `MAX_ATTEMPTS`, puis abandon de la
 * file (un rapport ne doit pas tourner en boucle toute la journée). Un rapport déposé APRÈS l'heure d'envoi
 * (chaîne affamée) part tout de suite : le garder jusqu'au lendemain le rendrait faux.
 *
 * Tout ce qui décide est PUR ; les I/O (messagerie, horloge, stockage clé/valeur) sont injectés.
 */
import { dayIn, wallToEpoch } from "./presence-mode.ts";

/** Le rapport en attente (JSON), une seule entrée à la fois. */
export const PENDING_KEY = "dream_report_pending";
/** Les envois faits, du plus ancien au plus récent (JSON, borné à `SENDS_KEPT`). */
export const SENDS_KEY = "dream_report_sends";
/** L'heure d'envoi, « HH:MM » dans le fuseau de l'humain, ou « off » (= dès que déposé). Absent = `DEFAULT_SEND_TIME`. */
export const SEND_TIME_KEY = "dream_report_send_time";
/** Epoch ms du dernier passage du runner : la preuve qu'un daemon porte l'envoi différé. */
export const HEARTBEAT_KEY = "dream_report_sender_tick_ms";

export const DEFAULT_SEND_TIME = "07:30";
/** Cadence du runner : 07h30 veut dire 07h30, pas 07h35. */
export const SENDER_POLL_MS = 60_000;
/** Au-delà, le runner est réputé absent (5 passages manqués). */
export const HEARTBEAT_STALE_MS = 5 * 60_000;
/** Échecs vers la destination préférée avant le repli (≈ 3 min à la cadence du runner). */
export const PREFERRED_ATTEMPTS = 3;
/** Échecs au total avant le dernier recours, puis abandon de la file. */
export const MAX_ATTEMPTS = 20;
export const SENDS_KEPT = 30;
/** Un rapport plus long ne passe pas en un message lisible ; c'est une erreur de composition. */
export const MAX_TEXT_CHARS = 20_000;

export interface PendingReport {
  /** `dream-AAAA-MM-JJ` : la nuit dont c'est le rapport. */
  chainId: string;
  text: string;
  depositedMs: number;
  sendAtMs: number;
  /** Tentatives d'envoi échouées. */
  attempts: number;
  lastError?: string | null;
  /** Posé juste AVANT un appel d'envoi, effacé par sa conclusion. Présent au passage suivant = la tentative
   *  précédente a été coupée sans conclure (redémarrage) : on sonde avant de renvoyer. */
  inFlightMs?: number | null;
}

export type SentVia = "prefere" | "repli" | "secours";

export interface SentReport {
  chainId: string;
  messageId: string | null;
  chatId: string | null;
  via: SentVia;
  sentMs: number;
  depositedMs: number;
  sendAtMs: number;
}

/** Ce que ce module lit et écrit de ta base (une table clé/valeur suffit). */
export interface DeferStore {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  deleteSetting(key: string): void;
}

// ── Heure d'envoi ──────────────────────────────────────────────────────────────────────────────

export type SendTime = { hh: number; mm: number } | "off";

/** « 07:30 », « 7h30 », « 7:30 », « off ». Invalide ou absent → l'heure par défaut. */
export function parseSendTime(v: string | null | undefined): SendTime {
  const s = (v ?? "").trim().toLowerCase();
  if (s === "off") return "off";
  const m = /^(\d{1,2})\s*[:h]\s*(\d{2})$/.exec(s);
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh <= 23 && mm <= 59) return { hh, mm };
  }
  const d = /^(\d{2}):(\d{2})$/.exec(DEFAULT_SEND_TIME)!;
  return { hh: Number(d[1]), mm: Number(d[2]) };
}

export function formatSendTime(t: SendTime): string {
  return t === "off" ? "off" : `${String(t.hh).padStart(2, "0")}:${String(t.mm).padStart(2, "0")}`;
}

/** « HH:MM » d'un instant dans le fuseau `tz` (pour les messages de refus et le journal). */
export function hmIn(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
}

/**
 * Quand part un rapport déposé à `nowMs` ? L'heure du jour dans le fuseau `tz` si elle est encore devant ;
 * sinon TOUT DE SUITE. « off » = tout de suite. L'heure est figée au DÉPÔT : une bascule de fuseau entre le
 * dépôt (vers 5 h) et l'envoi ne la recalcule pas.
 */
export function sendAtFor(nowMs: number, time: SendTime, tz: string): number {
  if (time === "off") return nowMs;
  const at = wallToEpoch(dayIn(nowMs, tz), time.hh, time.mm, tz);
  return at > nowMs ? at : nowMs;
}

// ── Dépôt ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Les défauts qui interdisent de déposer ce texte tel quel. Vide = déposable.
 * `forbidDoubleAsterisk` : certaines messageries ne sont pas du Markdown (le gras s'écrit avec UNE astérisque).
 */
export function textProblems(text: string, o: { forbidDoubleAsterisk?: boolean; maxChars?: number } = {}): string[] {
  const out: string[] = [];
  const max = o.maxChars ?? MAX_TEXT_CHARS;
  if (!text.trim()) out.push("texte vide");
  if (o.forbidDoubleAsterisk && text.includes("**")) out.push("`**` trouvé : cette messagerie n'est pas du Markdown, le gras s'écrit avec UNE astérisque");
  if (text.length > max) out.push(`${text.length} caractères (plafond ${max})`);
  return out;
}

export type DepositDecision =
  | { ok: true; pending: PendingReport }
  /** 3 = personne ne porte l'envoi : la session envoie elle-même. 2 = refus (texte, doublon). */
  | { ok: false; code: 2 | 3; reason: string };

export function decideDeposit(input: {
  nowMs: number;
  chainId: string;
  text: string;
  heartbeatMs: number | null;
  pending: PendingReport | null;
  sends: readonly SentReport[];
  time: SendTime;
  replace?: boolean;
  /** fuseau de l'humain (IANA) */
  tz: string;
  forbidDoubleAsterisk?: boolean;
}): DepositDecision {
  const problems = textProblems(input.text, { forbidDoubleAsterisk: input.forbidDoubleAsterisk });
  if (problems.length) return { ok: false, code: 2, reason: problems.join(" ; ") };
  if (input.sends.some((s) => s.chainId === input.chainId)) {
    return { ok: false, code: 2, reason: `le rapport de ${input.chainId} est déjà parti : un second serait un doublon` };
  }
  if (input.pending && !input.replace) {
    return {
      ok: false,
      code: 2,
      reason: `un rapport attend déjà (${input.pending.chainId}, déposé ${hmIn(input.pending.depositedMs, input.tz)}). \`--replace\` pour le remplacer, \`cancel\` pour le retirer`,
    };
  }
  const beat = input.heartbeatMs ?? 0;
  if (!(beat > 0) || input.nowMs - beat > HEARTBEAT_STALE_MS) {
    const since = beat > 0 ? `dernier passage du porteur à ${hmIn(beat, input.tz)}` : "aucun passage du porteur enregistré";
    return { ok: false, code: 3, reason: `le daemon ne porte pas l'envoi différé (${since}) : envoie le rapport toi-même, maintenant` };
  }
  return {
    ok: true,
    pending: {
      chainId: input.chainId,
      text: input.text,
      depositedMs: input.nowMs,
      sendAtMs: sendAtFor(input.nowMs, input.time, input.tz),
      attempts: 0,
      lastError: null,
      inFlightMs: null,
    },
  };
}

// ── Lecture / écriture de l'état ───────────────────────────────────────────────────────────────

export function readPending(store: Pick<DeferStore, "getSetting">): PendingReport | null {
  const raw = store.getSetting(PENDING_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as PendingReport;
    return p && typeof p.text === "string" && typeof p.chainId === "string" ? p : null;
  } catch {
    return null;
  }
}

export function writePending(store: DeferStore, p: PendingReport): void {
  store.setSetting(PENDING_KEY, JSON.stringify(p));
}

export function readSends(store: Pick<DeferStore, "getSetting">): SentReport[] {
  const raw = store.getSetting(SENDS_KEY);
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? (a as SentReport[]) : [];
  } catch {
    return [];
  }
}

/** Enregistre un envoi ET retire le rapport de la file, dans cet ordre : un crash entre les deux laisse un
 *  rapport en file déjà enregistré comme parti, que `decideTick` refuse de renvoyer. */
export function recordSent(store: DeferStore, s: SentReport): void {
  const all = [...readSends(store), s].slice(-SENDS_KEPT);
  store.setSetting(SENDS_KEY, JSON.stringify(all));
  store.deleteSetting(PENDING_KEY);
}

/** Le rapport de cette nuit est-il porté (en file ou parti) ? Lu par le rejeu au démarrage. */
export function reportCarriedFor(store: Pick<DeferStore, "getSetting">, chainId: string | null | undefined): boolean {
  if (!chainId) return false;
  if (readPending(store)?.chainId === chainId) return true;
  return readSends(store).some((s) => s.chainId === chainId);
}

// ── Le passage du runner ───────────────────────────────────────────────────────────────────────

export type TickAction =
  | { kind: "idle" }
  | { kind: "wait"; untilMs: number }
  /** Déjà enregistré comme parti : retirer de la file sans rien envoyer. */
  | { kind: "drop-duplicate" }
  /** La tentative précédente a été coupée en vol : sonder le fil avant tout renvoi. */
  | { kind: "probe"; chatId: string }
  | { kind: "send"; chatId: string; via: "prefere" | "repli"; text: string }
  | { kind: "last-resort"; text: string };

/** Le texte de repli : la cause en tête, pour que l'humain sache pourquoi le rapport n'est pas dans le canal habituel. */
export function fallbackText(text: string, cause: string | null | undefined): string {
  const c = (cause ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  return `(canal habituel injoignable${c ? ` : ${c}` : ""})\n\n${text}`;
}

/** Que faire de la file à `nowMs` ? `preferredChatId` null = pas de canal préféré configuré. */
export function decideTick(input: {
  nowMs: number;
  pending: PendingReport | null;
  sends: readonly SentReport[];
  preferredChatId: string | null;
  fallbackChatId: string | null;
}): TickAction {
  const p = input.pending;
  if (!p) return { kind: "idle" };
  if (input.sends.some((s) => s.chainId === p.chainId)) return { kind: "drop-duplicate" };
  if (input.nowMs < p.sendAtMs) return { kind: "wait", untilMs: p.sendAtMs };
  const toPreferred = input.preferredChatId !== null && p.attempts < PREFERRED_ATTEMPTS;
  const target = toPreferred ? input.preferredChatId : input.fallbackChatId;
  if (p.inFlightMs && target) return { kind: "probe", chatId: target };
  if (p.attempts >= MAX_ATTEMPTS || !target) return { kind: "last-resort", text: fallbackText(p.text, p.lastError) };
  if (toPreferred) return { kind: "send", chatId: input.preferredChatId!, via: "prefere", text: p.text };
  // Pas de canal préféré configuré : le chat principal EST la destination, pas un repli : aucun préfixe.
  const text = input.preferredChatId === null ? p.text : fallbackText(p.text, p.lastError);
  return { kind: "send", chatId: input.fallbackChatId!, via: "repli", text };
}

export interface TickDeps {
  store: DeferStore;
  now: () => number;
  /** fuseau de l'humain, pour les lignes de journal */
  tz: string;
  preferredChatId: string | null;
  fallbackChatId: string | null;
  /** Envoi : l'id du message, ou lève. */
  send: (chatId: string, text: string) => Promise<string | null>;
  /** Le message est-il déjà dans le fil ? id, ou null. */
  probe: (chatId: string, text: string) => Promise<string | null>;
  /** Dernier recours, hors du canal habituel (autre messagerie, e-mail…). */
  lastResort: (text: string) => Promise<boolean>;
  log?: (msg: string) => void;
}

/** Un passage. Ne lève jamais (le runner périodique l'attrape de toute façon). Rend l'action prise. */
export async function runSenderTick(d: TickDeps): Promise<TickAction["kind"]> {
  const log = d.log ?? ((m: string) => console.log(`[deferred-report] ${m}`));
  const now = d.now();
  d.store.setSetting(HEARTBEAT_KEY, String(now));
  const pending = readPending(d.store);
  const sends = readSends(d.store);
  const action = decideTick({ nowMs: now, pending, sends, preferredChatId: d.preferredChatId, fallbackChatId: d.fallbackChatId });
  if (!pending || action.kind === "idle" || action.kind === "wait") return action.kind;
  const sent = (chatId: string | null, via: SentVia, messageId: string | null): void =>
    recordSent(d.store, {
      chainId: pending.chainId, messageId, chatId, via,
      sentMs: d.now(), depositedMs: pending.depositedMs, sendAtMs: pending.sendAtMs,
    });

  if (action.kind === "drop-duplicate") {
    d.store.deleteSetting(PENDING_KEY);
    log(`${pending.chainId} déjà parti : retiré de la file sans renvoi.`);
    return action.kind;
  }
  if (action.kind === "probe") {
    const plain = d.preferredChatId === null || action.chatId === d.preferredChatId;
    const text = plain ? pending.text : fallbackText(pending.text, pending.lastError);
    let found: string | null = null;
    try {
      found = await d.probe(action.chatId, text);
    } catch (e) {
      log(`sonde indisponible (${(e as Error).message}) : nouvelle tentative au passage suivant.`);
      return action.kind;
    }
    if (found) {
      sent(action.chatId, d.preferredChatId !== null && action.chatId === d.preferredChatId ? "prefere" : "repli", found);
      log(`${pending.chainId} : la tentative coupée avait abouti (${found}), enregistré sans renvoi.`);
    } else {
      writePending(d.store, { ...pending, inFlightMs: null });
      log(`${pending.chainId} : la tentative coupée n'avait rien envoyé, renvoi au passage suivant.`);
    }
    return action.kind;
  }
  if (action.kind === "last-resort") {
    // Abandon de la file APRÈS ce geste, quelle qu'en soit l'issue : un rapport qui tourne toute la journée
    // en échec vaut moins que ce dernier essai par tous les canaux.
    let ok = false;
    try {
      ok = await d.lastResort(action.text);
    } catch (e) {
      log(`dernier recours en échec : ${(e as Error).message}`);
    }
    sent(null, "secours", null);
    log(`${pending.chainId} : ${pending.attempts} échecs, dernier recours ${ok ? "délivré" : "ÉCHOUÉ : rapport perdu"}.`);
    return action.kind;
  }
  writePending(d.store, { ...pending, inFlightMs: now });
  try {
    const id = await d.send(action.chatId, action.text);
    sent(action.chatId, action.via, id);
    log(`${pending.chainId} envoyé (${action.via}, ${id ?? "id inconnu"}), prévu ${hmIn(pending.sendAtMs, d.tz)}.`);
  } catch (e) {
    const msg = (e as Error).message;
    writePending(d.store, { ...pending, attempts: pending.attempts + 1, lastError: msg.slice(0, 300), inFlightMs: null });
    log(`${pending.chainId} : échec ${pending.attempts + 1} (${action.via}) : ${msg.slice(0, 200)}`);
  }
  return action.kind;
}

/**
 * Ajoute au rapport, au DÉPÔT et mécaniquement, une ligne produite ailleurs (ex. l'état d'un bureau des
 * plaintes) : une consigne en prose dans la dernière phase ne suffit pas, l'humain n'a alors aucun chiffre
 * sous les yeux. Rien si la ligne est absente, ne commence pas par `prefix`, ou est déjà dans le texte.
 */
export function appendLine(text: string, line: string | null, prefix: string): string {
  const l = (line ?? "").trim().split("\n")[0] ?? "";
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!l.startsWith(prefix) || new RegExp(`(^|\\n)\\s*[-•·]?\\s*${escaped}`).test(text)) return text;
  return `${text}\n\n${l}`;
}
