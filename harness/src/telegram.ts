/**
 * Gateway Telegram — canal direct, ou canal de repli quand WhatsApp/WAHA est indisponible
 * (ex. numéro restreint pour « envoi automatisé / suspicion spam »).
 *
 * Ce module ne contient QUE de la logique pure (normalisation d'update, whitelist, prompt,
 * découpage) + de fins wrappers HTTP autour de l'API Bot Telegram. La boucle vit dans
 * bin/telegram-gateway.ts (process autonome, séparé du daemon WhatsApp).
 *
 * Modèle « relais » : contrairement au flux WhatsApp où l'agent répond depuis sa session via son
 * MCP, ici le tour n'a pas d'outil Telegram : le poller récupère le TEXTE rendu par
 * le moteur (`runTurn`, claude, OpenCode ou API OpenAI) et l'envoie lui-même (`tgSend`). Le prompt (buildTelegramPrompt) le dit à l'agent.
 */

/** Message Telegram normalisé (le sous-ensemble qu'on sait traiter). */
export interface NormalizedTgMessage {
  updateId: number;
  chatId: number;
  /** "private" | "group" | "supergroup" | "channel" | … — on n'accepte QUE "private" (DM). */
  chatType: string;
  fromId: number;
  fromUsername?: string;
  fromFirstName?: string;
  text: string;
  isBot: boolean;
  /** Présent si le message est un vocal/audio à transcrire (le poller le fait hors session). */
  voice?: TgVoiceRef;
  /** Présent si le message porte une image (photo ou document image) — le poller la télécharge
   *  et injecte son chemin pour que l'agent la « voie » avec Read (parité WhatsApp). */
  image?: TgImageRef;
  /** Présent si le message porte un FICHIER non-image (json, pdf, csv, md, zip…) — le poller le
   *  télécharge et injecte son chemin pour que l'agent le lise. Les images passent par `image`. */
  document?: TgDocRef;
}

/** Réf. d'un média vocal Telegram à transcrire (voice note ou fichier audio joint). */
export interface TgVoiceRef {
  fileId: string;
  mimetype: string;
  durationSec: number;
  kind: "voice" | "audio";
}

/** Réf. d'une image Telegram (photo compressée ou document image) à télécharger. */
export interface TgImageRef {
  fileId: string;
  mimetype: string;
}

/** Extrait une réf. image d'un message brut : `photo` (on prend la plus grande taille = dernière du
 *  tableau) d'abord, sinon un `document` de mimetype image/*. PUR. */
function extractImageRef(m: any): TgImageRef | undefined {
  const photo = m?.photo;
  if (Array.isArray(photo) && photo.length > 0) {
    const largest = photo[photo.length - 1]; // Telegram trie du plus petit au plus grand
    if (largest && typeof largest.file_id === "string") return { fileId: largest.file_id, mimetype: "image/jpeg" };
  }
  const doc = m?.document;
  if (doc && typeof doc.file_id === "string" && typeof doc.mime_type === "string" && doc.mime_type.startsWith("image/")) {
    return { fileId: doc.file_id, mimetype: doc.mime_type };
  }
  return undefined;
}

/** Réf. d'un fichier Telegram non-image à télécharger (json, pdf, csv, zip…). */
export interface TgDocRef {
  fileId: string;
  mimetype: string;
  /** Nom d'origine tel qu'envoyé (peut être vide) — sert à nommer le fichier local lisiblement. */
  fileName: string;
  sizeBytes: number;
}

/** Plafond de téléchargement : l'API Bot ne sert pas les fichiers > 20 Mo, autant le dire tout de
 *  suite plutôt que d'échouer au download. */
export const TG_DOC_MAX_BYTES = 20 * 1024 * 1024;

/** Extrait une réf. de FICHIER non-image d'un message brut. Les documents `image/*` sont laissés à
 *  `extractImageRef` (l'agent les « voit » au lieu de les lire). PUR. */
export function extractDocRef(m: any): TgDocRef | undefined {
  const doc = m?.document;
  if (!doc || typeof doc.file_id !== "string") return undefined;
  const mime = typeof doc.mime_type === "string" ? doc.mime_type : "application/octet-stream";
  if (mime.startsWith("image/")) return undefined; // déjà géré comme image
  return {
    fileId: doc.file_id,
    mimetype: mime,
    fileName: typeof doc.file_name === "string" ? doc.file_name : "",
    sizeBytes: typeof doc.file_size === "number" ? doc.file_size : 0,
  };
}

/** Nom de fichier sûr pour le stockage local : on garde le nom d'origine (lisible pour l'agent) mais
 *  on neutralise tout ce qui pourrait sortir du dossier `media/` (séparateurs, `..`). PUR. */
export function safeDocName(fileName: string, fileId: string): string {
  const base = (fileName || "").split(/[/\\]/).pop() ?? "";
  const clean = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 80);
  const suffix = fileId.slice(-8).replace(/[^a-zA-Z0-9]/g, "");
  return clean.length > 0 ? `tg-${suffix}-${clean}` : `tg-${suffix}.bin`;
}

/** Extrait une réf. vocale d'un message brut (voice note d'abord, puis fichier audio). PUR. */
function extractVoiceRef(m: any): TgVoiceRef | undefined {
  const v = m?.voice;
  if (v && typeof v.file_id === "string") {
    return {
      fileId: v.file_id,
      mimetype: typeof v.mime_type === "string" ? v.mime_type : "audio/ogg",
      durationSec: typeof v.duration === "number" ? v.duration : 0,
      kind: "voice",
    };
  }
  const a = m?.audio;
  if (a && typeof a.file_id === "string") {
    return {
      fileId: a.file_id,
      mimetype: typeof a.mime_type === "string" ? a.mime_type : "audio/mpeg",
      durationSec: typeof a.duration === "number" ? a.duration : 0,
      kind: "audio",
    };
  }
  return undefined;
}

/**
 * Normalise une update brute Telegram en message exploitable (ou null si rien à traiter :
 * edited_message, callback_query, channel_post, message sans texte NI vocal…). PUR → testable.
 * Gère le TEXTE et les VOCAUX (voice note / audio) ; le poller transcrira le vocal hors session.
 * Le reste (photos, docs, stickers…) est ignoré proprement.
 */
export function normalizeTelegramUpdate(u: any): NormalizedTgMessage | null {
  const updateId = u?.update_id;
  if (typeof updateId !== "number") return null;
  // Réaction 🛑 posée par lui sur un message du fil → un message « 🛑 » (signal stop, parité WhatsApp).
  // Toute autre réaction est ignorée : elle ne réveille rien. L'auteur passe par la même whitelist.
  const r = u?.message_reaction;
  if (r) {
    const stop = Array.isArray(r.new_reaction) && r.new_reaction.some((x: any) => x?.type === "emoji" && x?.emoji === TG_STOP_EMOJI);
    if (!stop || typeof r.chat?.id !== "number" || typeof r.user?.id !== "number") return null;
    return {
      updateId,
      chatId: r.chat.id,
      chatType: typeof r.chat.type === "string" ? r.chat.type : "unknown",
      fromId: r.user.id,
      fromUsername: typeof r.user.username === "string" ? r.user.username : undefined,
      fromFirstName: typeof r.user.first_name === "string" ? r.user.first_name : undefined,
      text: TG_STOP_EMOJI,
      isBot: r.user.is_bot === true,
    };
  }
  const m = u?.message; // uniquement les nouveaux messages (pas edited/channel_post)
  if (!m) return null;
  const from = m.from ?? {};
  const chat = m.chat ?? {};
  // Une image/document porte sa légende dans `caption` (pas `text`) → on la prend comme texte.
  // On teste le texte NON VIDE d'abord : un `text: ""` présent mais vide ne doit pas masquer la
  // légende (Telegram omet `text` sur un média, mais autant ne pas dépendre de cette omission).
  const rawText = typeof m.text === "string" ? m.text : "";
  const caption = typeof m.caption === "string" ? m.caption : "";
  const text = rawText.trim() ? rawText : caption;
  const voice = extractVoiceRef(m);
  const image = extractImageRef(m);
  const document = extractDocRef(m);
  if (typeof chat.id !== "number" || typeof from.id !== "number") return null;
  if (!text.trim() && !voice && !image && !document) return null; // rien à réveiller
  return {
    updateId,
    chatId: chat.id,
    chatType: typeof chat.type === "string" ? chat.type : "unknown",
    fromId: from.id,
    fromUsername: typeof from.username === "string" ? from.username : undefined,
    fromFirstName: typeof from.first_name === "string" ? from.first_name : undefined,
    text,
    isBot: from.is_bot === true,
    ...(voice ? { voice } : {}),
    ...(image ? { image } : {}),
    ...(document ? { document } : {}),
  };
}

/** Signal stop (même emoji que sur WhatsApp). */
export const TG_STOP_EMOJI = "🛑";

/**
 * Le message est-il un signal STOP ? PUR. `🛑` seul, ou `/stop` (avec ou sans `@bot`). Sur WhatsApp
 * c'est une réaction 🛑 ; sur Telegram la réaction arrive si l'API la livre, et le texte marche
 * toujours. Effet (gateway) : tue le réveil en cours, jette ce qui attendait derrière.
 */
export function isTgStopSignal(text: string): boolean {
  const t = text.trim();
  return t === TG_STOP_EMOJI || /^\/stop(@\w+)?$/i.test(t);
}

/** Accusé d'un 🛑 : dit ce qui a été arrêté, en une ligne. PUR. */
export function stopAckText(wasRunning: boolean, dropped: number): string {
  const parts: string[] = [];
  if (wasRunning) parts.push("réveil en cours arrêté");
  if (dropped > 0) parts.push(`${dropped} message${dropped > 1 ? "s" : ""} en attente jeté${dropped > 1 ? "s" : ""}`);
  return parts.length ? `🛑 ${parts.join(", ")}.` : "🛑 Rien ne tournait.";
}

/** Rafraîchissement de la bulle « écrit… » : Telegram l'éteint au bout de ~5 s. */
export const TG_TYPING_REFRESH_MS = 4_500;

/**
 * Découpe un lot en réveils : les suites de messages `coalescable` (texte simple) fusionnent en UN
 * message (textes joints par un saut de ligne, métadonnées du dernier) ; le reste passe seul. PUR.
 */
export function planTgBatch(
  msgs: NormalizedTgMessage[],
  coalescable: (m: NormalizedTgMessage) => boolean,
): NormalizedTgMessage[] {
  const out: NormalizedTgMessage[] = [];
  let i = 0;
  while (i < msgs.length) {
    if (!coalescable(msgs[i])) {
      out.push(msgs[i++]);
      continue;
    }
    let j = i;
    const texts: string[] = [];
    while (j < msgs.length && coalescable(msgs[j])) texts.push(msgs[j++].text);
    out.push({ ...msgs[j - 1], text: texts.join("\n") });
    i = j;
  }
  return out;
}

export interface AuthContext {
  /** Id numérique de ton humain déjà scellé (persisté en DB), ou null si pas encore vu. */
  sealedId: number | null;
  /** @username attendu (sans @) tant que l'id n'est pas scellé. (TELEGRAM_PRINCIPAL_USERNAME). */
  principalUsername: string;
}

export type AuthDecision =
  | { allowed: true; sealId?: number }
  | { allowed: false; reason: string };

/**
 * Autorise (ou non) un message entrant. « N'accepte QUE les DM de ton humain ». PUR → testable.
 *
 *  - Refuse tout bot et tout ce qui n'est PAS un DM privé (jamais de groupe/canal).
 *  - Id déjà scellé  → n'autorise QUE cet id (l'id numérique est immuable ; on ignore le username,
 *    qu'un tiers pourrait usurper après un changement de pseudo).
 *  - Pas encore scellé → autorise le 1er user dont le @username == principalUsername (insensible à
 *    la casse) et renvoie `sealId` pour graver l'id. Tout le reste est refusé (silencieux côté bot).
 */
export function authorizeTelegramSender(msg: NormalizedTgMessage, ctx: AuthContext): AuthDecision {
  if (msg.isBot) return { allowed: false, reason: "expéditeur = bot" };
  if (msg.chatType !== "private") return { allowed: false, reason: `non-DM (${msg.chatType})` };
  if (ctx.sealedId !== null) {
    return msg.fromId === ctx.sealedId
      ? { allowed: true }
      : { allowed: false, reason: `id ${msg.fromId} ≠ id scellé ${ctx.sealedId}` };
  }
  const u = msg.fromUsername?.toLowerCase();
  if (u && u === ctx.principalUsername.toLowerCase()) return { allowed: true, sealId: msg.fromId };
  return { allowed: false, reason: `non scellé et @${msg.fromUsername ?? "?"} ≠ @${ctx.principalUsername}` };
}


/** Contexte du prompt de réveil Telegram. */
export interface TelegramPromptContext {
  /** Prénom ou pseudo de ton humain, pour que l'agent sache à qui il parle. */
  principalName?: string;
  /** Ligne d'état facultative (ex. « WhatsApp HS depuis 2 h ») ajoutée telle quelle. */
  status?: string;
}

/**
 * Construit le prompt de réveil pour un message reçu par la gateway. PUR → testable.
 * Point crucial : on dit à l'agent que sa RÉPONSE TEXTE sera relayée telle quelle (modèle relais),
 * donc qu'il ne doit pas chercher un outil d'envoi. `localTime` = heure formatée (conscience du temps).
 */
export function buildTelegramPrompt(text: string, localTime: string, ctx: TelegramPromptContext = {}): string {
  const who = ctx.principalName ? ctx.principalName : "ton humain";
  return [
    `[🕒 ${localTime}]`,
    `[${who} t'écrit via la gateway Telegram]`,
    ...(ctx.status ? [ctx.status] : []),
    "",
    text,
    "",
    "⚠️ Réponds en texte simple : le texte que tu renvoies est relayé TEL QUEL sur Telegram.",
    "N'utilise aucun outil d'envoi pour lui répondre, écris juste ta réponse.",
    "Mise en forme : la gateway convertit *gras* façon WhatsApp ou markdown léger (**gras**, # titres,",
    "listes, [liens](url), `code`) en mise en forme Telegram. Reste concis, c'est du chat.",
    "Capitalise ce que tu apprends de durable, comme d'habitude (protocoles/ouroboros.md).",
  ].join("\n");
}

/** Découpe un texte pour respecter la limite Telegram (4096 car.). Coupe de préférence sur un saut
 *  de ligne, sinon dur. PUR → testable. `max` par défaut 4000 (marge). Renvoie au moins 1 morceau. */
export function chunkText(text: string, max = 4000): string[] {
  const t = text ?? "";
  if (t.length <= max) return [t.length === 0 ? "" : t];
  const chunks: string[] = [];
  let rest = t;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max; // pas de saut de ligne « raisonnable » → coupe dure
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

// ——— fins wrappers HTTP (impurs) autour de l'API Bot Telegram ———

const API = (token: string) => `https://api.telegram.org/bot${token}`;

/** Vérifie le token et renvoie l'identité du bot. Lève si le token est invalide/révoqué. */
export async function tgGetMe(token: string): Promise<{ id: number; username?: string }> {
  const res = await fetch(`${API(token)}/getMe`);
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j?.ok) throw new Error(`getMe échec (${res.status}) : ${JSON.stringify(j).slice(0, 200)}`);
  return { id: j.result.id, username: j.result.username };
}

/** Long-polling : renvoie les updates ≥ offset (le serveur tient la connexion jusqu'à `timeoutSec`).
 *  On restreint aux `message` (pas d'edited/callback) pour ne réveiller l'agent que sur du neuf. */
export async function tgGetUpdates(token: string, offset: number, timeoutSec = 50): Promise<any[]> {
  const res = await fetch(`${API(token)}/getUpdates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // `message_reaction` : seule la 🛑 en sort (cf. normalizeTelegramUpdate), le reste est ignoré.
    body: JSON.stringify({ timeout: timeoutSec, offset: offset || undefined, allowed_updates: ["message", "message_reaction"] }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j?.ok) throw new Error(`getUpdates échec (${res.status}) : ${JSON.stringify(j).slice(0, 200)}`);
  return Array.isArray(j.result) ? j.result : [];
}

/** Résout le `file_path` d'un `file_id` (Bot API getFile). Lève si échec. */
export async function tgGetFilePath(token: string, fileId: string): Promise<string> {
  const res = await fetch(`${API(token)}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j?.ok || typeof j.result?.file_path !== "string")
    throw new Error(`getFile échec (${res.status}) : ${JSON.stringify(j).slice(0, 200)}`);
  return j.result.file_path;
}

/** Télécharge le binaire d'un fichier Telegram (≤ 20 Mo via Bot API) → octets bruts. Lève si échec. */
export async function tgDownloadFile(token: string, filePath: string): Promise<Uint8Array> {
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!res.ok) throw new Error(`download fichier Telegram ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Convertit ce que l'agent écrit naturellement — balisage « façon WhatsApp » ET markdown GitHub (son
 * réflexe de modèle, malgré les consignes) — en HTML Telegram sûr :
 *   **gras** ou *gras* → <b> · ***x*** → <b><i> · __x__ ou _x_ → <i> · ~~x~~ ou ~x~ → <s> ·
 *   `code` → <code> · ```bloc``` → <pre> · [texte](url) → <a> · # Titre → <b> · puces - et * → •.
 * PUR → testable. Étapes : (1) échappe &<> ; (2) met de côté code, liens et URLs nues (pour ne
 * jamais y injecter de balise — ex. les `_` d'un TELEGRAM_BOT_TOKEN ou d'une URL restent intacts) ;
 * (3) puces ; (4) marqueurs DOUBLES (markdown) avant les simples (WhatsApp) — sinon `**x**`
 * devient « <b>*x*</b> » ; (5) titres en gras ; (6) restaure les spans. Les marqueurs non appariés
 * restent littéraux (pas de casse). On vise le mode HTML car il est bien plus tolérant que le mode
 * Markdown de Telegram (qui casse au moindre caractère spécial non échappé).
 */
export function toTelegramHtml(input: string): string {
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const stash: string[] = [];
  const keep = (html: string): string => {
    stash.push(html);
    return `\u0000${stash.length - 1}\u0000`;
  };
  let t = esc(input);
  // Blocs code (on jette l'éventuel identifiant de langage de la 1re ligne : ```ts → <pre> nu).
  t = t.replace(/```[a-zA-Z0-9+#-]*\n?([\s\S]+?)```/g, (_m, c) => keep(`<pre>${c}</pre>`));
  t = t.replace(/`([^`\n]+)`/g, (_m, c) => keep(`<code>${c}</code>`));
  // Liens markdown PUIS URLs nues, stashés AVANT les marqueurs : une URL contient souvent des `_`
  // (ou `~`, `*`) qui deviendraient de l'italique/du gras et casseraient le lien.
  t = t.replace(/\[([^\]\n]+)\]\((https?:[^\s()]+)\)/g, (_m, label, url) => keep(`<a href="${url}">${label}</a>`));
  t = t.replace(/https?:\/\/[^\s<>]+/g, (m) => keep(m));
  // Puces markdown en tête de ligne → « • » (l'astérisque-puce n'est pas un marqueur de gras).
  t = t.replace(/^(\s*)[-*]\s+/gm, "$1• ");
  // Marqueurs DOUBLES (réflexe GitHub) d'abord — adjacents à du non-espace, comme WhatsApp.
  t = t.replace(/\*\*\*(\S(?:[^*\n]*\S)?)\*\*\*/g, "<b><i>$1</i></b>");
  t = t.replace(/\*\*(\S(?:[^*\n]*\S)?)\*\*/g, "<b>$1</b>");
  t = t.replace(/__(\S(?:[^_\n]*\S)?)__/g, "<i>$1</i>");
  t = t.replace(/~~(\S(?:[^~\n]*\S)?)~~/g, "<s>$1</s>");
  // Marqueurs simples (façon WhatsApp).
  t = t.replace(/\*(\S(?:[^*\n]*\S)?)\*/g, "<b>$1</b>");
  t = t.replace(/_(\S(?:[^_\n]*\S)?)_/g, "<i>$1</i>");
  t = t.replace(/~(\S(?:[^~\n]*\S)?)~/g, "<s>$1</s>");
  // Titres markdown → ligne en gras (après les marqueurs : on retire tout <b> imbriqué — Telegram
  // refuse le gras dans le gras, et un 400 nous renverrait au texte brut).
  t = t.replace(/^#{1,6}\s+(.*)$/gm, (_m, h: string) => `<b>${h.replace(/<\/?b>/g, "")}</b>`);
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i) => stash[Number(i)] ?? "");
  return t;
}

/** POST sendMessage (un seul essai). Renvoie true si OK, false sinon — NE LÈVE PAS. `parseMode`
 *  optionnel (HTML) ; sans lui, texte brut. */
async function tgSendOnce(token: string, chatId: number, text: string, parseMode?: "HTML"): Promise<boolean> {
  const body: Record<string, unknown> = { chat_id: chatId, text, disable_web_page_preview: true };
  if (parseMode) body.parse_mode = parseMode;
  const res = await fetch(`${API(token)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    console.error(`[tg] sendMessage ${res.status} (${parseMode ?? "brut"}) : ${(await res.text()).slice(0, 160)}`);
  return res.ok;
}

/** Envoie un texte FORMATÉ pour Telegram (HTML), découpé si > limite. FILET DE SÉCURITÉ : si le
 *  parse HTML échoue (400), on renvoie le morceau en texte BRUT — un souci de formatage ne doit
 *  JAMAIS avaler un message sur notre canal critique. Ne lève que si même l'envoi brut échoue. */
export async function tgSend(token: string, chatId: number, text: string): Promise<void> {
  for (const chunk of chunkText(text, 3500)) {
    if (chunk.length === 0) continue;
    if (await tgSendOnce(token, chatId, toTelegramHtml(chunk), "HTML")) continue;
    if (!(await tgSendOnce(token, chatId, chunk))) throw new Error("sendMessage échec (HTML + fallback brut)");
  }
}

/**
 * Envoie un DOCUMENT (PDF, image, …) à Telegram via l'API Bot `sendDocument` en multipart.
 * Node ≥22 : `FormData`/`Blob`/`fetch` natifs. Remplace le multipart-à-la-main qu'on refaisait
 * pour pousser un PDF quand WhatsApp est HS.
 * La `caption` optionnelle suit le même balisage que le reste (WhatsApp → HTML Telegram) ; si le
 * parse HTML est rejeté (400), on retente SANS parse_mode plutôt que de perdre l'envoi (même filet
 * que `tgSend`). Renvoie le `message_id`. LÈVE si l'envoi échoue (cohérent avec les wrappers stricts
 * tgGetFilePath/tgDownloadFile). `filename` = nom affiché côté Telegram. */
export async function tgSendDocument(
  token: string,
  chatId: number,
  document: Uint8Array,
  filename: string,
  opts: { caption?: string; mimetype?: string } = {},
): Promise<number> {
  return tgSendMultipart(token, "sendDocument", "document", chatId, document, filename, opts);
}

/** Envoie une IMAGE affichée en ligne (`sendPhoto`, recompressée par Telegram), même filet de légende
 *  que `tgSendDocument`. Plafond Telegram : 10 Mo — au-delà, passer par `tgSendDocument`. */
export async function tgSendPhoto(
  token: string,
  chatId: number,
  photo: Uint8Array,
  filename: string,
  opts: { caption?: string; mimetype?: string } = {},
): Promise<number> {
  return tgSendMultipart(token, "sendPhoto", "photo", chatId, photo, filename, opts);
}

/** Plafond `sendPhoto` de l'API Bot. */
export const TG_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Choisit comment pousser un fichier local : photo en ligne (jpg/png/webp ≤ 10 Mo) ou document
 *  (tout le reste, gif compris : `sendPhoto` le figerait). PUR. */
export function tgMediaPlan(filename: string, sizeBytes: number): { method: "photo" | "document"; mimetype: string } {
  const m = /\.[a-z0-9]+$/i.exec(filename);
  const ext = m ? m[0].toLowerCase() : "";
  const mimetype = MIME_BY_EXT[ext] ?? "application/octet-stream";
  const inline = ext === ".jpg" || ext === ".jpeg" || ext === ".png" || ext === ".webp";
  return { method: inline && sizeBytes <= TG_PHOTO_MAX_BYTES ? "photo" : "document", mimetype };
}

async function tgSendMultipart(
  token: string,
  method: "sendDocument" | "sendPhoto",
  field: "document" | "photo",
  chatId: number,
  bytes: Uint8Array,
  filename: string,
  opts: { caption?: string; mimetype?: string },
): Promise<number> {
  const build = (htmlCaption: boolean): FormData => {
    const fd = new FormData();
    fd.set("chat_id", String(chatId));
    fd.set(field, new Blob([bytes], { type: opts.mimetype ?? "application/octet-stream" }), filename);
    if (opts.caption) {
      fd.set("caption", htmlCaption ? toTelegramHtml(opts.caption) : opts.caption);
      if (htmlCaption) fd.set("parse_mode", "HTML");
    }
    return fd;
  };
  const post = (fd: FormData): Promise<Response> => fetch(`${API(token)}/${method}`, { method: "POST", body: fd });
  let res = await post(build(true));
  if (!res.ok && opts.caption) {
    // légende HTML rejetée → on retente en brut plutôt que d'avaler le document sur un canal critique
    console.error(`[tg] ${method} HTML ${res.status} : ${(await res.text()).slice(0, 160)} — retry brut`);
    res = await post(build(false));
  }
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j?.ok || typeof j.result?.message_id !== "number")
    throw new Error(`${method} échec (${res.status}) : ${JSON.stringify(j).slice(0, 200)}`);
  return j.result.message_id;
}

/** Indicateur « en train d'écrire… » (best-effort ; on ignore les erreurs). */
export async function tgTyping(token: string, chatId: number): Promise<void> {
  try {
    await fetch(`${API(token)}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });
  } catch {
    /* best-effort */
  }
}
