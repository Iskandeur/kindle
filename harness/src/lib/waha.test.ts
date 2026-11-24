import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  allowSend,
  isChatAllowed,
  normalizeWahaWebhook,
  parseAllowedChats,
  readWahaConfig,
  stanzaOf,
  verifyWahaHmac,
  wahaSendText,
  type WahaConfig,
} from "./waha.ts";

const msg = (payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  event: "message",
  session: "default",
  payload: { id: "false_33600000001@c.us_AAA", from: "33600000001@c.us", body: "salut", timestamp: 1_800_000_000, fromMe: false, ...payload },
  ...extra,
});

test("normalizeWahaWebhook : 1:1 texte", () => {
  const m = normalizeWahaWebhook(msg({}))!;
  assert.equal(m.chatId, "33600000001@c.us");
  assert.equal(m.isGroup, false);
  assert.equal(m.author, "33600000001@c.us");
  assert.equal(m.body, "salut");
  assert.equal(m.msgTs, 1_800_000_000_000);
  assert.equal(m.dedupKey, "AAA");
});

test("normalizeWahaWebhook : groupe → l'auteur est le participant", () => {
  const m = normalizeWahaWebhook(msg({ from: "120363000000000001@g.us", participant: "33600000002@c.us" }))!;
  assert.equal(m.isGroup, true);
  assert.equal(m.author, "33600000002@c.us");
});

test("normalizeWahaWebhook : rejette fromMe, autre évènement, autre session, statut, vide, protocol", () => {
  assert.equal(normalizeWahaWebhook(msg({ fromMe: true })), null);
  assert.equal(normalizeWahaWebhook(msg({}, { event: "message.ack" })), null);
  assert.equal(normalizeWahaWebhook(msg({}, { session: "autre" }), { session: "default" }), null);
  assert.equal(normalizeWahaWebhook(msg({ from: "status@broadcast" })), null);
  assert.equal(normalizeWahaWebhook(msg({ body: "  " })), null);
  assert.equal(normalizeWahaWebhook(msg({ _data: { type: "protocol", subtype: "message_edit" } })), null);
  assert.equal(normalizeWahaWebhook(null), null);
});

test("normalizeWahaWebhook : un média sans texte passe, avec son url", () => {
  const m = normalizeWahaWebhook(msg({ body: "", hasMedia: true, media: { url: "http://waha/f.oga", mimetype: "audio/ogg" } }))!;
  assert.deepEqual(m.media, { url: "http://waha/f.oga", mimetype: "audio/ogg", filename: undefined });
});

test("stanzaOf : extrait la stanza, rend l'id tel quel sinon", () => {
  assert.equal(stanzaOf("true_120363@g.us_3EB0AB_33600000002@c.us"), "3EB0AB");
  assert.equal(stanzaOf("brut"), "brut");
  assert.equal(stanzaOf(undefined), undefined);
});

test("isChatAllowed : fermé par défaut, liste et alias @lid", () => {
  const m = normalizeWahaWebhook(msg({ from: "999@lid" }))!;
  assert.equal(isChatAllowed(m, new Set()), false);
  assert.equal(isChatAllowed(m, parseAllowedChats("999@lid")), true);
  assert.equal(isChatAllowed(m, parseAllowedChats("33600000001@c.us"), new Map([["999@lid", "33600000001@c.us"]])), true);
  assert.deepEqual([...parseAllowedChats(" a@c.us, b@g.us\nc@lid ")], ["a@c.us", "b@g.us", "c@lid"]);
});

test("verifyWahaHmac : bonne signature oui, mauvaise ou absente non", async () => {
  const body = JSON.stringify(msg({}));
  const sig = createHmac("sha512", "k").update(body).digest("hex");
  assert.equal(await verifyWahaHmac(body, sig, "k"), true);
  assert.equal(await verifyWahaHmac(body, sig, "autre"), false);
  assert.equal(await verifyWahaHmac(body, undefined, "k"), false);
  assert.equal(await verifyWahaHmac(body, "zz", "k"), false);
});

test("allowSend : plafond sur fenêtre glissante, un refus ne consomme rien", () => {
  const log: number[] = [];
  assert.equal(allowSend(log, 0, 1000, 2), true);
  assert.equal(allowSend(log, 10, 1000, 2), true);
  assert.equal(allowSend(log, 20, 1000, 2), false);
  assert.equal(log.length, 2);
  assert.equal(allowSend(log, 1500, 1000, 2), true);
});

test("readWahaConfig : null sans URL, défauts sinon", () => {
  assert.equal(readWahaConfig({}), null);
  const c = readWahaConfig({ WAHA_BASE_URL: "http://localhost:3000/" })!;
  assert.equal(c.baseUrl, "http://localhost:3000");
  assert.equal(c.session, "default");
  assert.equal(c.circuitMax, 20);
});

function fakeFetch(routes: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (u: any, init?: RequestInit) => routes(String(u), init)) as typeof fetch;
}

test("wahaSendText : succès → id ; corps JSON avec session et chatId", async () => {
  let seen: any;
  const cfg: WahaConfig = {
    baseUrl: "http://w",
    session: "s1",
    apiKey: "k",
    fetchFn: fakeFetch((url, init) => {
      seen = { url, body: JSON.parse(String(init?.body)), key: (init?.headers as any)["X-Api-Key"] };
      return Response.json({ id: { _serialized: "true_x_ID1" } }, { status: 201 });
    }),
  };
  assert.equal(await wahaSendText(cfg, "1@c.us", "yo"), "true_x_ID1");
  assert.deepEqual(seen, { url: "http://w/api/sendText", body: { session: "s1", chatId: "1@c.us", text: "yo" }, key: "k" });
});

test("wahaSendText : 500 mais message déjà dans le fil → pas d'erreur, pas de doublon", async () => {
  const now = Math.floor(Date.now() / 1000);
  const cfg: WahaConfig = {
    baseUrl: "http://w",
    session: "s",
    fetchFn: fakeFetch((url) =>
      url.endsWith("/api/sendText")
        ? new Response("boom", { status: 500 })
        : Response.json([{ fromMe: true, body: "yo", timestamp: now, id: { _serialized: "true_x_LIVRE" } }]),
    ),
  };
  assert.equal(await wahaSendText(cfg, "2@c.us", "yo"), "true_x_LIVRE");
});

test("wahaSendText : 4xx lève sans sonder", async () => {
  let probed = false;
  const cfg: WahaConfig = {
    baseUrl: "http://w",
    session: "s",
    fetchFn: fakeFetch((url) => {
      if (!url.endsWith("/api/sendText")) probed = true;
      return new Response("session does not exist", { status: 422 });
    }),
  };
  await assert.rejects(wahaSendText(cfg, "3@c.us", "yo"), /422/);
  assert.equal(probed, false);
});
