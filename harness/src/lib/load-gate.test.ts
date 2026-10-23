import { test } from "node:test";
import assert from "node:assert/strict";
import { INITIAL_LOAD_STATE, LoadGate, defaultThresholds, loadAlertText, observeLoad, parseLoadavg } from "./load-gate.ts";

const T = defaultThresholds(2); // haute 20, basse 10, 3 min / 2 min
const MIN = 60_000;

test("defaultThresholds suit le nombre de cœurs", () => {
  assert.equal(defaultThresholds(4).high, 40);
  assert.equal(defaultThresholds(0).high, 10);
});

test("sous le seuil haut : rien ne bouge", () => {
  const d = observeLoad(INITIAL_LOAD_STATE, 15, 0, T);
  assert.equal(d.transition, null);
  assert.equal(d.state.highSince, null);
});

test("au-dessus du seuil haut moins longtemps que highForMs : pas encore", () => {
  let d = observeLoad(INITIAL_LOAD_STATE, 50, 0, T);
  assert.equal(d.state.highSince, 0);
  d = observeLoad(d.state, 50, 2 * MIN, T);
  assert.equal(d.transition, null);
  assert.equal(d.state.suspended, false);
});

test("une accalmie remet le chrono à zéro", () => {
  let d = observeLoad(INITIAL_LOAD_STATE, 50, 0, T);
  d = observeLoad(d.state, 5, 2 * MIN, T);
  assert.equal(d.state.highSince, null);
  d = observeLoad(d.state, 50, 4 * MIN, T);
  d = observeLoad(d.state, 50, 6 * MIN, T);
  assert.equal(d.transition, null);
});

test("tenue assez longtemps : suspension, avec alerte", () => {
  let d = observeLoad(INITIAL_LOAD_STATE, 50, 0, T);
  d = observeLoad(d.state, 50, 3 * MIN, T);
  assert.equal(d.transition, "suspend");
  assert.equal(d.alert, true);
  assert.equal(d.state.suspended, true);
});

test("hystérésis : entre basse et haute, la suspension tient ; reprise après resumeAfterMs sous la basse", () => {
  let d = observeLoad({ ...INITIAL_LOAD_STATE, suspended: true }, 15, 0, T);
  assert.equal(d.state.suspended, true);
  assert.equal(d.state.lowSince, null);
  d = observeLoad(d.state, 4, 10 * MIN, T);
  d = observeLoad(d.state, 4, 11 * MIN, T);
  assert.equal(d.transition, null);
  d = observeLoad(d.state, 4, 12 * MIN, T);
  assert.equal(d.transition, "resume");
  assert.equal(d.state.suspended, false);
});

test("une alerte par heure au plus : une rechute rapide suspend sans ré-alerter", () => {
  let d = observeLoad(INITIAL_LOAD_STATE, 50, 0, T);
  d = observeLoad(d.state, 50, 3 * MIN, T);
  assert.equal(d.alert, true);
  d = observeLoad(d.state, 1, 4 * MIN, T);
  d = observeLoad(d.state, 1, 7 * MIN, T);
  assert.equal(d.transition, "resume");
  d = observeLoad(d.state, 50, 8 * MIN, T);
  d = observeLoad(d.state, 50, 12 * MIN, T);
  assert.equal(d.transition, "suspend");
  assert.equal(d.alert, false);
});

test("une mesure illisible ne change rien", () => {
  const s = { ...INITIAL_LOAD_STATE, suspended: true, lowSince: 5 };
  const d = observeLoad(s, null, 1e9, T);
  assert.equal(d.state, s);
  assert.equal(d.transition, null);
  assert.equal(observeLoad(s, NaN, 1e9, T).transition, null);
});

test("parseLoadavg", () => {
  assert.equal(parseLoadavg("3.14 2.00 1.00 1/200 12345\n"), 3.14);
  assert.equal(parseLoadavg(""), null);
  assert.equal(parseLoadavg(null), null);
  assert.equal(parseLoadavg("abc"), null);
});

test("LoadGate : branche lecture, alerte et journal ; ne lève jamais", () => {
  const alerts: string[] = [];
  const logs: string[] = [];
  let load: number | null = 50;
  const g = new LoadGate({ thresholds: T, read: () => load, alert: (t) => alerts.push(t), log: (m) => logs.push(m) });
  assert.equal(g.observe(0, 2), false);
  assert.equal(g.observe(3 * MIN, 2), true);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /2 job\(s\) en vol/);
  load = 1;
  g.observe(4 * MIN, 2);
  assert.equal(g.observe(6 * MIN, 2), false);
  assert.equal(logs.length, 2);
  const cassee = new LoadGate({ thresholds: T, read: () => { throw new Error("boum"); }, alert: () => {}, log: (m) => logs.push(m) });
  assert.equal(cassee.observe(0, 0), false);
  assert.match(logs[logs.length - 1]!, /boum/);
  assert.match(loadAlertText(33, 1, T), /au-dessus de 20/);
});
