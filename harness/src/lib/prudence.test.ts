import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrudenceGate, prudenceCountToday, utcDay, type PrudenceStore } from "./prudence.ts";

function memStore(): PrudenceStore & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getSetting: (k) => m.get(k) ?? null, setSetting: (k, v) => void m.set(k, v) };
}

const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);

test("sous le plafond, claim accorde et compte", () => {
  const db = memStore();
  const gate = createPrudenceGate(db, { cap: 3, alert: () => assert.fail("pas d'alerte"), log: () => {} });
  assert.equal(gate.claim("a", T0), true);
  assert.equal(gate.claim("b", T0), true);
  assert.equal(gate.claim("c", T0), true);
  assert.equal(prudenceCountToday(db, T0), 3);
});

test("au-delà du plafond : refus, UNE seule alerte, le compteur continue de monter", () => {
  const db = memStore();
  const alerts: string[] = [];
  const gate = createPrudenceGate(db, { cap: 2, alert: (t) => alerts.push(t), log: () => {} });
  const results = [1, 2, 3, 4, 5].map((i) => gate.claim(`cause-${i}`, T0));
  assert.deepEqual(results, [true, true, false, false, false]);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /cause-3/);
  assert.equal(prudenceCountToday(db, T0), 5);
});

test("changement de jour UTC : remise à zéro, nouvelle alerte possible", () => {
  const db = memStore();
  const alerts: string[] = [];
  const gate = createPrudenceGate(db, { cap: 1, alert: (t) => alerts.push(t), log: () => {} });
  gate.claim("x", T0);
  assert.equal(gate.claim("x", T0), false);
  const demain = T0 + 24 * 3_600_000;
  assert.equal(prudenceCountToday(db, demain), 0);
  assert.equal(gate.claim("y", demain), true);
  assert.equal(gate.claim("y", demain), false);
  assert.equal(alerts.length, 2);
});

test("cap <= 0 : compte sans jamais bloquer", () => {
  const db = memStore();
  const gate = createPrudenceGate(db, { cap: 0, alert: () => assert.fail("pas d'alerte"), log: () => {} });
  for (let i = 0; i < 50; i++) assert.equal(gate.claim("z", T0), true);
  assert.equal(prudenceCountToday(db, T0), 50);
});

test("une alerte qui lève ne casse pas le refus", () => {
  const db = memStore();
  const logs: string[] = [];
  const gate = createPrudenceGate(db, {
    cap: 1,
    alert: () => {
      throw new Error("canal mort");
    },
    log: (m) => logs.push(m),
  });
  gate.claim("a", T0);
  assert.equal(gate.claim("b", T0), false);
  assert.ok(logs.some((l) => /canal mort/.test(l)));
});

test("utcDay : jour UTC, pas local", () => {
  assert.equal(utcDay(Date.UTC(2026, 5, 1, 23, 59, 59)), "2026-06-01");
  assert.equal(utcDay(Date.UTC(2026, 5, 2, 0, 0, 0)), "2026-06-02");
});
