#!/usr/bin/env node
/**
 * telegram-gateway — ton compagnon sur Telegram, par un bot (long polling, aucun port ouvert).
 *
 *   node harness/bin/telegram-gateway.ts           # écoute et répond
 *   node harness/bin/telegram-gateway.ts --check   # vérifie le token et l'humain scellé, puis sort
 *
 * Canal direct, ou canal de SECOURS quand WhatsApp tombe (numéro restreint, session déliée) : deux
 * process séparés, l'un ne tombe pas avec l'autre.
 *
 * Garde-fous :
 *  · DM privés seulement, jamais un bot, jamais un groupe ;
 *  · le PREMIER message du @username attendu (`TELEGRAM_PRINCIPAL_USERNAME`) scelle son id numérique
 *    (immuable) dans `harness/data/telegram.json` ; ensuite seul cet id passe, un pseudo usurpé non ;
 *  · offset persisté : un redémarrage ne rejoue ni ne perd de message ;
 *  · 🛑 (ou /stop) vide la file en attente ;
 *  · une rafale de textes reçue pendant un tour part en UN seul tour ensuite.
 *
 * Config : `.env` à la racine (voir `.env.example`). Doc : `harness/docs/gateways-waha-telegram.md`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  authorizeTelegramSender,
  isTgStopSignal,
  normalizeTelegramUpdate,
  planTgBatch,
  safeDocName,
  stopAckText,
  tgDownloadFile,
  tgGetFilePath,
  tgGetMe,
  tgGetUpdates,
  tgSend,
  tgTyping,
  TG_DOC_MAX_BYTES,
  TG_TYPING_REFRESH_MS,
  type NormalizedTgMessage,
} from "../src/telegram.ts";
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

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const principalUsername = (process.env.TELEGRAM_PRINCIPAL_USERNAME ?? "").trim().replace(/^@/, "");
if (!token || !principalUsername) {
  console.error("TELEGRAM_BOT_TOKEN et TELEGRAM_PRINCIPAL_USERNAME sont requis (voir .env.example).");
  process.exit(1);
}
const principalName = process.env.KINDLE_HUMAN_NAME?.trim() || "ton humain";
const tz = process.env.KINDLE_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const dataDir = join(repo, "harness", "data");
const stateFile = join(dataDir, "telegram.json");
const mediaDir = join(dataDir, "media");

interface State {
  offset: number;
  sealedId: number | null;
}
function loadState(): State {
  try {
    const s = JSON.parse(readFileSync(stateFile, "utf8"));
    return { offset: Number(s.offset) || 0, sealedId: typeof s.sealedId === "number" ? s.sealedId : null };
  } catch {
    return { offset: 0, sealedId: null };
  }
}
function saveState(s: State): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify(s, null, 2));
}

const me = await tgGetMe(token);
const state = loadState();
if (process.argv.includes("--check")) {
  console.log(`Bot @${me.username ?? "?"} (id ${me.id}) joignable.`);
  console.log(state.sealedId === null ? `Humain pas encore scellé : envoie un premier message depuis @${principalUsername}.` : `Humain scellé : id ${state.sealedId}.`);
  process.exit(0);
}

const engine = loadEngineOrExit();
const history = new ShortHistory();
let pending: NormalizedTgMessage[] = [];
let busy = false;

/** Télécharge le média d'un message (image, document, vocal) et rend son chemin local, ou null. */
async function fetchAttachment(m: NormalizedTgMessage): Promise<string | null> {
  const ref = m.image ?? m.document ?? m.voice;
  if (!ref) return null;
  if (m.document && m.document.sizeBytes > TG_DOC_MAX_BYTES) return null;
  try {
    const path = await tgGetFilePath(token!, ref.fileId);
    const bytes = await tgDownloadFile(token!, path);
    const ext = path.includes(".") ? path.slice(path.lastIndexOf(".")) : ".bin";
    const name = m.document ? safeDocName(m.document.fileName, ref.fileId) : `tg-${ref.fileId.slice(-8).replace(/[^a-zA-Z0-9]/g, "")}${ext}`;
    mkdirSync(mediaDir, { recursive: true });
    const local = join(mediaDir, name);
    writeFileSync(local, bytes);
    return local;
  } catch (e) {
    console.error(`[tg] téléchargement échoué : ${(e as Error).message}`);
    return null;
  }
}

async function handle(m: NormalizedTgMessage): Promise<void> {
  void tgTyping(token!, m.chatId);
  const typing = setInterval(() => void tgTyping(token!, m.chatId), TG_TYPING_REFRESH_MS);
  try {
    const att = await fetchAttachment(m);
    const attachments = att ? [`${m.voice ? "vocal (à transcrire si tu as un outil pour ça)" : m.image ? "image" : "fichier"} : ${att}`] : undefined;
    const prompt = buildRelayPrompt({
      channel: "Telegram",
      localTime: formatLocalTime(new Date(), tz),
      sender: principalName,
      isPrincipal: true,
      history: history.get(String(m.chatId)),
      text: m.text,
      attachments,
    });
    const res = await runRelayTurn(engine, repo, prompt);
    history.push(String(m.chatId), { from: "humain", text: m.text });
    if (!res.ok) {
      console.error(`[tg] tour en échec (${res.engine}/${res.model}) : ${res.error}`);
      await tgSend(token!, m.chatId, failureReply(res));
      return;
    }
    if (isSilentReply(res.text)) return;
    await tgSend(token!, m.chatId, res.text.trim());
    history.push(String(m.chatId), { from: "agent", text: res.text.trim() });
  } catch (e) {
    console.error(`[tg] ${(e as Error).message}`);
  } finally {
    clearInterval(typing);
  }
}

async function pump(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    while (pending.length > 0) {
      const batch = planTgBatch(pending, (x) => !x.voice && !x.image && !x.document && !x.text.trim().startsWith("/"));
      pending = [];
      for (const m of batch) await handle(m);
    }
  } finally {
    busy = false;
  }
}

console.log(`[tg] gateway prête : bot @${me.username ?? "?"}, humain ${state.sealedId === null ? `@${principalUsername} (à sceller)` : `id ${state.sealedId}`}`);

for (;;) {
  let updates: any[];
  try {
    updates = await tgGetUpdates(token, state.offset, 50);
  } catch (e) {
    console.error(`[tg] getUpdates : ${(e as Error).message}`);
    await new Promise((r) => setTimeout(r, 5_000));
    continue;
  }
  for (const u of updates) {
    state.offset = Math.max(state.offset, (u?.update_id ?? 0) + 1);
    const m = normalizeTelegramUpdate(u);
    if (!m) continue;
    const auth = authorizeTelegramSender(m, { sealedId: state.sealedId, principalUsername });
    if (!auth.allowed) {
      console.log(`[tg] refusé : ${auth.reason}`);
      continue;
    }
    if (auth.sealId !== undefined) {
      state.sealedId = auth.sealId;
      console.log(`[tg] humain scellé : id ${auth.sealId}`);
    }
    if (isTgStopSignal(m.text)) {
      const dropped = pending.length;
      pending = [];
      // Un tour déjà lancé finit (le moteur ne s'interrompt pas) : on ne vide que la file.
      await tgSend(token, m.chatId, stopAckText(false, dropped)).catch(() => {});
      continue;
    }
    pending.push(m);
  }
  if (updates.length > 0) saveState(state);
  void pump();
}
