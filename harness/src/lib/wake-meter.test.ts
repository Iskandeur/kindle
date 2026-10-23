import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWakeMeter,
  wakeSessionsToday,
  wakeMeterAlertText,
  WAKE_METER_COUNTS_KEY,
  WAKE_METER_DAY_KEY,
  NO_SENSOR_ORIGIN,
  type WakeMeterStore,
} from "./wake-meter.ts";

function memStore(): WakeMeterStore & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getSetting: (k) => m.get(k) ?? null, setSetting: (k, v) => void m.set(k, v) };
}

const T0 = Date.UTC(2026, 0, 10, 8, 0, 0);

test("compte par origine, total cumulé", () => {
  const db = memStore();
  const meter = createWakeMeter(db, { threshold: 100, alert: () => {}, log: () => {} });
  meter.record("flux-blog", T0);
  meter.record("flux-blog", T0);
  meter.record(NO_SENSOR_ORIGIN, T0);
  const c = wakeSessionsToday(db, T0);
  assert.equal(c.total, 3);
  assert.deepEqual(c.byOrigin, { "flux-blog": 2, [NO_SENSOR_ORIGIN]: 1 });
});

test("UNE alerte au franchissement, rien n'est bloqué, le compte continue", () => {
  const db = memStore();
  const alerts: string[] = [];
  const meter = createWakeMeter(db, { threshold: 3, alert: (t) => alerts.push(t), log: () => {} });
  for (let i = 0; i < 3; i++) meter.record("calme", T0);
  assert.equal(alerts.length, 0, "pile au seuil : pas encore d'alerte");
  meter.record("bavard", T0);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /calme 3/);
  for (let i = 0; i < 10; i++) meter.record("bavard", T0);
  assert.equal(alerts.length, 1, "pas de seconde alerte le même jour");
  assert.equal(wakeSessionsToday(db, T0).total, 14);
});

test("l'alerte unique survit à un redémarrage (l'état est en base)", () => {
  const db = memStore();
  const alerts: string[] = [];
  const opts = { threshold: 1, alert: (t: string) => alerts.push(t), log: () => {} };
  createWakeMeter(db, opts).record("a", T0);
  createWakeMeter(db, opts).record("a", T0); // franchit : alerte
  createWakeMeter(db, opts).record("a", T0); // « nouveau process » : pas de rebelote
  assert.equal(alerts.length, 1);
});

test("nouveau jour UTC : remise à zéro", () => {
  const db = memStore();
  const meter = createWakeMeter(db, { threshold: 100, alert: () => {}, log: () => {} });
  meter.record("a", T0);
  const demain = T0 + 86_400_000;
  assert.equal(wakeSessionsToday(db, demain).total, 0);
  meter.record("a", demain);
  assert.equal(wakeSessionsToday(db, demain).total, 1);
});

test("threshold <= 0 : compte sans jamais alerter", () => {
  const db = memStore();
  const meter = createWakeMeter(db, { threshold: 0, alert: () => assert.fail("pas d'alerte"), log: () => {} });
  for (let i = 0; i < 20; i++) meter.record("a", T0);
  assert.equal(wakeSessionsToday(db, T0).total, 20);
});

test("une valeur de réglage abîmée vaut « rien compté », jamais une exception", () => {
  const db = memStore();
  db.setSetting(WAKE_METER_DAY_KEY, "2026-01-10");
  for (const bad of ["{pas du json", "[1,2]", "null", '{"a":"x","b":-2,"c":1.9}']) {
    db.setSetting(WAKE_METER_COUNTS_KEY, bad);
    const c = wakeSessionsToday(db, T0);
    assert.ok(Number.isFinite(c.total));
  }
  assert.deepEqual(wakeSessionsToday(db, T0).byOrigin, { c: 1 });
});

test("une alerte qui lève ne casse pas record()", () => {
  const db = memStore();
  const meter = createWakeMeter(db, {
    threshold: 1,
    alert: () => {
      throw new Error("canal mort");
    },
    log: () => {},
  });
  meter.record("a", T0);
  meter.record("a", T0);
  assert.equal(wakeSessionsToday(db, T0).total, 2);
});

test("le texte d'alerte nomme les 5 plus bavards, dans l'ordre", () => {
  const t = wakeMeterAlertText(10, {
    total: 40,
    byOrigin: { a: 1, b: 9, c: 8, d: 7, e: 6, f: 5, g: 4 },
  });
  assert.match(t, /b 9, c 8, d 7, e 6, f 5/);
  assert.doesNotMatch(t, /g 4/);
});
