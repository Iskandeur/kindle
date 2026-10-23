import { test } from "node:test";
import assert from "node:assert/strict";
import { jobState, jobsEngine, type JobStore } from "./agent-engine.ts";

function store(): JobStore & { added: unknown[][] } {
  const jobs = new Map<number, { status: string; result: string | null }>([
    [1, { status: "pending", result: null }],
    [2, { status: "running", result: null }],
    [3, { status: "error", result: "boom" }],
  ]);
  const added: unknown[][] = [];
  return {
    added,
    addJobDeduped: (intent, by, model, opts) => {
      added.push([intent, by, model, opts]);
      return intent === "dup" ? { id: 1, created: false } : { id: 9, created: true };
    },
    getJob: (id) => jobs.get(id) ?? null,
    cancelPendingJob: (id) => {
      const j = jobs.get(id);
      if (!j) return { ok: false, status: null };
      if (j.status !== "pending") return { ok: false, status: j.status };
      j.status = "cancelled";
      return { ok: true };
    },
  };
}

test("jobState : vocabulaire commun", () => {
  const m: Record<string, string> = { pending: "en_file", running: "en_cours", quota_hold: "suspendu", done: "fini", error: "echec", cancelled: "annule", zzz: "inconnu" };
  for (const [k, v] of Object.entries(m)) assert.equal(jobState(k), v);
  assert.equal(jobState(null), "inconnu");
});

test("invoke : dédup et notBefore", () => {
  const s = store();
  const e = jobsEngine(s);
  assert.equal(e.name, "jobs");
  assert.deepEqual(e.invoke({ intent: "x", by: "me", notBefore: 5 }), { id: "9", alreadyInFlight: false });
  assert.deepEqual(s.added[0], ["x", "me", null, { notBefore: 5 }]);
  assert.deepEqual(e.invoke({ intent: "dup", by: "me" }), { id: "1", alreadyInFlight: true });
  assert.deepEqual(s.added[1], ["dup", "me", null, {}]);
});

test("status : connu, échec avec résultat, inconnu, id invalide", () => {
  const e = jobsEngine(store());
  assert.deepEqual(e.status("2"), { state: "en_cours", result: null });
  assert.deepEqual(e.status("3"), { state: "echec", result: "boom" });
  assert.deepEqual(e.status("99"), { state: "inconnu", result: null });
  assert.deepEqual(e.status("abc"), { state: "inconnu", result: null });
});

test("cancel : seul un job en file s'annule, le refus est dit", () => {
  const e = jobsEngine(store());
  assert.deepEqual(e.cancel("1", "plus utile"), { ok: true });
  const r2 = e.cancel("2", "x");
  assert.ok(!r2.ok && /running/.test(r2.reason));
  const r3 = e.cancel("99", "x");
  assert.ok(!r3.ok && /inconnu/.test(r3.reason));
  const r4 = e.cancel("pas-un-id", "x");
  assert.ok(!r4.ok && /invalide/.test(r4.reason));
});
