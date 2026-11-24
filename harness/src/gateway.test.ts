import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { startGateway } from "./gateway.ts";
import { buildTurnPrompt, ChatQueue, isAllowed, isSilence, parseAllowlist, type InboundMessage } from "./lib/gateway-core.ts";
import { parseTelegramUpdate, splitMessage, telegramClient } from "./lib/telegram.ts";
import { parseWahaWebhook, verifyWahaHmac, wahaClient } from "./lib/waha.ts";

const wahaMsg = (p: Record<string, unknown> = {}) => ({ event: "message", session: "default", payload: { id: "true_33600000001@c.us_A1", from: "33600000001@c.us", fromMe: false, body: "Salut", timestamp: 1_700_000_000, _data: { notifyName: "Alex" }, ...p } });

test("WAHA : un message entrant normalisé ; le sien, un statut, une newsletter, un autre évènement ou un vide = rien", () => {
  const m = parseWahaWebhook(wahaMsg());
  assert.deepEqual(m, { channel: "whatsapp", id: "true_33600000001@c.us_A1", chatId: "33600000001@c.us", senderId: "33600000001@c.us", senderName: "Alex", text: "Salut", isGroup: false, msgTs: 1_700_000_000_000 });
  assert.equal(parseWahaWebhook(wahaMsg({ fromMe: true })), null);
  assert.equal(parseWahaWebhook(wahaMsg({ from: "status@broadcast" })), null);
  assert.equal(parseWahaWebhook(wahaMsg({ from: "123@newsletter" })), null);
  assert.equal(parseWahaWebhook({ ...wahaMsg(), event: "message.ack" }), null);
  assert.equal(parseWahaWebhook(wahaMsg({ body: "  " })), null);
  assert.equal(parseWahaWebhook(wahaMsg({ body: "", hasMedia: true }))?.text, "[média sans légende]");
  const g = parseWahaWebhook(wahaMsg({ from: "1203@g.us", participant: "33600000002@c.us" }));
  assert.equal(g?.isGroup, true);
  assert.equal(g?.senderId, "33600000002@c.us");
  assert.equal(parseWahaWebhook("nope"), null);
});

test("WAHA : la signature HMAC-SHA512 est vérifiée en temps constant ; sans clé, rien à vérifier", () => {
  const raw = JSON.stringify(wahaMsg());
  const sig = createHmac("sha512", "k").update(raw).digest("hex");
  assert.equal(verifyWahaHmac(raw, sig, "k"), true);
  assert.equal(verifyWahaHmac(raw, sig, "autre"), false);
  assert.equal(verifyWahaHmac(raw, undefined, "k"), false);
  assert.equal(verifyWahaHmac(raw, "zz", "k"), false);
  assert.equal(verifyWahaHmac(raw, undefined, undefined), true);
});

test("WAHA : le client poste session, chatId et la clé d'API ; sendText lève sur un non-2xx", async () => {
  const calls: Array<{ url: string; body: unknown; key: string | null }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("x-api-key") });
    return new Response("{}", { status: url.endsWith("/sendText") && calls.length > 1 ? 500 : 200 });
  }) as typeof fetch;
  const c = wahaClient({ baseUrl: "http://waha:3000/", apiKey: "secret", session: "lupi", fetchFn });
  await c.sendText("1@c.us", "bonjour");
  assert.deepEqual(calls[0], { url: "http://waha:3000/api/sendText", body: { session: "lupi", chatId: "1@c.us", text: "bonjour" }, key: "secret" });
  await assert.rejects(c.sendText("1@c.us", "x"), /HTTP 500/);
});

test("Telegram : un Update normalisé ; un bot, une édition, un vide = rien ; découpe à 4096", () => {
  const u = { update_id: 7, message: { message_id: 3, date: 1_700_000_000, chat: { id: 42, type: "private" }, from: { id: 42, first_name: "Alex" }, text: "Salut" } };
  assert.deepEqual(parseTelegramUpdate(u), { channel: "telegram", id: "3", chatId: "42", senderId: "42", senderName: "Alex", text: "Salut", isGroup: false, msgTs: 1_700_000_000_000 });
  assert.equal(parseTelegramUpdate({ update_id: 8, message: { ...u.message, from: { id: 9, is_bot: true } } }), null);
  assert.equal(parseTelegramUpdate({ update_id: 9, edited_message: u.message }), null);
  assert.equal(parseTelegramUpdate({ update_id: 9, message: { ...u.message, text: "" } }), null);
  assert.equal(parseTelegramUpdate({ update_id: 9, message: { ...u.message, chat: { id: -5, type: "supergroup" } } })?.isGroup, true);
  const long = ("a".repeat(3000) + "\n") + "b".repeat(3000);
  const parts = splitMessage(long);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((p) => p.length <= 4096));
  assert.equal(parts.join("\n"), long);
});

test("Telegram : une erreur d'API ne recopie jamais le jeton", async () => {
  const fetchFn = (async () => new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(telegramClient({ token: "123:SECRET", fetchFn }).sendMessage("1", "x"), (e: Error) => /HTTP 401 Unauthorized/.test(e.message) && !e.message.includes("SECRET"));
});

test("liste blanche : fermée par défaut ; numéro nu accepté ; un groupe s'autorise par lui-même", () => {
  const m: InboundMessage = { channel: "whatsapp", id: "1", chatId: "33600000001@c.us", senderId: "33600000001@c.us", senderName: null, text: "x", isGroup: false };
  assert.equal(isAllowed(m, parseAllowlist("")), false);
  assert.equal(isAllowed(m, parseAllowlist("33600000001")), true);
  assert.equal(isAllowed(m, parseAllowlist("33600000001@c.us, 42")), true);
  const g = { ...m, chatId: "1203@g.us", isGroup: true };
  assert.equal(isAllowed(g, parseAllowlist("33600000001")), false, "être autorisé en 1:1 n'ouvre pas ses groupes");
  assert.equal(isAllowed(g, parseAllowlist("1203@g.us")), true);
  assert.equal(isAllowed(g, parseAllowlist("*")), true);
});

test("prompt et silence", () => {
  const p = buildTurnPrompt({ channel: "telegram", id: "1", chatId: "42", senderId: "42", senderName: "Alex", text: "Quelle heure ?", isGroup: false });
  assert.match(p, /^\[Telegram · conversation privée · de Alex \(42\)\]/);
  assert.match(p, /Quelle heure \?$/);
  assert.equal(isSilence(" SILENCE "), true);
  assert.equal(isSilence(""), true);
  assert.equal(isSilence("Silence radio ici"), false);
});

test("ChatQueue : un tour à la fois par fil, les fils en parallèle", async () => {
  const q = new ChatQueue();
  const ordre: string[] = [];
  const attente = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await Promise.all([
    q.run("a", async () => { await attente(20); ordre.push("a1"); }),
    q.run("a", async () => { ordre.push("a2"); }),
    q.run("b", async () => { ordre.push("b1"); }),
  ]);
  assert.deepEqual(ordre, ["b1", "a1", "a2"]);
  q.run("c", async () => { throw new Error("x"); });
  await q.run("c", async () => { ordre.push("c2"); });
  assert.equal(ordre.at(-1), "c2", "un tour qui lève ne bloque pas le fil");
});

test("bout en bout : webhook WAHA signé → tour → réponse dans le même fil ; hors liste et mauvaise signature ignorés", async () => {
  const envois: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    envois.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("{}");
  }) as typeof fetch;
  const prompts: string[] = [];
  const gw = await startGateway({
    port: 0,
    waha: { baseUrl: "http://waha", session: "default", hmacKey: "k", allow: parseAllowlist("33600000001") },
    runTurn: async (prompt) => { prompts.push(prompt); return { ok: true, text: "Bonjour !" }; },
    fetchFn,
    log: () => {},
  });
  try {
    const post = (body: unknown, key = "k") => {
      const raw = JSON.stringify(body);
      return fetch(`http://127.0.0.1:${gw.port}/waha`, { method: "POST", body: raw, headers: { "x-webhook-hmac": createHmac("sha512", key).update(raw).digest("hex") } });
    };
    assert.equal((await post(wahaMsg(), "faux")).status, 401);
    assert.equal((await post(wahaMsg({ id: "B", from: "33699999999@c.us" }))).status, 200);
    assert.equal((await post(wahaMsg())).status, 200);
    assert.equal((await post(wahaMsg())).status, 200, "le même id rejoué");
    for (let i = 0; i < 50 && !envois.some((e) => e.url.endsWith("/sendText")); i++) await new Promise((r) => setTimeout(r, 10));
    const textes = envois.filter((e) => e.url.endsWith("/sendText"));
    assert.equal(textes.length, 1, "une réponse, au seul autorisé, une seule fois");
    assert.deepEqual(textes[0].body, { session: "default", chatId: "33600000001@c.us", text: "Bonjour !" });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /PÉRIMÉ/, "un message de 2023 est annoté comme rejeu probable");
    const h = await (await fetch(`http://127.0.0.1:${gw.port}/health`)).json();
    assert.equal(h.ok, true);
  } finally {
    await gw.close();
  }
});

test("bout en bout : Telegram en long polling, réponse SILENCE = rien envoyé", async () => {
  let n = 0;
  const envoyes: unknown[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith("/getUpdates")) {
      n++;
      const result = n === 1 ? [
        { update_id: 10, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 42, type: "private" }, from: { id: 42 }, text: "ping" } },
        { update_id: 11, message: { message_id: 2, date: Math.floor(Date.now() / 1000), chat: { id: 42, type: "private" }, from: { id: 42 }, text: "chut" } },
      ] : [];
      if (n > 1) await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ ok: true, result }));
    }
    if (url.endsWith("/sendMessage")) envoyes.push(body);
    return new Response(JSON.stringify({ ok: true, result: true }));
  }) as typeof fetch;
  const gw = await startGateway({
    port: 0,
    telegram: { token: "t", allow: parseAllowlist("42"), pollTimeoutSec: 0 },
    runTurn: async (prompt) => ({ ok: true, text: prompt.endsWith("ping") ? "pong" : "SILENCE" }),
    fetchFn,
    log: () => {},
  });
  try {
    for (let i = 0; i < 100 && envoyes.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(envoyes, [{ chat_id: "42", text: "pong" }]);
  } finally {
    await gw.close();
  }
});
