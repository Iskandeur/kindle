#!/usr/bin/env node
/**
 * waha-gateway — ton compagnon sur WhatsApp, via WAHA (https://waha.devlike.pro).
 *
 *   node harness/bin/waha-gateway.ts            # écoute le webhook WAHA et répond
 *   node harness/bin/waha-gateway.ts --check    # vérifie la config et l'état de la session, puis sort
 *
 * Chaîne : WAHA ──POST webhook──▶ cette gateway ──runTurn──▶ moteur (dans le dépôt) ──texte──▶ WAHA sendText.
 *
 * Garde-fous (tous actifs par défaut) :
 *  · fermé par défaut : seuls les chats de `WAHA_ALLOWED_CHATS` réveillent l'agent ;
 *  · signature HMAC du webhook vérifiée si `WAHA_WEBHOOK_HMAC_KEY` est posé ;
 *  · écoute en loopback (`127.0.0.1`) sauf `WAHA_WEBHOOK_HOST` explicite ;
 *  · anti-rejeu (message ancien annoncé comme tel), dédup par stanza, rafales fusionnées par chat ;
 *  · coupe-circuit d'envoi et relecture du fil avant de déclarer un échec (`lib/waha.ts`).
 *
 * Config : `.env` à la racine (voir `.env.example`). Doc : `harness/docs/gateways-waha-telegram.md`.
 */
import { createServer, type IncomingMessage } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { GraceCoalescer, type CoalesceEvent } from "../src/lib/coalesce.ts";
import { annotateStaleWahaReplay } from "../src/lib/waha-stale-replay.ts";
import {
  isChatAllowed,
  normalizeWahaWebhook,
  parseAllowedChats,
  readWahaConfig,
  verifyWahaHmac,
  wahaSeen,
  wahaSendText,
  wahaSessionStatus,
  wahaTyping,
  type WahaMessage,
} from "../src/lib/waha.ts";
import {
  buildRelayPrompt,
  failureReply,
  formatLocalTime,
  isSilentReply,
  loadEngineOrExit,
  runRelayTurn,
  ShortHistory,
} from "../src/lib/gateway-core.ts";

const repo = join(import.meta.dirname, "..", "..");
const envFile = join(repo, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const waha = readWahaConfig();
if (!waha) {
  console.error("WAHA_BASE_URL n'est pas posé (voir .env.example).");
  process.exit(1);
}
const allowed = parseAllowedChats(process.env.WAHA_ALLOWED_CHATS);
const principals = parseAllowedChats(process.env.WAHA_PRINCIPAL_CHATS || process.env.WAHA_ALLOWED_CHATS);
const principalName = process.env.KINDLE_HUMAN_NAME?.trim() || "ton humain";
const tz = process.env.KINDLE_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const hmacKey = process.env.WAHA_WEBHOOK_HMAC_KEY?.trim();
const port = Number(process.env.WAHA_WEBHOOK_PORT || 8787);
const host = process.env.WAHA_WEBHOOK_HOST || "127.0.0.1";
const STALE_MS = 30 * 60_000;

if (process.argv.includes("--check")) {
  const status = await wahaSessionStatus(waha);
  console.log(`WAHA ${waha.baseUrl}, session « ${waha.session} » : ${status ?? "injoignable"}`);
  console.log(`Chats autorisés : ${allowed.size === 0 ? "AUCUN (la gateway ignorera tout)" : [...allowed].join(", ")}`);
  console.log(`Webhook attendu : http://${host}:${port}/waha ${hmacKey ? "(HMAC vérifié)" : "(sans HMAC)"}`);
  process.exit(status === "WORKING" ? 0 : 1);
}

const engine = loadEngineOrExit();
const history = new ShortHistory();
const seen = new Set<string>(); // dédup des stanzas déjà traitées (bornée ci-dessous)

interface Ev extends CoalesceEvent {
  chatId: string;
  msg: WahaMessage;
  warning?: string;
}

async function handle(raw: CoalesceEvent): Promise<void> {
  const ev = raw as Ev;
  const { msg } = ev;
  const isPrincipal = principals.has(msg.author) || principals.has(msg.chatId);
  void wahaSeen(waha!, ev.chatId);
  void wahaTyping(waha!, ev.chatId, true);
  const typingTimer = setInterval(() => void wahaTyping(waha!, ev.chatId, true), 20_000);
  try {
    const prompt = buildRelayPrompt({
      channel: "WhatsApp",
      localTime: formatLocalTime(new Date(), tz),
      sender: isPrincipal ? principalName : `${msg.pushName ?? "contact"} (${msg.author})`,
      isPrincipal,
      isGroup: msg.isGroup,
      warning: ev.warning,
      history: history.get(ev.chatId),
      text: ev.body,
      attachments: msg.media?.url ? [`${msg.media.mimetype ?? "fichier"} : ${msg.media.url}`] : undefined,
    });
    const res = await runRelayTurn(engine, repo, prompt);
    history.push(ev.chatId, { from: "humain", text: ev.body });
    if (!res.ok) {
      console.error(`[waha] tour en échec (${res.engine}/${res.model}) : ${res.error}`);
      if (isPrincipal) await wahaSendText(waha!, ev.chatId, failureReply(res));
      return;
    }
    if (isSilentReply(res.text)) return;
    await wahaSendText(waha!, ev.chatId, res.text.trim());
    history.push(ev.chatId, { from: "agent", text: res.text.trim() });
    console.log(`[waha] ${ev.chatId} ← ${res.text.length} car. (${res.engine}/${res.model}${res.costUsd != null ? `, $${res.costUsd.toFixed(4)}` : ""})`);
  } catch (e) {
    console.error(`[waha] ${ev.chatId} : ${(e as Error).message}`);
  } finally {
    clearInterval(typingTimer);
    void wahaTyping(waha!, ev.chatId, false);
  }
}

const coalescer = new GraceCoalescer({ graceMs: 2_500, waitSignalToken: "att", waitSignalMs: 30_000, handle });

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 5_000_000) {
        reject(new Error("corps trop gros"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200).end("ok");
    return;
  }
  if (req.method !== "POST" || !req.url?.startsWith("/waha")) {
    res.writeHead(404).end();
    return;
  }
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    res.writeHead(413).end();
    return;
  }
  if (hmacKey && !(await verifyWahaHmac(raw, req.headers["x-webhook-hmac"] as string | undefined, hmacKey))) {
    res.writeHead(401).end();
    return;
  }
  res.writeHead(200).end(); // on acquitte tout de suite : WAHA ne doit pas rejouer pendant le tour
  let ev: unknown;
  try {
    ev = JSON.parse(raw);
  } catch {
    return;
  }
  const msg = normalizeWahaWebhook(ev, { session: waha.session });
  if (!msg) return;
  if (!isChatAllowed(msg, allowed)) {
    console.log(`[waha] ignoré (hors liste) : ${msg.chatId}`);
    return;
  }
  if (msg.dedupKey) {
    if (seen.has(msg.dedupKey)) return;
    seen.add(msg.dedupKey);
    if (seen.size > 5_000) seen.delete(seen.values().next().value as string);
  }
  const annotated = annotateStaleWahaReplay({ source: "whatsapp", msgTs: msg.msgTs, ts: Date.now(), body: msg.body }, STALE_MS);
  const warning = annotated.body !== msg.body ? annotated.body.slice(0, annotated.body.length - msg.body.length).trim() : undefined;
  const event: Ev = { chatId: msg.chatId, body: msg.body, msg, ...(warning ? { warning } : {}), ...(msg.media ? { image: msg.media } : {}) };
  coalescer.enqueue(event);
});

server.listen(port, host, () => {
  console.log(`[waha] gateway prête sur http://${host}:${port}/waha, session « ${waha.session} », ${allowed.size} chat(s) autorisé(s)`);
  if (allowed.size === 0) console.warn("[waha] WAHA_ALLOWED_CHATS est vide : aucun message ne réveillera l'agent.");
});
