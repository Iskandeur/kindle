/**
 * telegram — un bot Telegram (Bot API, https://core.telegram.org/bots/api) comme second canal : long polling
 * `getUpdates` (aucun port à ouvrir, aucun certificat), réponse par `sendMessage`. Zéro dépendance, `fetchFn` injectable.
 *
 * Créer le bot : écrire à @BotFather, `/newbot`, copier le jeton dans TELEGRAM_BOT_TOKEN (dans `.env`, jamais commité).
 */
import type { InboundMessage } from "./gateway-core.ts";

/** Limite de Telegram pour un message texte. */
export const TELEGRAM_MAX = 4096;

/** Un objet `Update` → un message entrant normalisé, ou null (édition, bot, service, vide). PUR. */
export function parseTelegramUpdate(u: unknown): InboundMessage | null {
  if (!u || typeof u !== "object") return null;
  const m = (u as { message?: Record<string, unknown> }).message;
  if (!m || typeof m !== "object") return null;
  const chat = m.chat as { id?: unknown; type?: unknown } | undefined;
  const from = m.from as { id?: unknown; is_bot?: unknown; first_name?: unknown; username?: unknown } | undefined;
  if (!chat || chat.id === undefined || from?.is_bot === true) return null;
  const text = (typeof m.text === "string" ? m.text : typeof m.caption === "string" ? m.caption : "").trim();
  const media = ["photo", "document", "voice", "audio", "video", "sticker"].some((k) => k in m);
  if (!text && !media) return null;
  const date = typeof m.date === "number" ? m.date * 1000 : undefined;
  return {
    channel: "telegram",
    id: String(m.message_id ?? ""),
    chatId: String(chat.id),
    senderId: String(from?.id ?? chat.id),
    senderName: typeof from?.first_name === "string" ? from.first_name : typeof from?.username === "string" ? from.username : null,
    text: text || "[média sans légende]",
    isGroup: chat.type === "group" || chat.type === "supergroup",
    msgTs: date,
  };
}

/** Coupe un texte long en morceaux ≤ max, de préférence sur un saut de ligne, sinon sur un espace. PUR. */
export function splitMessage(text: string, max = TELEGRAM_MAX): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

export interface TelegramClientOptions {
  token: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface TelegramClient {
  /** Les mises à jour après `offset` (long polling, `timeoutSec` côté serveur). Lève sur une erreur d'API. */
  getUpdates(offset: number, timeoutSec?: number, signal?: AbortSignal): Promise<Array<{ update_id: number } & Record<string, unknown>>>;
  sendMessage(chatId: string, text: string): Promise<void>;
  typing(chatId: string): Promise<void>;
}

export function telegramClient(o: TelegramClientOptions): TelegramClient {
  const base = `${(o.baseUrl ?? "https://api.telegram.org").replace(/\/+$/, "")}/bot${o.token}`;
  const f = o.fetchFn ?? fetch;
  const call = async (method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    const r = await f(`${base}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
    // Le jeton est dans l'URL : il ne doit jamais remonter dans un message d'erreur.
    if (!r.ok || !j.ok) throw new Error(`Telegram ${method} : HTTP ${r.status} ${String(j.description ?? "").slice(0, 200)}`);
    return j.result;
  };
  return {
    async getUpdates(offset, timeoutSec = 50, signal) {
      const res = await call("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message"] }, signal ?? AbortSignal.timeout((timeoutSec + 15) * 1000));
      return Array.isArray(res) ? (res as Array<{ update_id: number } & Record<string, unknown>>) : [];
    },
    async sendMessage(chatId, text) {
      for (const part of splitMessage(text)) await call("sendMessage", { chat_id: chatId, text: part }, AbortSignal.timeout(30_000));
    },
    async typing(chatId) {
      try {
        await call("sendChatAction", { chat_id: chatId, action: "typing" }, AbortSignal.timeout(10_000));
      } catch {}
    },
  };
}
