/**
 * request-queue — la file d'envoi des demandes « rapides » à l'humain (un pouce, un choix, une approbation).
 *
 * Problème : un agent qui demande une approbation à chaque fois qu'il en a besoin finit par réveiller son
 * humain à 3 h du matin avec six demandes en trois heures, ou par le noyer en rafale. Le régime ci-dessous
 * est une politique d'envoi, pas une politique de décision : la demande est TOUJOURS enregistrée par ailleurs
 * (base, empreinte de l'acte, verrou) ; seul l'ENVOI du message passe par ici.
 *
 * LE RÉGIME
 *  - une demande urgente part tout de suite, à toute heure, en tout mode ; elle ne compte pas dans le paquet ;
 *  - sinon, la première demande part tout de suite ; celles qui suivent dans les 15 min attendent le créneau
 *    suivant (dernier envoi + 15 min) et partent ensemble, en UN message ;
 *  - en mode absent ou débordé (`presence-mode.ts`), tout attend le retour ;
 *  - optionnel : des heures calmes (`quiet-hours.ts`) retiennent tout jusqu'à leur fin ;
 *  - une demande fermée ou périmée entre-temps (annulée, déjà décidée) ne part pas.
 *
 * RÉPONDRE À UN MESSAGE GROUPÉ. Une réaction vise un message, pas une demande : sur un message qui en porte
 * plusieurs, un pouce ne peut pas dire laquelle. Choix : **une réaction sur un message groupé ne décide rien** ;
 * le message demande « ok N » pour chacune (« ok 12 13 » pour plusieurs, chaque numéro tapé). Pourquoi pas
 * « un pouce = toutes » : le verrou repose sur « une approbation = UN acte qu'il a lu » ; un pouce sur un paquet
 * ferait passer d'un geste plusieurs actes qu'il aurait lus en diagonale. Un message qui ne porte qu'UNE
 * demande garde le format simple, et son pouce.
 *
 * Tout ce qui décide est PUR ; `passFile` reçoit ses I/O en dépendances (le daemon branche sa base et son
 * canal de messagerie, les tests une simulation).
 */
import { whatMayBeSent, type ModeState } from "./presence-mode.ts";
import { inQuietHours, type QuietHours } from "./quiet-hours.ts";

/** La largeur d'un paquet : après un envoi, les demandes suivantes attendent ce délai et partent ensemble. */
export const BATCH_MS = 15 * 60_000;
/** Au-delà de ce silence du « cœur » du daemon, la file est réputée non portée : mieux vaut envoyer tout de suite
 *  (le comportement d'avant) que mettre en file une demande que personne n'enverrait. */
export const RUNNER_PULSE_MAX_MS = 5 * 60_000;

export interface QueueContext {
  now: number;
  modeState: ModeState;
  /** L'instant du dernier envoi NON urgent d'une demande (null : aucun connu). */
  lastSent: number | null;
  /** Heures calmes optionnelles (null/absent = pas de retenue la nuit). */
  quietHours?: QuietHours | null;
}

/** Quand finissent les heures calmes en cours (pas de 15 min, 48 h max) ; `now` si on n'y est pas. */
function quietEnd(q: QuietHours | null | undefined, now: number): number {
  if (!q || !inQuietHours(q, now)) return now;
  for (let i = 1; i <= 192; i++) {
    const t = now + i * 15 * 60_000;
    if (!inQuietHours(q, t)) return t;
  }
  return now;
}

/**
 * Le prochain instant où un paquet peut partir : `when` null s'il attend le retour (absent, débordé).
 * Le motif est en clair, pour la sortie de l'outil de demande et le journal du daemon. PUR.
 */
export function nextSlot(c: QueueContext): { when: number | null; reason: string } {
  const gate = whatMayBeSent("quick", c.modeState, c.now);
  if (!gate.send) return { when: null, reason: `${gate.reason} : elle attend ton retour` };
  let when = c.now;
  let reason = "créneau libre";
  const calm = quietEnd(c.quietHours, c.now);
  if (calm > when) {
    when = calm;
    reason = "heures calmes : elle attend leur fin";
  }
  if (c.lastSent !== null && c.lastSent + BATCH_MS > when) {
    when = c.lastSent + BATCH_MS;
    reason = "paquet de 15 min (une demande est partie il y a moins de 15 min)";
  }
  return { when, reason };
}

/**
 * Au moment de la demande : part-elle tout de suite, ou en file ? `active` = la file est branchée (coupure non
 * posée ET porteur du daemon vivant) ; coupée, tout part tout de suite, comme sans file. `queueNotEmpty` : un
 * paquet attend déjà, la nouvelle le rejoint (jamais doubler une demande plus ancienne). PUR.
 */
export function decideOnRequest(
  c: QueueContext & { urgent: boolean; active: boolean; queueNotEmpty: boolean },
): { now: boolean; reason: string; next: number | null } {
  if (!c.active) return { now: true, reason: "file coupée", next: null };
  if (c.urgent) return { now: true, reason: "urgente : part tout de suite", next: null };
  const s = nextSlot(c);
  if (s.when !== null && s.when <= c.now && !c.queueNotEmpty) return { now: true, reason: s.reason, next: null };
  return {
    now: false,
    reason: s.when !== null && s.when <= c.now ? "un paquet attend déjà : elle le rejoint" : s.reason,
    next: s.when,
  };
}

/** Le pouls du porteur est-il assez frais pour confier une demande à la file ? PUR. */
export function runnerAlive(seenMs: number | null, now: number): boolean {
  return seenMs !== null && Number.isFinite(seenMs) && now - seenMs >= -60_000 && now - seenMs <= RUNNER_PULSE_MAX_MS;
}

// ── Les textes ─────────────────────────────────────────────────────────────────────────────────

export type Severity = "reversible" | "destructive";

/** Le corps d'une demande (ce qui ne dépend pas de son numéro) : description, ligne de liaison, acte exact. */
export function requestBody(desc: string, boundLine: string | null, command: string | null): string {
  const parts = [desc];
  if (boundLine) parts.push("", boundLine);
  if (command) parts.push("```\n" + command + "\n```");
  return parts.join("\n");
}

/** Le message d'UNE demande. Une action destructive exige une réponse écrite, jamais une réaction. */
export function singleRequestText(id: number, kind: Severity, body: string): string {
  const header = kind === "destructive" ? `*Demande d'autorisation #${id}* — DESTRUCTIF` : `*Demande d'autorisation #${id}*`;
  const footer =
    kind === "destructive"
      ? `→ Action destructive : *réponds* « ok ${id} » pour confirmer (une réaction ne suffit pas).`
      : "→ Réagis pour décider (👍 = oui · 🙏 = non/plus tard).";
  return [header, "", body, "", footer].join("\n");
}

export interface QueuedRequest {
  id: number;
  kind: Severity;
  body: string;
}

/** Le message d'un paquet de plusieurs demandes : chacune numérotée, et la seule façon d'y répondre. */
export function groupedText(requests: readonly QueuedRequest[]): string {
  const ids = requests.map((d) => d.id);
  const lines = [`*${requests.length} demandes d'autorisation* (${ids.map((i) => `#${i}`).join(", ")})`];
  for (const d of requests) lines.push("", d.kind === "destructive" ? `*#${d.id}* — DESTRUCTIF` : `*#${d.id}*`, d.body);
  lines.push(
    "",
    "→ Ce message en regroupe plusieurs : une réaction ne peut pas viser une seule demande, elle ne décide rien. " +
      `*Réponds* « ok ${ids[0]} » pour chacune que tu valides (« ok ${ids.join(" ")} » pour toutes) ; ` +
      "pour refuser ou choisir une option, dis-le en clair (« non N », « N : B »).",
  );
  return lines.join("\n");
}

/** Le message à envoyer pour ces demandes (seule : format simple ; plusieurs : paquet). */
export function sendText(requests: readonly QueuedRequest[]): string {
  if (requests.length === 0) throw new Error("aucune demande à envoyer");
  return requests.length === 1 ? singleRequestText(requests[0].id, requests[0].kind, requests[0].body) : groupedText(requests);
}

/** « ok 12 », « ok #12 », « ok 12 13 », « ok 12, 13 » → les numéros (dans l'ordre, sans doublon) ; null sinon. */
export function okNumbers(text: string): number[] | null {
  const m = text.trim().match(/^ok((?:[\s,]+#?\d+)+)$/i);
  if (!m) return null;
  return [...new Set([...m[1].matchAll(/\d+/g)].map((x) => Number(x[0])))];
}

// ── Le passage du daemon ───────────────────────────────────────────────────────────────────────

/** Une ligne de la file, vue avec la demande qu'elle porte. */
export interface QueueRow {
  requestId: number;
  body: string;
  kind: string;
  /** `pending` pour une demande encore ouverte */
  status: string;
  createdAt: number;
  /** l'acte exact enregistré (et empreinté) ; le corps envoyé doit le montrer tel quel. */
  command: string | null;
}

/**
 * Le corps qui partira montre-t-il l'acte enregistré, au caractère près ? Une divergence = une base retouchée :
 * on n'envoie pas à l'humain, pour lecture, un texte qui ne serait pas l'acte que le verrou laissera passer. PUR.
 */
export function bodyShowsAct(l: Pick<QueueRow, "body" | "command">): boolean {
  return l.command === null || l.body.includes("```\n" + l.command + "\n```");
}

export interface PassDeps {
  now: number;
  modeState: ModeState;
  quietHours?: QuietHours | null;
  /** Les demandes en file, les plus anciennes d'abord. */
  queue: QueueRow[];
  lastSent: number | null;
  /** Au-delà de cet âge une demande est périmée : un pouce dessus ne vaudrait plus décision. */
  expiryMs: number;
  /** Retire de la file les demandes qui ne partiront plus. */
  drop: (ids: number[], reason: string) => void;
  /** Envoie le texte ; rend l'id du message (null s'il n'a pas été capturé). Peut lever. */
  send: (text: string) => Promise<string | null>;
  /** Note l'envoi : `grouped` = un message pour plusieurs demandes (aucune ne reçoit l'id comme cible d'une réaction). */
  markSent: (ids: number[], at: number, messageId: string | null, grouped: boolean) => void;
}

export interface PassReport {
  sent: number[];
  dropped: number[];
  /** Pourquoi rien n'est parti alors que la file n'est pas vide. */
  waiting: string | null;
  /** Envoyé, mais sans id de message : une demande partie seule ne pourra pas être visée par son pouce (il faudra « ok N »). */
  noId?: boolean;
}

/**
 * Un passage : écarte les demandes fermées ou périmées, puis, si le créneau est là, envoie le reste en UN
 * message. Une erreur d'envoi remonte (les demandes restent en file : le passage suivant réessaie).
 */
export async function passFile(d: PassDeps): Promise<PassReport> {
  const closed = d.queue.filter((l) => l.status !== "pending" || d.now - l.createdAt > d.expiryMs);
  const diverging = d.queue.filter((l) => !closed.includes(l) && !bodyShowsAct(l));
  if (closed.length) d.drop(closed.map((l) => l.requestId), "demande fermée ou périmée avant son envoi");
  if (diverging.length) d.drop(diverging.map((l) => l.requestId), "le texte en file ne montre plus l'acte enregistré : à redemander");
  const dropped = [...closed, ...diverging].map((l) => l.requestId);
  const alive = d.queue.filter((l) => !dropped.includes(l.requestId));
  if (!alive.length) return { sent: [], dropped, waiting: null };
  const s = nextSlot({ now: d.now, modeState: d.modeState, lastSent: d.lastSent, quietHours: d.quietHours });
  if (s.when === null || s.when > d.now) {
    const w = s.when === null ? s.reason : `${s.reason} : prochain envoi ${new Date(s.when).toISOString()}`;
    return { sent: [], dropped, waiting: w };
  }
  const requests: QueuedRequest[] = alive.map((l) => ({
    id: l.requestId,
    kind: l.kind === "destructive" ? "destructive" : "reversible",
    body: l.body,
  }));
  const messageId = await d.send(sendText(requests));
  const ids = requests.map((x) => x.id);
  d.markSent(ids, d.now, messageId, ids.length > 1);
  return { sent: ids, dropped, waiting: null, noId: messageId === null };
}
