/**
 * Les entrées `protocol` de l'historique WAHA : ce que la liste des messages range À CÔTÉ des
 * messages sans que le destinataire lise quoi que ce soit en plus.
 *
 * POURQUOI CE FICHIER EXISTE. Un agent envoie un rapport, puis le MODIFIE 53 s plus tard. WAHA rend
 * alors DEUX entrées dans
 * `GET /chats/{id}/messages` :
 *   · l'original (`_data.type = "chat"`), dont le `body` est DÉJÀ le texte modifié, et qui porte
 *     `_data.latestEditMsgKey` ;
 *   · une entrée `_data.type = "protocol"`, `_data.subtype = "message_edit"`, avec son propre
 *     identifiant, le même corps au caractère près, et `_data.protocolMessageKey` qui pointe
 *     l'original.
 * Aucun champ de premier niveau (`id`, `timestamp`, `fromMe`, `body`) ne les distingue. Cinq jours
 * plus tard, un audit affichait « 🚨 RENVOYÉ — même corps, 53 s plus tard » alors que l'humain ne
 * voyait qu'une bulle, marquée « Modifié ». Même défaut, sans le cri, dans `voice-audit`, qui
 * comptait deux fois les tics d'un message modifié.
 *
 * Mesuré sur 14 jours de sortants dans un 1:1 : 460 entrées, UNE `message_edit`. Rare, donc
 * invisible dans une moyenne, et c'est ce qui la rend dangereuse dans un détecteur de doublons,
 * dont la seule raison d'être est l'évènement rare.
 *
 * Le champ `_data` n'est rendu que par l'API HTTP de WAHA (le MCP le retire par défaut) : un lecteur
 * qui passe par le MCP doit demander `_data: true`, sinon cette fonction rend toujours `null`.
 */

export interface ProtocolEntry {
  /** `message_edit`, `revoke`, … — `"?"` si WAHA ne le dit pas. */
  subtype: string;
  /** Identifiant sérialisé du message visé (`true_…@lid_3EB0…`), quand WAHA le fournit. */
  targetId?: string;
}

/** `null` pour un vrai message ; la nature de l'entrée sinon. PUR, tolérant aux formes. */
export function readProtocolEntry(m: unknown): ProtocolEntry | null {
  const data = (m as { _data?: Record<string, unknown> } | null | undefined)?._data;
  if (!data || data.type !== "protocol") return null;
  const subtype = typeof data.subtype === "string" && data.subtype ? data.subtype : "?";
  const key = data.protocolMessageKey as Record<string, unknown> | null | undefined;
  const raw = key?.$1 ?? key?._serialized ?? key?.id;
  return typeof raw === "string" && raw ? { subtype, targetId: raw } : { subtype };
}
