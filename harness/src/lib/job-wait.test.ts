import { test } from "node:test";
import assert from "node:assert/strict";
import { FINAL_STATUSES, landingLine, waitForJobs, type JobSeen } from "./job-wait.ts";

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const l of gen) out.push(l);
  return out;
}

/** Horloge simulée : `sleep` avance le temps, `onTick` change l'état des jobs. */
function sim(jobs: Map<number, JobSeen>, onTick?: (t: number) => void) {
  let t = 0;
  return {
    getJob: (id: number) => jobs.get(id) ?? null,
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      onTick?.(t);
    },
  };
}

test("une ligne par job qui atterrit, dans l'ordre d'arrivée", async () => {
  const jobs = new Map<number, JobSeen>([
    [1, { id: 1, status: "running", intent: "premier" }],
    [2, { id: 2, status: "done", intent: "second", result: "ok\nsuite" }],
  ]);
  const s = sim(jobs, (t) => {
    if (t >= 30_000) jobs.set(1, { id: 1, status: "error", intent: "premier", result: "boom" });
  });
  const lines = await collect(waitForJobs([1, 2], { ...s, pollMs: 15_000 }));
  assert.deepEqual(lines, ["#2 [done] second — ok", "#1 [error] premier — boom"]);
});

test("un id inconnu est dit une fois et n'est plus attendu", async () => {
  const lines = await collect(waitForJobs([9], { ...sim(new Map()) }));
  assert.deepEqual(lines, ["#9 inconnu"]);
});

test("la ligne « toujours en vol » est bornée par heartbeatMs", async () => {
  const jobs = new Map<number, JobSeen>([[1, { id: 1, status: "running", intent: "long" }]]);
  const s = sim(jobs, (t) => {
    if (t >= 100_000) jobs.set(1, { id: 1, status: "done", intent: "long", result: "fini" });
  });
  const lines = await collect(waitForJobs([1], { ...s, pollMs: 10_000, heartbeatMs: 30_000 }));
  const beats = lines.filter((l) => l.startsWith("⏳"));
  assert.equal(beats.length, 3);
  assert.equal(lines[lines.length - 1], "#1 [done] long — fini");
});

test("le plafond rend la main en nommant ce qui vole encore", async () => {
  const jobs = new Map<number, JobSeen>([[1, { id: 1, status: "running", intent: "sans fin" }]]);
  const lines = await collect(waitForJobs([1], { ...sim(jobs), pollMs: 60_000, heartbeatMs: 10 ** 9, maxMs: 300_000 }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /plafond d'attente atteint.*#1/);
});

test("landingLine : intent compacté, résultat vide signalé", () => {
  assert.equal(landingLine({ id: 3, status: "done", intent: "a\n  b", result: null }), "#3 [done] a b — (pas de résultat)");
  assert.ok(FINAL_STATUSES.has("cancelled") && !FINAL_STATUSES.has("running"));
});
