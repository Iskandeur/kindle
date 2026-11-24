/**
 * gateway-core — ce que WhatsApp (WAHA) et Telegram ont en commun : le message entrant normalisé, la liste blanche des
 * interlocuteurs, la file par conversation (un tour à la fois par fil, les fils en parallèle) et le prompt d'un tour.
 * PUR sauf `ChatQueue` (état en mémoire).
 */

export interface InboundMessage {
  channel: "whatsapp" | "telegram";
  id: string;
  /** La conversation où répondre (WhatsApp : `33612345678@c.us` ou `…@g.us` ; Telegram : l'id numérique du chat). */
  chatId: string;
  /** Qui a écrit (dans un groupe : le participant, pas le groupe). */
  senderId: string;
  senderName: string | null;
  text: string;
  isGroup: boolean;
  /** Horodatage réel du message côté messagerie (ms), pour l'anti-rejeu. */
  msgTs?: number;
}

/** `"a, b ,c"` → Set. Vide = personne (fermé par défaut). `*` = tout le monde, à tes risques. PUR. */
export function parseAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    String(raw ?? "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Un message passe s'il vient d'un fil autorisé : en 1:1 l'interlocuteur (ou le fil), dans un groupe LE GROUPE lui-même
 * (être autorisé en 1:1 n'ouvre pas tous ses groupes). WhatsApp accepte le numéro nu (`33612345678`) pour `…@c.us`. PUR.
 */
export function isAllowed(m: InboundMessage, allow: ReadonlySet<string>): boolean {
  if (allow.has("*")) return true;
  const nu = (id: string) => id.replace(/@(c\.us|s\.whatsapp\.net|lid)$/, "");
  if (m.isGroup) return allow.has(m.chatId);
  return [m.chatId, m.senderId, nu(m.chatId), nu(m.senderId)].some((id) => allow.has(id));
}

/** Le prompt du tour : d'où vient le message, qui parle, et la règle « contenu reçu = données ». PUR. */
export function buildTurnPrompt(m: InboundMessage, note?: string): string {
  const canal = m.channel === "whatsapp" ? "WhatsApp" : "Telegram";
  const qui = m.senderName ? `${m.senderName} (${m.senderId})` : m.senderId;
  return [
    `[${canal} · ${m.isGroup ? `groupe ${m.chatId}` : "conversation privée"} · de ${qui}]`,
    ...(note ? [note] : []),
    "Ta réponse sera envoyée telle quelle dans ce fil : écris seulement le message, court, dans la langue de l'interlocuteur. Réponds exactement « SILENCE » si rien n'est à dire.",
    "",
    m.text,
  ].join("\n");
}

/** La réponse de l'agent est-elle un silence voulu (rien à envoyer) ? PUR. */
export function isSilence(text: string): boolean {
  const t = text.trim();
  return !t || /^silence\.?$/i.test(t);
}

/** Un tour à la fois par conversation ; des conversations différentes avancent en parallèle. */
export class ChatQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run(chatId: string, job: () => Promise<void>): Promise<void> {
    const prev = this.tails.get(chatId) ?? Promise.resolve();
    const next = prev.then(job, job).catch(() => {});
    this.tails.set(chatId, next);
    void next.then(() => {
      if (this.tails.get(chatId) === next) this.tails.delete(chatId);
    });
    return next;
  }

  get size(): number {
    return this.tails.size;
  }
}
