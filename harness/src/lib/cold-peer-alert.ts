/**
 * Un 1:1 que L'AGENT a ouvert ne doit pas être jeté EN SILENCE par un filtre « principal seulement ».
 *
 * Contexte : un agent qui parle depuis un numéro/compte dédié peut avoir un garde qui ne laisse passer
 * en 1:1 que son humain (cf. `wa-guard`). Le garde est juste ; son REFUS MUET ne l'est pas : quand
 * l'agent a lui-même écrit à un tiers (premier contact autorisé), la réponse de ce tiers est jetée sans
 * un mot, et l'humain croit que le fil est vivant alors que personne ne lit.
 *
 * Ici : la DÉCISION seulement (pure, I/O injectés). Le message reste jeté (pas de réveil, discrétion
 * entière) ; on prévient l'humain, une fois par chat et par 24 h, si l'agent a écrit dans ce chat dans
 * les 30 derniers jours. Lecture en échec → on alerte quand même (fail-open sur l'ALERTE : une alerte
 * de trop coûte une ligne, un fil mort coûte une relation). Un inconnu qui écrit à froid (aucun
 * message sortant) → silence, comportement d'avant.
 */

export const COLD_PEER_WINDOW_MS = 30 * 24 * 3600_000;
export const COLD_PEER_DEDUP_MS = 24 * 3600_000;

export type ColdPeerDecision =
  | { action: "alert"; reason: "fil-ouvert" | "lecture-en-echec" }
  | { action: "silence"; reason: "jamais-ecrit" | "deja-alerte" };

export interface ColdPeerDeps {
  /** Horodatage (ms) du dernier message SORTANT de l'agent dans ce chat, `null` si aucun. Peut lever. */
  lastOutgoingTs: (chatId: string) => Promise<number | null>;
  /** Réclame le créneau d'alerte du chat : true (et horodate) si pas d'alerte dans `COLD_PEER_DEDUP_MS`. */
  claim: (chatId: string, cooldownMs: number, now: number) => boolean;
  now: number;
}

export async function decideColdPeerAlert(chatId: string, deps: ColdPeerDeps): Promise<ColdPeerDecision> {
  let reason: "fil-ouvert" | "lecture-en-echec";
  try {
    const ts = await deps.lastOutgoingTs(chatId);
    if (ts === null || !(deps.now - ts <= COLD_PEER_WINDOW_MS)) return { action: "silence", reason: "jamais-ecrit" };
    reason = "fil-ouvert";
  } catch {
    reason = "lecture-en-echec";
  }
  // Le créneau se réclame EN DERNIER : un inconnu à froid ne consomme pas de dédoublonnage.
  if (!deps.claim(chatId, COLD_PEER_DEDUP_MS, deps.now)) return { action: "silence", reason: "deja-alerte" };
  return { action: "alert", reason };
}

export function coldPeerAlertText(opts: {
  who: string;
  chatId: string;
  atMs: number;
  body: string;
  reason: "fil-ouvert" | "lecture-en-echec";
  /** Fuseau IANA de l'humain pour l'heure affichée (défaut UTC). */
  timeZone?: string;
}): string {
  const hhmm = new Date(opts.atMs).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: opts.timeZone ?? "UTC",
  });
  const body = opts.body.replace(/\s+/g, " ").trim();
  const extrait = body.length > 120 ? body.slice(0, 119) + "…" : body;
  const ident = opts.who && opts.who !== opts.chatId ? `${opts.who} (${opts.chatId})` : opts.chatId;
  const ouvert =
    opts.reason === "fil-ouvert"
      ? "J'ai écrit dans ce fil ces 30 derniers jours."
      : "Je n'ai pas pu vérifier si j'ai ouvert ce fil (lecture de l'historique en échec).";
  return (
    `📭 Message non traité de ${ident} à ${hhmm} : « ${extrait} »\n` +
    `${ouvert} Le filtre « principal seulement » l'a jeté, je ne l'ai pas lu. ` +
    `Si tu autorises ce contact, il suffit de l'inscrire dans la liste des correspondants directs ; ` +
    `sinon dis-moi quoi faire.`
  );
}
