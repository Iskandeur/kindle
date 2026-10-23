import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CASUALTIES, casualtyKeyAndLabel, outageDeadEngine, outageOpen, recordOutageCasualty, recoveryWakeBody,
  restoreOutageRecovery, takeOutageRecovery,
} from "./outage-recovery.ts";

function memStore() {
  const m = new Map<string, string>();
  return { getSetting: (k: string) => m.get(k) ?? null, setSetting: (k: string, v: string) => void m.set(k, v) };
}
const T = Date.parse("2026-01-01T10:00:00Z");
const MIN = 60_000;

test("sans victime, pas de panne ouverte, et rien à prendre", () => {
  const s = memStore();
  assert.equal(outageOpen(s), false);
  assert.equal(takeOutageRecovery(s, T), null);
});

test("une victime ouvre l'épisode avec sa cause ; le moteur n'est noté qu'une fois", () => {
  const s = memStore();
  recordOutageCasualty(s, { source: "whatsapp", msgId: "m1", body: "salut", chatId: "c1" }, "Not logged in", T, "claude");
  recordOutageCasualty(s, { source: "whatsapp", msgId: "m2", body: "ça va ?" }, "autre cause", T + MIN, "autre");
  assert.equal(outageOpen(s), true);
  assert.equal(outageDeadEngine(s), "claude");
  const rec = takeOutageRecovery(s, T + 5 * MIN)!;
  assert.equal(rec.cause, "Not logged in");
  assert.equal(rec.startedAt, T);
  assert.equal(rec.casualties.length, 2);
});

test("une veille qui meurt dix fois = une ligne, son dernier corps, un compteur", () => {
  const s = memStore();
  for (let i = 0; i < 10; i++) recordOutageCasualty(s, { wakeSensor: "veille-x", body: `état ${i}` }, "auth", T + i * MIN);
  const rec = takeOutageRecovery(s, T + 20 * MIN)!;
  assert.equal(rec.casualties.length, 1);
  assert.equal(rec.casualties[0]!.count, 10);
  assert.equal(rec.casualties[0]!.body, "état 9");
  assert.equal(rec.casualties[0]!.firstAt, T);
});

test("prendre vide le registre : le deuxième appel ne rend rien", () => {
  const s = memStore();
  recordOutageCasualty(s, { body: "x" }, "auth", T, "claude");
  assert.ok(takeOutageRecovery(s, T + MIN));
  assert.equal(takeOutageRecovery(s, T + 2 * MIN), null);
  assert.equal(outageOpen(s), false);
  assert.equal(outageDeadEngine(s), "");
});

test("le plafond garde les messages d'abord, puis les plus récents", () => {
  const s = memStore();
  recordOutageCasualty(s, { source: "whatsapp", msgId: "ancien-message", body: "important" }, "auth", T);
  for (let i = 0; i < MAX_CASUALTIES + 10; i++) recordOutageCasualty(s, { wakeSensor: `s${i}`, body: "v" }, "auth", T + (i + 1) * MIN);
  const rec = takeOutageRecovery(s, T + 999 * MIN)!;
  assert.equal(rec.casualties.length, MAX_CASUALTIES);
  assert.ok(rec.casualties.some((c) => c.key === "msg:ancien-message"));
  assert.ok(!rec.casualties.some((c) => c.key === "sensor:s0"));
});

test("rechute : restore fusionne avec ce qui est arrivé depuis, début de panne le plus ancien", () => {
  const s = memStore();
  recordOutageCasualty(s, { wakeSensor: "v1", body: "a" }, "auth", T, "claude");
  recordOutageCasualty(s, { wakeSensor: "v2", body: "b" }, "auth", T + MIN);
  const rec = takeOutageRecovery(s, T + 10 * MIN)!;
  // la reprise meurt : un évènement neuf s'inscrit, puis on remet l'inventaire
  recordOutageCasualty(s, { wakeSensor: "v1", body: "a2" }, "auth", T + 11 * MIN);
  restoreOutageRecovery(s, rec, "claude");
  const again = takeOutageRecovery(s, T + 20 * MIN)!;
  assert.equal(again.startedAt, T);
  assert.equal(again.casualties.length, 2);
  const v1 = again.casualties.find((c) => c.key === "sensor:v1")!;
  assert.equal(v1.count, 2);
  assert.equal(v1.firstAt, T);
  assert.equal(again.cause, "auth");
});

test("casualtyKeyAndLabel : job, tâche, canal, message distincts par msgId", () => {
  assert.equal(casualtyKeyAndLabel({ jobWake: { jobId: 5 } }).key, "job:5");
  assert.equal(casualtyKeyAndLabel({ taskId: "t1", taskTitle: "Titre" }).label, "fil de la tâche « Titre »");
  assert.equal(casualtyKeyAndLabel({ sessionChannel: "veille" }).key, "channel:veille");
  const a = casualtyKeyAndLabel({ source: "whatsapp", msgId: "A", body: "même texte" });
  const b = casualtyKeyAndLabel({ source: "whatsapp", msgId: "B", body: "même texte" });
  assert.notEqual(a.key, b.key);
  assert.equal(casualtyKeyAndLabel({ source: "whatsapp", reaction: { emoji: "👍" } }).label, "réaction 👍");
  assert.equal(casualtyKeyAndLabel({ source: "cron", body: "x" }).label, "tâche périodique");
  assert.equal(casualtyKeyAndLabel({ wakeId: 3 }).key, "wake:3");
});

test("recoveryWakeBody : heures dans le fuseau demandé, jobs relancés, inventaire, consignes", () => {
  const s = memStore();
  recordOutageCasualty(s, { source: "whatsapp", msgId: "m", body: "tu peux regarder ?", chatId: "33600000000@c.us" }, "Not logged in", T);
  const rec = takeOutageRecovery(s, T + 25 * MIN)!;
  const body = recoveryWakeBody(rec, [12, 13], "UTC");
  assert.match(body, /10:00 à 10:25 \(UTC, ~25 min\)/);
  assert.match(body, /#12, #13/);
  assert.match(body, /message WhatsApp/);
  assert.match(body, /tu peux regarder \?/);
  assert.match(body, /À faire, dans l'ordre/);
  const vide = recoveryWakeBody({ startedAt: T, endedAt: T + MIN, casualties: [], cause: "" });
  assert.match(vide, /Aucun évènement inscrit/);
  assert.match(vide, /\(inconnue\)/);
});
