import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMode, parseModeState, effectiveMode, suspended, whatMayBeSent, setMode, setTz, modeEndsAt,
  clockRestartsAt, morningLine, describeMode, dayIn, hourIn, weekdayIn, wallToEpoch, startOfDayIn, tzOffsetMs, validTz, currentTz,
} from "./presence-mode.ts";

const T = Date.parse("2026-10-10T12:00:00Z");

test("fuseaux : décalage, heure d'été, jour local, minuit local", () => {
  assert.equal(tzOffsetMs(Date.parse("2026-07-01T12:00:00Z"), "Europe/Paris"), 2 * 3_600_000);
  assert.equal(tzOffsetMs(Date.parse("2026-01-01T12:00:00Z"), "Europe/Paris"), 3_600_000);
  assert.equal(tzOffsetMs(T, "America/New_York"), -4 * 3_600_000);
  assert.equal(dayIn(Date.parse("2026-10-10T23:30:00Z"), "Asia/Tokyo"), "2026-10-11");
  assert.equal(hourIn(Date.parse("2026-10-10T23:30:00Z"), "Asia/Tokyo"), 8);
  assert.equal(weekdayIn(Date.parse("2026-10-11T12:00:00Z"), "UTC"), 0);
  assert.equal(startOfDayIn("2026-10-11", "Asia/Tokyo"), Date.parse("2026-10-10T15:00:00Z"));
  assert.equal(wallToEpoch("2026-10-10", 7, 30, "Europe/Paris"), Date.parse("2026-10-10T05:30:00Z"));
  assert.ok(validTz("Asia/Tokyo"));
  assert.ok(!validTz("Mars/Olympus"));
  assert.equal(currentTz({ tz: "Mars/Olympus" }, "UTC"), "UTC");
});

test("wallToEpoch traverse le changement d'heure", () => {
  // 2026-03-29 : passage à l'heure d'été en Europe, 02:00 -> 03:00
  assert.equal(wallToEpoch("2026-03-29", 8, 0, "Europe/Paris"), Date.parse("2026-03-29T06:00:00Z"));
  assert.equal(wallToEpoch("2026-03-28", 8, 0, "Europe/Paris"), Date.parse("2026-03-28T07:00:00Z"));
});

test("normalizeMode ignore les champs invalides, un mode inconnu vaut normal", () => {
  assert.deepEqual(normalizeMode(null), { mode: "normal" });
  assert.deepEqual(normalizeMode({ mode: "vacances" }), { mode: "normal" });
  const e = normalizeMode({ mode: "absent", until: "2026-10-20", tz: "Nope/Zone", reason: "  voyage " });
  assert.equal(e.tz, undefined);
  assert.equal(e.reason, "voyage");
});

test("parseModeState : vide = normal, JSON cassé = normal signalé", () => {
  assert.deepEqual(parseModeState(null), { mode: "normal" });
  assert.equal(parseModeState("{pas du json").unreadable, true);
  assert.equal(parseModeState('{"mode":"deborde"}').mode, "deborde");
});

test("retour automatique : passé until, le mode redevient normal tout seul", () => {
  const e = normalizeMode({ mode: "absent", until: "2026-10-20", tz: "Asia/Tokyo" });
  assert.equal(effectiveMode(e, T), "absent");
  assert.equal(modeEndsAt(e), Date.parse("2026-10-19T15:00:00Z"));
  assert.equal(effectiveMode(e, Date.parse("2026-10-19T15:00:00Z")), "normal");
  assert.ok(suspended(e, T));
  assert.equal(clockRestartsAt(e, T), null);
  assert.equal(clockRestartsAt(e, Date.parse("2026-10-21T00:00:00Z")), Date.parse("2026-10-19T15:00:00Z"));
});

test("date impossible : null, jamais d'exception", () => {
  assert.equal(modeEndsAt({ mode: "absent", until: "2026-13-40" }), null);
  assert.equal(effectiveMode({ mode: "absent", until: "2026-13-40" }, T), "absent");
});

test("whatMayBeSent : la table des genres", () => {
  const away = normalizeMode({ mode: "absent" });
  for (const k of ["urgent", "summary", "conversation"] as const) assert.ok(whatMayBeSent(k, away, T).send, k);
  for (const k of ["appointment", "promotion", "deadline", "quick"] as const) assert.ok(!whatMayBeSent(k, away, T).send, k);
  assert.ok(whatMayBeSent("quick", { mode: "normal" }, T).send);
});

test("setMode : pose, refuse l'invalide, note le retour", () => {
  const a = setMode({ mode: "normal" }, "absent", { now: T, until: "2026-10-20", reason: "voyage", tz: "Asia/Tokyo" });
  assert.equal(a.tz, "Asia/Tokyo");
  assert.throws(() => setMode({ mode: "normal" }, "absent", { now: T, until: "2026-10-01" }), /déjà passé/);
  assert.throws(() => setMode({ mode: "normal" }, "absent", { now: T, until: "demain" }), /illisible/);
  assert.throws(() => setMode({ mode: "normal" }, "absent", { now: T, tz: "Mars/X" }), /fuseau/);
  assert.throws(() => setMode({ mode: "normal" }, "dormant" as never, { now: T }), /inconnu/);
  const back = setMode(a, "normal", { now: T + 1000 });
  assert.equal(back.returnedAt, new Date(T + 1000).toISOString());
  assert.equal(back.tz, "Asia/Tokyo");
  assert.equal(setMode(a, "absent", { now: T, tz: "auto" }).tz, undefined);
});

test("setTz et lignes du matin", () => {
  assert.equal(setTz({ mode: "absent" }, "Asia/Tokyo").tz, "Asia/Tokyo");
  assert.equal(setTz({ mode: "absent", tz: "Asia/Tokyo" }, null).tz, undefined);
  assert.throws(() => setTz({ mode: "normal" }, "Nope/Nope"));
  const e = normalizeMode({ mode: "absent", until: "2026-10-12" });
  assert.match(morningLine(e, T), /gelés/);
  assert.match(morningLine(e, Date.parse("2026-10-12T10:00:00Z")), /reprennent/);
  assert.equal(morningLine({ mode: "normal" }, T), "rien");
  assert.match(describeMode(e, T), /absent jusqu'au 2026-10-12/);
});
