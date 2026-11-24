import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRelayPrompt, gatewayToolsEnabled, failureReply, formatLocalTime, isSilentReply, ShortHistory, SILENCE_TOKEN } from "./gateway-core.ts";

test("formatLocalTime : fuseau IANA respecté, fuseau invalide → UTC", () => {
  const d = new Date("2026-07-01T12:00:00Z");
  assert.match(formatLocalTime(d, "Europe/Paris"), /14:00 \(Europe\/Paris\)/);
  assert.match(formatLocalTime(d, "America/New_York"), /08:00 \(America\/New_York\)/);
  assert.match(formatLocalTime(d, "Pas/UnFuseau"), /12:00 \(UTC\)/);
});

test("isSilentReply : vide ou jeton seul", () => {
  assert.equal(isSilentReply(""), true);
  assert.equal(isSilentReply(`  ${SILENCE_TOKEN.toUpperCase()} `), true);
  assert.equal(isSilentReply("ok"), false);
});

test("ShortHistory : bornée, par conversation, textes tronqués", () => {
  const h = new ShortHistory(2);
  h.push("a", { from: "humain", text: "1" });
  h.push("a", { from: "agent", text: "2" });
  h.push("a", { from: "humain", text: "x".repeat(5000) });
  assert.equal(h.get("a").length, 2);
  assert.equal(h.get("a")[1].text.length, 1500);
  assert.deepEqual(h.get("b"), []);
});

test("buildRelayPrompt : humain vs tiers, groupe, historique, pièces jointes", () => {
  const p = buildRelayPrompt({ channel: "WhatsApp", localTime: "lundi", sender: "Alex", isPrincipal: true, text: "salut", history: [{ from: "agent", text: "hello\nworld" }] });
  assert.match(p, /\[WhatsApp\] Alex t'écrit/);
  assert.doesNotMatch(p, /discretion\.md/);
  assert.match(p, /- toi : hello world/);
  assert.match(p, /envoyée telle quelle sur WhatsApp/);
  const g = buildRelayPrompt({ channel: "WhatsApp", localTime: "t", sender: "Bob", isPrincipal: false, isGroup: true, text: "", attachments: ["image : /tmp/a.jpg"], warning: "[⚠️ vieux]" });
  assert.match(g, /groupe/);
  assert.match(g, /discretion\.md/);
  assert.match(g, /\[⚠️ vieux\]/);
  assert.match(g, /\(pas de texte\)/);
  assert.match(g, /- image : \/tmp\/a\.jpg/);
  assert.match(g, /silence est ton mode par défaut/);
});

test("failureReply : quota, délai, défaut ; jamais le détail interne", () => {
  assert.match(failureReply({ error: "HTTP 429 Too Many" }), /quota/);
  assert.match(failureReply({ error: "timeout after 900s" }), /trop de temps/);
  const d = failureReply({ error: "ECONNREFUSED 10.0.0.3 secret" });
  assert.doesNotMatch(d, /10\.0\.0\.3/);
});

test("gatewayToolsEnabled : oui par défaut, 0/false/off coupent", () => {
  assert.equal(gatewayToolsEnabled({}), true);
  assert.equal(gatewayToolsEnabled({ KINDLE_GATEWAY_TOOLS: "1" }), true);
  for (const v of ["0", "false", "OFF", " non "]) assert.equal(gatewayToolsEnabled({ KINDLE_GATEWAY_TOOLS: v }), false);
});
