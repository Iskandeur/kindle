/**
 * waha — WhatsApp via WAHA (https://waha.devlike.pro), le connecteur auto-hébergé : lire le webhook entrant, vérifier
 * sa signature HMAC, répondre par son API REST. Zéro dépendance, `fetchFn` injectable pour les tests.
 *
 * Côté WAHA : une session (`default` par défaut) avec un webhook vers `http://<ton-hôte>:<port>/waha` sur l'évènement
 * `message`, et de préférence une clé HMAC (WHATSAPP_HOOK_HMAC_KEY ou `hmac.key` du webhook de la session) : sans elle,
 * n'importe qui qui atteint le port peut parler à ton compagnon en ton nom.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { InboundMessage } from "./gateway-core.ts";

/** Le JSON d'un webhook WAHA → un message entrant normalisé, ou null (pas un message, le tien, un statut, vide). PUR. */
export function parseWahaWebhook(body: unknown): InboundMessage | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { event?: unknown; session?: unknown; payload?: Record<string, unknown> };
  if (b.event !== "message" || !b.payload || typeof b.payload !== "object") return null;
  const p = b.payload;
  if (p.fromMe === true) return null;
  const from = typeof p.from === "string" ? p.from : "";
  if (!from || from === "status@broadcast" || from.endsWith("@newsletter")) return null;
  const text = typeof p.body === "string" ? p.body.trim() : "";
  const hasMedia = p.hasMedia === true;
  if (!text && !hasMedia) return null;
  const isGroup = from.endsWith("@g.us");
  const participant = typeof p.participant === "string" && p.participant ? p.participant : null;
  const data = (p._data ?? {}) as { notifyName?: unknown };
  const ts = typeof p.timestamp === "number" ? p.timestamp : Number(p.timestamp);
  return {
    channel: "whatsapp",
    id: typeof p.id === "string" ? p.id : String((p.id as { _serialized?: string } | undefined)?._serialized ?? ""),
    chatId: from,
    senderId: isGroup ? (participant ?? from) : from,
    senderName: typeof data.notifyName === "string" ? data.notifyName : null,
    text: text || "[média sans légende]",
    isGroup,
    msgTs: Number.isFinite(ts) && ts > 0 ? (ts < 1e12 ? ts * 1000 : ts) : undefined,
  };
}

/**
 * La signature WAHA (`X-Webhook-Hmac`, HMAC-SHA512 hexadécimal du corps brut). Pas de clé configurée = rien à vérifier
 * (true) ; clé configurée et signature absente ou fausse = false. Comparaison en temps constant. PUR.
 */
export function verifyWahaHmac(rawBody: string | Buffer, signature: string | undefined, key: string | undefined): boolean {
  if (!key) return true;
  if (!signature) return false;
  const want = createHmac("sha512", key).update(rawBody).digest();
  let got: Buffer;
  try {
    got = Buffer.from(signature.trim(), "hex");
  } catch {
    return false;
  }
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface WahaClientOptions {
  baseUrl: string;
  apiKey?: string;
  session?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export interface WahaClient {
  sendText(chatId: string, text: string): Promise<void>;
  sendSeen(chatId: string): Promise<void>;
  typing(chatId: string, on: boolean): Promise<void>;
}

/** Le client REST de WAHA. `sendText` lève sur un non-2xx (le gateway le journalise) ; `sendSeen`/`typing` ne lèvent jamais. */
export function wahaClient(o: WahaClientOptions): WahaClient {
  const base = o.baseUrl.replace(/\/+$/, "");
  const session = o.session || "default";
  const f = o.fetchFn ?? fetch;
  const post = async (path: string, body: Record<string, unknown>): Promise<Response> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (o.apiKey) headers["X-Api-Key"] = o.apiKey;
    return f(`${base}${path}`, { method: "POST", headers, body: JSON.stringify({ session, ...body }), signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
  };
  const quiet = async (path: string, body: Record<string, unknown>): Promise<void> => {
    try {
      await post(path, body);
    } catch {}
  };
  return {
    async sendText(chatId, text) {
      const r = await post("/api/sendText", { chatId, text });
      if (!r.ok) throw new Error(`WAHA sendText : HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
    },
    sendSeen: (chatId) => quiet("/api/sendSeen", { chatId }),
    typing: (chatId, on) => quiet(on ? "/api/startTyping" : "/api/stopTyping", { chatId }),
  };
}
