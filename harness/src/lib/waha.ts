/**
 * WAHA (WhatsApp HTTP API) — le canal WhatsApp de ton compagnon, sans dépendance.
 *
 * Deux moitiés :
 *  · PUR (testable) : `normalizeWahaWebhook` transforme un évènement webhook brut en message
 *    exploitable (ou `null` : écho de soi, entrée `protocol`, évènement non-message), et
 *    `isChatAllowed` décide si ce chat a le droit de réveiller l'agent ;
 *  · I/O (fins wrappers `fetch`) : envoyer un texte, l'indicateur « écrit… », marquer lu, l'état
 *    de la session, relire ses propres messages récents.
 *
 * Les garde-fous qui ont coûté cher en production sont DANS l'envoi, pas à côté :
 *  · coupe-circuit global anti-flood (`allowSend`) : au-delà de N envois sur une fenêtre glissante
 *    on REFUSE et on lève, sans jamais envoyer d'alerte (ce serait nourrir la boucle) ;
 *  · un 5xx ou un délai dépassé est une issue INCERTAINE : on relit le fil avant de déclarer l'échec
 *    (`send-probe.ts`), sinon le relanceur double le message déjà livré ;
 *  · un 4xx prouve que rien n'est parti : on lève sans sonder.
 *
 * WAHA : https://waha.devlike.pro (image `devlikeapro/waha`). Les chemins visés ici (`/api/sendText`,
 * `/api/startTyping`, `/api/sendSeen`, `/api/sessions/{s}`, `/api/{s}/chats/{id}/messages`) sont
 * ceux de WAHA 2024-2026 ; adapte-les si ta version diffère. Doc : `harness/docs/gateways-waha-telegram.md`.
 */
import { pickRecentOwnMessage, sendWithProbe, type SendResult } from "./send-probe.ts";
import { readProtocolEntry } from "./waha-protocol.ts";

export interface WahaConfig {
  /** `http://localhost:3000` (sans `/` final). */
  baseUrl: string;
  /** Clé `X-Api-Key` (variable `WHATSAPP_API_KEY` côté conteneur WAHA). Vide = pas d'en-tête. */
  apiKey?: string;
  /** Nom de la session WAHA du numéro de l'agent (défaut `default`). */
  session: string;
  /** Coupe-circuit : au plus `circuitMax` envois sur `circuitWindowMs` (défaut 20 / 60 s). */
  circuitMax?: number;
  circuitWindowMs?: number;
  /** Délai d'un envoi avant de le déclarer incertain (défaut 90 s). */
  sendTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

/** Lit la config WAHA dans l'environnement. `null` si `WAHA_BASE_URL` n'est pas posé. */
export function readWahaConfig(env: Record<string, string | undefined> = process.env): WahaConfig | null {
  const base = (env.WAHA_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!base) return null;
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    baseUrl: base,
    apiKey: env.WAHA_API_KEY?.trim() || undefined,
    session: env.WAHA_SESSION?.trim() || "default",
    circuitMax: num(env.WAHA_SEND_CIRCUIT_MAX, 20),
    circuitWindowMs: num(env.WAHA_SEND_CIRCUIT_WINDOW_MS, 60_000),
  };
}

// ——— PUR ———————————————————————————————————————————————————————————————————————————————

/** Message WhatsApp normalisé (le sous-ensemble qu'on sait traiter). */
export interface WahaMessage {
  /** Id WAHA du message (relatif à la session : sert à rappeler WAHA, pas à dédupliquer). */
  id?: string;
  /** La conversation : `<num>@c.us`, `<id>@lid` (1:1) ou `<id>@g.us` (groupe). */
  chatId: string;
  isGroup: boolean;
  /** L'auteur réel : le chat en 1:1, le `participant` en groupe. */
  author: string;
  /** Nom affiché par WhatsApp (`notifyName`/`pushName`), non fiable : jamais une preuve d'identité. */
  pushName?: string;
  body: string;
  /** Horodatage RÉEL du message (ms), pour l'anti-rejeu (`waha-stale-replay.ts`). */
  msgTs?: number;
  /** Présent si le message porte un média (vocal, image, fichier). */
  media?: { url?: string; mimetype?: string; filename?: string };
  /** Id de la clé « stanza », globale au message : la bonne clé de dédup entre deux sessions. */
  dedupKey?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Id WAHA d'un message : string, `{ _serialized }` ou `{ id }` selon la version / le moteur. PUR. */
export function wahaMessageId(p: any): string | undefined {
  return str(p?.id?._serialized) ?? str(p?.id) ?? str(p?._data?.id?._serialized) ?? str(p?.messageId);
}

/** La partie « stanza » d'un id `<fromMe>_<remoteJid>_<stanza>[_<participant>]`, ou l'id entier. PUR. */
export function stanzaOf(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const m = /^(?:true|false)_[^_]+_([^_]+)/.exec(id);
  return m ? m[1] : id;
}

/**
 * Normalise un évènement webhook WAHA (`{ event, session, payload }`). PUR → testable.
 *
 * Rend `null` pour tout ce qui ne doit PAS réveiller l'agent :
 *  · un évènement qui n'est pas `message` (ni `message.any`) ;
 *  · un message `fromMe` : c'est l'écho de ce que l'agent vient d'envoyer, y répondre = boucle ;
 *  · une entrée `protocol` (modification, suppression) : la bulle existe déjà ;
 *  · un message sans texte ni média ;
 *  · un évènement d'une autre session que `session` quand elle est donnée.
 */
export function normalizeWahaWebhook(ev: any, opts: { session?: string } = {}): WahaMessage | null {
  const event = ev?.event;
  if (event !== "message" && event !== "message.any") return null;
  if (opts.session && typeof ev?.session === "string" && ev.session !== opts.session) return null;
  const p = ev?.payload;
  if (!p || p.fromMe === true) return null;
  if (readProtocolEntry(p)) return null;
  const chatId = str(p.from) ?? str(p.chatId);
  if (!chatId) return null;
  if (chatId === "status@broadcast") return null; // les « statuts » ne sont pas des conversations
  const isGroup = chatId.endsWith("@g.us");
  const author = isGroup ? (str(p.participant) ?? str(p.author?._serialized) ?? str(p.author) ?? chatId) : chatId;
  const body = typeof p.body === "string" ? p.body : "";
  const media = p.hasMedia === true || p.media
    ? { url: str(p.media?.url), mimetype: str(p.media?.mimetype), filename: str(p.media?.filename) }
    : undefined;
  if (!body.trim() && !media) return null;
  const tsSec = typeof p.timestamp === "number" && Number.isFinite(p.timestamp) && p.timestamp > 0 ? p.timestamp : undefined;
  const id = wahaMessageId(p);
  return {
    ...(id ? { id, dedupKey: stanzaOf(id) } : {}),
    chatId,
    isGroup,
    author,
    ...(str(p._data?.notifyName) ?? str(p.notifyName) ?? str(p.pushName) ? { pushName: str(p._data?.notifyName) ?? str(p.notifyName) ?? str(p.pushName) } : {}),
    body,
    ...(tsSec ? { msgTs: tsSec * 1000 } : {}),
    ...(media ? { media } : {}),
  };
}

/** Liste d'autorisation (`WAHA_ALLOWED_CHATS="33600000000@c.us,1203…@g.us"`) → ensemble. PUR. */
export function parseAllowedChats(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Ce message a-t-il le droit de réveiller l'agent ? PUR.
 * Fermé par défaut : une liste VIDE n'autorise RIEN (un numéro WhatsApp public reçoit du spam et des
 * inconnus ; un agent qui répond à tout le monde répète des choses sur toi). Un chat de la liste
 * passe ; en 1:1, un numéro `@c.us` de la liste couvre aussi son alias `@lid` si `lidAliases` le relie.
 */
export function isChatAllowed(msg: WahaMessage, allowed: ReadonlySet<string>, lidAliases: ReadonlyMap<string, string> = new Map()): boolean {
  if (allowed.has(msg.chatId)) return true;
  const alias = lidAliases.get(msg.chatId);
  return alias !== undefined && allowed.has(alias);
}

/** Vérifie l'en-tête `X-Webhook-Hmac` (HMAC-SHA512 du corps brut, hex) quand WAHA est configuré
 *  avec une clé HMAC. Comparaison en temps constant. */
export async function verifyWahaHmac(rawBody: string, header: string | undefined, key: string): Promise<boolean> {
  if (!header) return false;
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const want = createHmac("sha512", key).update(rawBody).digest();
  let got: Buffer;
  try {
    got = Buffer.from(header.trim(), "hex");
  } catch {
    return false;
  }
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Fenêtre glissante du coupe-circuit. MUTE `log` : purge le périmé, puis pousse `now` SEULEMENT si
 *  l'envoi est permis. Un refus ne consomme pas de quota : la rafale cessée, les envois reprennent. PUR. */
export function allowSend(log: number[], now: number, windowMs: number, max: number): boolean {
  while (log.length > 0 && now - log[0] > windowMs) log.shift();
  if (log.length >= max) return false;
  log.push(now);
  return true;
}

// ——— I/O ———————————————————————————————————————————————————————————————————————————————

/** État module-global du coupe-circuit : UN plafond pour tout le process. */
const sendLog: number[] = [];

function headers(cfg: WahaConfig): Record<string, string> {
  return { "Content-Type": "application/json", ...(cfg.apiKey ? { "X-Api-Key": cfg.apiKey } : {}) };
}

/** Les derniers messages d'un chat (forme brute WAHA). */
export async function wahaRecentMessages(cfg: WahaConfig, chatId: string, limit = 20): Promise<unknown[]> {
  const f = cfg.fetchFn ?? fetch;
  const url = `${cfg.baseUrl}/api/${encodeURIComponent(cfg.session)}/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}&downloadMedia=false`;
  const res = await f(url, { headers: headers(cfg), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`WAHA messages ${res.status}`);
  const j = await res.json();
  return Array.isArray(j) ? j : [];
}

/**
 * Envoie un texte. Rend l'id du message (ou null si WAHA ne le donne pas). LÈVE si le coupe-circuit
 * refuse, sur un 4xx, ou sur un 5xx/délai quand la relecture du fil ne trouve pas le message.
 */
export async function wahaSendText(cfg: WahaConfig, chatId: string, text: string): Promise<string | null> {
  const max = cfg.circuitMax ?? 20;
  const windowMs = cfg.circuitWindowMs ?? 60_000;
  if (!allowSend(sendLog, Date.now(), windowMs, max)) {
    throw new Error(`coupe-circuit WhatsApp : plus de ${max} envois en ${Math.round(windowMs / 1000)} s, envoi refusé (chat ${chatId})`);
  }
  const f = cfg.fetchFn ?? fetch;
  const timeoutMs = cfg.sendTimeoutMs ?? 90_000;
  const send = async (): Promise<SendResult> => {
    try {
      const res = await f(`${cfg.baseUrl}/api/sendText`, {
        method: "POST",
        headers: headers(cfg),
        body: JSON.stringify({ session: cfg.session, chatId, text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { ok: false, status: res.status, errorText: await res.text().catch(() => "") };
      const j: any = await res.json().catch(() => null);
      const id = str(j?.id?._serialized) ?? str(j?._data?.id?._serialized) ?? str(j?.id);
      return { ok: true, status: res.status, ...(id ? { id } : {}) };
    } catch (e) {
      // Délai dépassé : issue incertaine, traitée comme un 5xx (on sonde). Le reste remonte.
      if ((e as { name?: string })?.name === "TimeoutError") return { ok: false, status: 504, errorText: "délai dépassé" };
      throw e;
    }
  };
  const probe = async () => pickRecentOwnMessage(await wahaRecentMessages(cfg, chatId), text, Date.now(), 5 * 60_000);
  return sendWithProbe({ send, probe });
}

/** « écrit… » (on/off). Best-effort : ne lève jamais. */
export async function wahaTyping(cfg: WahaConfig, chatId: string, on: boolean): Promise<void> {
  try {
    await (cfg.fetchFn ?? fetch)(`${cfg.baseUrl}/api/${on ? "startTyping" : "stopTyping"}`, {
      method: "POST",
      headers: headers(cfg),
      body: JSON.stringify({ session: cfg.session, chatId }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* best-effort */
  }
}

/** Coches bleues sur le chat. Best-effort : ne lève jamais. */
export async function wahaSeen(cfg: WahaConfig, chatId: string): Promise<void> {
  try {
    await (cfg.fetchFn ?? fetch)(`${cfg.baseUrl}/api/sendSeen`, {
      method: "POST",
      headers: headers(cfg),
      body: JSON.stringify({ session: cfg.session, chatId }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* best-effort */
  }
}

/** Statut de la session (`WORKING`, `SCAN_QR_CODE`, `FAILED`, `STOPPED`…) ou `null` si WAHA est muet. */
export async function wahaSessionStatus(cfg: WahaConfig): Promise<string | null> {
  try {
    const res = await (cfg.fetchFn ?? fetch)(`${cfg.baseUrl}/api/sessions/${encodeURIComponent(cfg.session)}`, {
      headers: headers(cfg),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const j: any = await res.json().catch(() => null);
    return str(j?.status) ?? null;
  } catch {
    return null;
  }
}
