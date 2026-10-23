/**
 * presence-mode — le mode de présence de l'humain (normal / absent / débordé) et son fuseau courant.
 *
 * Problème : un système d'agents qui écrit à son humain (rendez-vous, relances, demandes, résumés) doit
 * savoir quand se taire. En voyage, en rush, en vacances : « échéances et promotions gelées, un seul
 * résumé par jour, urgences seulement ». Sans état partagé, chaque organe code sa propre idée de
 * « il n'est pas là » (et son propre fuseau).
 *
 * UN état, sérialisable en JSON (le stockage est à toi), posé quand l'humain le DIT, lu par chaque
 * organe à travers `whatMayBeSent` (une seule table, ci-dessous). Le fuseau vit dans le même état mais
 * n'est PAS lié au mode : en déplacement lointain il peut vivre des mois en mode normal sur un autre fuseau.
 *
 * `until` : le jour de son RETOUR (`AAAA-MM-JJ`, à 0 h dans son fuseau) ou un instant ISO. Passé ce
 * moment, le mode effectif redevient `normal` tout seul (aucun organe n'a besoin de réécrire l'état).
 * Un état absent ou illisible vaut `normal` : le comportement d'avant, signalé par l'appelant.
 *
 * Tout est PUR ; la lecture/écriture de l'état est injectée (`parseModeState` reçoit le JSON déjà lu).
 */

export const MODES = ["normal", "absent", "deborde"] as const;
export type Mode = (typeof MODES)[number];

/** Le fuseau quand rien d'autre n'est posé. Mets celui de ton humain. */
export const DEFAULT_TZ = "UTC";

export interface ModeState {
  mode: Mode;
  /** ISO : quand ce mode a été posé */
  since?: string;
  /** le jour de son retour (`AAAA-MM-JJ`, 0 h dans son fuseau) ou un instant ISO ; absent = jusqu'à « normal » */
  until?: string | null;
  /** ses mots, en bref (« voyage », « rush au travail ») */
  reason?: string;
  /** fuseau IANA (« Asia/Tokyo ») ; absent = `DEFAULT_TZ`. Indépendant du mode. */
  tz?: string | null;
  /** ISO : la fin de la dernière période absent/débordé posée à la main ; l'horloge des échéances repart de là */
  returnedAt?: string | null;
}

// ── Fuseaux et horloge locale ──────────────────────────────────────────────────────────────────

const VALID_TZ = new Set<string>();
/** Un fuseau IANA que l'ICU connaît. */
export function validTz(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim()) return false;
  if (VALID_TZ.has(tz)) return true; // construire un formateur coûte ~1 ms ; un tick de scheduler vérifie souvent
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    VALID_TZ.add(tz);
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(ms: number, tz: string): Record<string, string> {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  return Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
}

/** Décalage (ms) de `tz` par rapport à UTC à l'instant `ms`, heure d'été comprise. */
export function tzOffsetMs(ms: number, tz: string): number {
  const p = parts(ms, tz);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** L'heure (0-23) d'un instant dans `tz`. */
export const hourIn = (ms: number, tz: string): number => Number(parts(ms, tz).hour) % 24;

/** Le jour de la semaine (0 = dimanche) d'un instant dans `tz`. */
export const weekdayIn = (ms: number, tz: string): number => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts(ms, tz).weekday);

/** La date `AAAA-MM-JJ` d'un instant dans `tz`. */
export function dayIn(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** L'instant de « AAAA-MM-JJ HH:MM » (heure murale) dans `tz`. Deux passes : le décalage visé peut différer de celui de minuit UTC. */
export function wallToEpoch(date: string, hh: number, mm: number, tz: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, mo - 1, d, hh, mm, 0);
  const guess = wall - tzOffsetMs(wall, tz);
  return wall - tzOffsetMs(guess, tz);
}

/** L'instant de minuit, dans `tz`, d'une date `AAAA-MM-JJ`. */
export const startOfDayIn = (day: string, tz: string): number => wallToEpoch(day, 0, 0, tz);

// ── Normalisation ──────────────────────────────────────────────────────────────────────────────

/** Un contenu brut (JSON lu) ramené à un état sûr : tout champ invalide est ignoré, un mode inconnu vaut `normal`. */
export function normalizeMode(raw: unknown): ModeState {
  if (!raw || typeof raw !== "object") return { mode: "normal" };
  const o = raw as Record<string, unknown>;
  const mode = (MODES as readonly string[]).includes(String(o.mode)) ? (o.mode as Mode) : "normal";
  const e: ModeState = { mode };
  if (typeof o.since === "string") e.since = o.since;
  if (typeof o.until === "string" && o.until.trim()) e.until = o.until.trim();
  if (typeof o.reason === "string" && o.reason.trim()) e.reason = o.reason.trim().slice(0, 200);
  if (validTz(o.tz)) e.tz = o.tz;
  if (typeof o.returnedAt === "string") e.returnedAt = o.returnedAt;
  return e;
}

/** Le texte JSON d'un état → un état sûr. Illisible = `normal` ET `unreadable: true` (fail-open assumé, mais jamais muet). */
export function parseModeState(text: string | null | undefined): ModeState & { unreadable?: boolean } {
  if (text === null || text === undefined || !String(text).trim()) return { mode: "normal" };
  try {
    return normalizeMode(JSON.parse(text));
  } catch {
    return { mode: "normal", unreadable: true };
  }
}

/** Le fuseau posé dans l'état s'il est valide, sinon `fallback`. */
export const currentTz = (e: Pick<ModeState, "tz"> | null | undefined, fallback: string = DEFAULT_TZ): string =>
  validTz(e?.tz) ? (e?.tz as string) : fallback;

// ── Le mode effectif ───────────────────────────────────────────────────────────────────────────

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** L'instant où le mode posé prend fin (son retour), ou null s'il n'a pas d'échéance (ou une illisible). Ne lève jamais. */
export function modeEndsAt(e: ModeState): number | null {
  if (!e.until) return null;
  // Une date impossible (« 2026-13-40 » éditée à la main) rend null, jamais une exception : chaque organe lit ce mode.
  if (DAY.test(e.until) && !Number.isFinite(Date.parse(`${e.until}T00:00:00Z`))) return null;
  const t = DAY.test(e.until) ? startOfDayIn(e.until, currentTz(e)) : Date.parse(e.until);
  return Number.isFinite(t) ? t : null;
}

/** Le mode qui vaut à cet instant : le mode posé, sauf si son `until` est passé (retour automatique à `normal`). */
export function effectiveMode(e: ModeState, ms: number): Mode {
  if (e.mode === "normal") return "normal";
  const end = modeEndsAt(e);
  return end !== null && ms >= end ? "normal" : e.mode;
}

/** Absent ou débordé à cet instant. */
export const suspended = (e: ModeState, ms: number): boolean => effectiveMode(e, ms) !== "normal";

/**
 * L'instant où l'horloge des échéances repart : la fin de la dernière absence (expirée d'elle-même, ou
 * levée par « normal »). Null s'il n'y a eu aucune absence connue, ou s'il est encore absent. Sert à ne pas
 * relancer, le jour du retour, tout ce qui a « dormi 48 h » pendant l'absence.
 */
export function clockRestartsAt(e: ModeState, ms: number): number | null {
  if (suspended(e, ms)) return null;
  if (e.mode !== "normal") return modeEndsAt(e); // expirée d'elle-même
  const r = e.returnedAt ? Date.parse(e.returnedAt) : NaN;
  return Number.isFinite(r) ? r : null;
}

/**
 * Ce que le système peut envoyer à l'humain, par genre. Une seule table, lue par tous les organes :
 *  - `urgent`       : une panne, un incident → part toujours ;
 *  - `summary`      : le rapport du matin, le seul résumé du jour → part toujours ;
 *  - `conversation` : la réponse à un message qu'IL vient d'envoyer → part ;
 *  - `appointment`  : un rappel de rendez-vous, un point hebdo → gelé ;
 *  - `promotion`    : ce qui promeut ou rétrograde un agent sur jugement → gelé ;
 *  - `deadline`     : une relance après N heures de son silence → gelée (et l'horloge repart à son retour) ;
 *  - `quick`        : une demande « rapide » (un pouce, un choix) → gelée, elle attend son retour ; une demande
 *                     urgente part comme un `urgent`.
 */
export const KINDS = ["urgent", "summary", "conversation", "appointment", "promotion", "deadline", "quick"] as const;
export type Kind = (typeof KINDS)[number];
const ALWAYS: ReadonlySet<Kind> = new Set(["urgent", "summary", "conversation"]);

const NAMES: Record<Mode, string> = { normal: "normal", absent: "absent", deborde: "débordé" };

/** « absent jusqu'au 2026-10-20 (voyage) », « normal », … */
export function describeMode(e: ModeState, ms: number): string {
  const m = effectiveMode(e, ms);
  if (m === "normal") return e.mode !== "normal" ? `normal (retour automatique : ${NAMES[e.mode]} jusqu'au ${e.until})` : "normal";
  return `${NAMES[m]}${e.until ? ` jusqu'au ${e.until}` : " (sans date de retour)"}${e.reason ? ` (${e.reason})` : ""}`;
}

/** Ce genre d'envoi part-il maintenant ? Avec le motif en clair (pour le journal de l'organe). */
export function whatMayBeSent(kind: Kind, e: ModeState, ms: number): { send: boolean; reason: string } {
  const m = effectiveMode(e, ms);
  if (m === "normal") return { send: true, reason: "mode normal" };
  if (ALWAYS.has(kind)) {
    const why = kind === "urgent" ? "une urgence part toujours" : kind === "summary" ? "le seul résumé du jour" : "réponse à son message";
    return { send: true, reason: `${describeMode(e, ms)} : ${why}` };
  }
  return { send: false, reason: `${describeMode(e, ms)} : ${kind} gelé` };
}

/**
 * La ligne du rapport du matin : une ligne en absent ou débordé ; une ligne de retour les 24 h qui suivent
 * une absence expirée d'elle-même (l'état garde `absent` : rien ne le réécrit, d'où la fenêtre) ; sinon « rien ».
 */
export function morningLine(e: ModeState, ms: number): string {
  if (effectiveMode(e, ms) !== "normal") return `Mode ${describeMode(e, ms)} : rendez-vous, promotions et relances gelés ; ce rapport et les urgences seulement.`;
  const end = e.mode !== "normal" ? modeEndsAt(e) : null;
  if (end !== null && ms - end < 24 * 3_600_000) return `${describeMode(e, ms)} : les rendez-vous reprennent.`;
  return "rien";
}

/**
 * Le nouvel état quand l'humain pose un mode. Le fuseau est gardé sauf s'il est fourni (`"auto"` ou null le
 * retire) ; `normal` depuis une absence note le retour. Lève sur une entrée invalide (jamais un état à moitié juste).
 */
export function setMode(
  before: ModeState,
  mode: Mode,
  o: { now: number; until?: string | null; reason?: string | null; tz?: string | null },
): ModeState {
  if (!(MODES as readonly string[]).includes(mode)) throw new Error(`mode inconnu : ${mode} (normal | absent | deborde)`);
  const tz = o.tz === undefined ? before.tz : o.tz && /^auto$/i.test(o.tz) ? null : o.tz;
  if (tz && !validTz(tz)) throw new Error(`fuseau inconnu de l'ICU : ${tz} (ex. Asia/Tokyo)`);
  const e: ModeState = { mode, since: new Date(o.now).toISOString() };
  if (tz) e.tz = tz;
  if (mode !== "normal") {
    if (o.until) {
      e.until = o.until;
      const end = modeEndsAt(e);
      if (end === null) throw new Error(`until illisible : ${o.until} (AAAA-MM-JJ, le jour du retour, ou un instant ISO)`);
      if (end <= o.now) throw new Error(`until déjà passé : ${o.until}`);
    }
    if (o.reason) e.reason = o.reason.trim().slice(0, 200);
    return e;
  }
  // Retour : depuis une absence encore en cours, le retour est maintenant ; sinon on garde celui d'avant.
  if (suspended(before, o.now)) e.returnedAt = e.since;
  else {
    const r = clockRestartsAt(before, o.now);
    if (r !== null) e.returnedAt = new Date(r).toISOString();
  }
  return e;
}

/** Le fuseau seul : le mode et ses dates ne bougent pas. `null` retire le fuseau posé. */
export function setTz(before: ModeState, tz: string | null): ModeState {
  if (tz && !validTz(tz)) throw new Error(`fuseau inconnu de l'ICU : ${tz} (ex. Asia/Tokyo)`);
  const e: ModeState = { ...before };
  if (tz) e.tz = tz;
  else delete e.tz;
  return e;
}
