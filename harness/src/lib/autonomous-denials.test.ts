import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDenials, withDenials, isAutonomousSource, verbVariants } from "./autonomous-denials.ts";

test("verbVariants : espacement et guillemets", () => {
  assert.deepEqual(verbVariants("arbiter.ts", "override"), ["arbiter.ts override", "arbiter.ts  override", 'arbiter.ts "override', "arbiter.ts 'override"]);
});

test("buildDenials : verbes avec joker de chaque côté, dossiers en Write et Edit relatifs ET absolus", () => {
  const d = buildDenials({ verbs: [{ script: "arbiter.ts", subverb: "override" }], protectedDirs: ["data/arbitrages"] });
  assert.equal(d.filter((x) => x.startsWith("Bash(*arbiter.ts")).length, 4);
  assert.ok(d.includes("Bash(*arbiter.ts override*)"));
  for (const tool of ["Write", "Edit"]) {
    assert.ok(d.includes(`${tool}(data/arbitrages/**)`));
    assert.ok(d.includes(`${tool}(**/data/arbitrages/**)`));
  }
  assert.deepEqual(buildDenials({}), []);
});

test("withDenials : fusion sans doublon, ordre conservé", () => {
  const d = ["A", "B"];
  assert.equal(withDenials(d), "A,B");
  assert.equal(withDenials(d, "X, A"), "X,A,B");
  assert.equal(withDenials(d, withDenials(d, "X")), "X,A,B");
});

test("isAutonomousSource", () => {
  for (const s of ["wake", "cron", "agent"]) assert.ok(isAutonomousSource(s));
  for (const s of ["whatsapp", "dashboard", ""]) assert.ok(!isAutonomousSource(s));
  assert.ok(isAutonomousSource("sensor", ["sensor"]));
});
