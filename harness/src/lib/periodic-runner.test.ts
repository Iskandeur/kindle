import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cadenceBanner,
  checkDue,
  periodicTick,
  readPeriodicState,
  startPeriodic,
  stateKeys,
  writePeriodicState,
  type PeriodicEvent,
  type PeriodicOutcome,
  type PeriodicSpec,
  type PeriodicState,
  type PeriodicStore,
} from "./periodic-runner.ts";

function memStore(blocking = false): PeriodicStore & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getSetting: (k) => m.get(k) ?? null, setSetting: (k, v) => void m.set(k, v), hasBlockingJob: () => blocking };
}

const T = 1_000_000_000;
const quiet = (): void => {};

type R = { ok: boolean; error?: string };

/** Un runner type : alerte au 2ᵉ échec consécutif, pause d'une heure ensuite. */
function spec(store: PeriodicStore, over: Partial<PeriodicSpec<PeriodicState, R>> & { events?: PeriodicEvent[]; order?: string[] } = {}): PeriodicSpec<PeriodicState, R> {
  const order = over.order ?? [];
  return {
    name: "entretien",
    store,
    intervalMs: 3_600_000,
    now: () => T,
    log: quiet,
    run: async () => ({ ok: true }),
    onThrow: (e) => ({ ok: false, error: e.message }),
    evaluate: ({ result, prevState, nowMs }): PeriodicOutcome<PeriodicState> => {
      order.push("evaluate");
      if (result.ok) return { nextState: { lastRunMs: nowMs, consecutiveFailures: 0, pausedUntilMs: 0 } };
      const n = prevState.consecutiveFailures + 1;
      return {
        nextState: { lastRunMs: nowMs, consecutiveFailures: n, pausedUntilMs: n >= 2 ? nowMs + 3_600_000 : 0 },
        shouldWake: n >= 2,
        wakeNote: `entretien en échec ${n} fois : ${result.error}`,
      };
    },
    onEvent: over.events ? (e) => (over.events!.push(e), order.push("alert")) : undefined,
    ...over,
  };
}

test("checkDue : pause > job en cours > intervalle", () => {
  const state: PeriodicState = { lastRunMs: T - 10, consecutiveFailures: 0, pausedUntilMs: T + 5 };
  assert.deepEqual(checkDue({ nowMs: T, state, intervalMs: 1, hasRunningJob: true }), { due: false, reason: "paused" });
  assert.deepEqual(checkDue({ nowMs: T, state: { ...state, pausedUntilMs: 0 }, intervalMs: 1, hasRunningJob: true }), { due: false, reason: "job-running" });
  assert.deepEqual(checkDue({ nowMs: T, state: { ...state, pausedUntilMs: 0 }, intervalMs: 100, hasRunningJob: false }), { due: false, reason: "not-due" });
  assert.deepEqual(checkDue({ nowMs: T, state: { ...state, pausedUntilMs: 0 }, intervalMs: 10, hasRunningJob: false }), { due: true });
});

test("état : lecture par défaut à zéro, la clé de pause n'est créée qu'au besoin", () => {
  const s = memStore();
  assert.deepEqual(readPeriodicState(s, "x"), { lastRunMs: 0, consecutiveFailures: 0, pausedUntilMs: 0 });
  writePeriodicState(s, "x", { lastRunMs: 5, consecutiveFailures: 1, pausedUntilMs: 0 });
  assert.equal(s.getSetting(stateKeys("x").pausedUntil), null);
  writePeriodicState(s, "x", { lastRunMs: 6, consecutiveFailures: 2, pausedUntilMs: 99 });
  assert.equal(s.getSetting(stateKeys("x").pausedUntil), "99");
  writePeriodicState(s, "x", { lastRunMs: 7, consecutiveFailures: 0, pausedUntilMs: 0 });
  assert.equal(s.getSetting(stateKeys("x").pausedUntil), "0", "une fois créée, la clé est tenue à jour");
});

test("tick : passage réussi → état écrit, pas de réveil", async () => {
  const store = memStore();
  const events: PeriodicEvent[] = [];
  const r = await periodicTick(spec(store, { events }));
  assert.equal(r.ran, true);
  assert.equal(readPeriodicState(store, "entretien").lastRunMs, T);
  assert.equal(events.length, 0);
});

test("tick : pas l'heure → silence, le travail ne tourne pas", async () => {
  const store = memStore();
  writePeriodicState(store, "entretien", { lastRunMs: T - 1000, consecutiveFailures: 0, pausedUntilMs: 0 });
  let ran = false;
  const r = await periodicTick(spec(store, { run: async () => ((ran = true), { ok: true }) }));
  assert.deepEqual(r, { ran: false, reason: "not-due" });
  assert.equal(ran, false);
});

test("tick : un travail qui LÈVE devient un échec compté ; au 2ᵉ, alerte puis pause", async () => {
  const store = memStore();
  const events: PeriodicEvent[] = [];
  const boom = { run: async (): Promise<R> => { throw new Error("disque absent"); }, events };
  await periodicTick(spec(store, boom));
  assert.equal(readPeriodicState(store, "entretien").consecutiveFailures, 1);
  assert.equal(events.length, 0);
  // l'intervalle est écoulé : on avance l'horloge d'une heure
  await periodicTick(spec(store, { ...boom, now: () => T + 3_600_000 }));
  const st = readPeriodicState(store, "entretien");
  assert.equal(st.consecutiveFailures, 2);
  assert.equal(st.pausedUntilMs, T + 7_200_000);
  assert.equal(events.length, 1);
  assert.match(events[0]!.body, /2 fois : disque absent/);
  assert.equal(events[0]!.source, "cron");
  // en pause : rien ne tourne
  const r = await periodicTick(spec(store, { ...boom, now: () => T + 4_000_000 }));
  assert.deepEqual(r, { ran: false, reason: "paused" });
});

test("tick : l'ordre est évaluation → état → ALERTE → best-effort, et un best-effort qui lève ne casse rien", async () => {
  const store = memStore();
  const order: string[] = [];
  const events: PeriodicEvent[] = [];
  const logs: string[] = [];
  await periodicTick(
    spec(store, {
      order,
      events,
      log: (l) => logs.push(l),
      run: async () => ({ ok: false, error: "x" }),
      evaluate: ({ nowMs }) => ({ nextState: { lastRunMs: nowMs, consecutiveFailures: 2, pausedUntilMs: 0 }, shouldWake: true, wakeNote: "alerte" }),
      bestEffort: async () => {
        order.push("best-effort");
        throw new Error("miroir mort");
      },
    }),
  );
  assert.deepEqual(order, ["alert", "best-effort"]);
  assert.equal(readPeriodicState(store, "entretien").consecutiveFailures, 2, "l'état est écrit malgré le best-effort");
  assert.ok(logs.some((l) => /miroir mort/.test(l)));
});

test("tick : un état non écrit n'empêche pas l'alerte", async () => {
  const store = memStore();
  const events: PeriodicEvent[] = [];
  await periodicTick(
    spec(store, {
      events,
      writeState: () => {
        throw new Error("disque plein");
      },
      evaluate: ({ nowMs }) => ({ nextState: { lastRunMs: nowMs, consecutiveFailures: 1, pausedUntilMs: 0 }, shouldWake: true, wakeNote: "à dire" }),
    }),
  );
  assert.equal(events.length, 1);
});

test("tick : verrou en vol — un second passage concurrent passe son tour, puis le verrou se libère", async () => {
  const store = memStore();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const premier = periodicTick(spec(store, { run: async () => (await gate, { ok: true }) }));
  await new Promise((r) => setImmediate(r));
  const second = await periodicTick(spec(store, { force: true }));
  assert.deepEqual(second, { ran: false, reason: "in-flight" });
  release();
  await premier;
  const apres = await periodicTick(spec(store, { force: true }));
  assert.equal(apres.ran, true);
});

test("tick : le verrou se libère même si le travail lève", async () => {
  const store = memStore();
  await periodicTick(spec(store, { run: async () => { throw new Error("x"); } }));
  const r = await periodicTick(spec(store, { force: true }));
  assert.equal(r.ran, true);
});

test("tick : blockingKind — un job qui menace ce runner le fait taire ; sans blockingKind, non", async () => {
  const bloque = memStore(true);
  assert.deepEqual(await periodicTick(spec(bloque, { blockingKind: "data-backup" })), { ran: false, reason: "job-running" });
  assert.equal((await periodicTick(spec(bloque))).ran, true);
});

test("tick : stampBeforeRun pose l'horodatage avant le travail ; precheck {skip} ne compte aucun échec", async () => {
  const store = memStore();
  let vu = 0;
  await periodicTick(spec(store, { stampBeforeRun: true, run: async () => ((vu = readPeriodicState(store, "entretien").lastRunMs), { ok: true }) }));
  assert.equal(vu, T);
  const s2 = memStore();
  const r = await periodicTick(spec(s2, { stampBeforeRun: true, precheck: async () => ({ skip: "disque plein" }) }));
  assert.deepEqual(r, { ran: false, reason: "skipped", detail: "disque plein" });
  assert.equal(readPeriodicState(s2, "entretien").consecutiveFailures, 0);
});

test("startPeriodic : forme tick nu, un tick qui lève ne tue pas le process", async () => {
  let n = 0;
  const logs: unknown[][] = [];
  const err = console.error;
  const log = console.log;
  console.error = (...a: unknown[]) => void logs.push(a);
  console.log = () => {};
  try {
    const timer = startPeriodic({
      name: "nu",
      pollMs: 15,
      firstDelayMs: 1,
      tick: async () => {
        n++;
        throw new Error("tick cassé");
      },
    });
    await new Promise((r) => setTimeout(r, 80));
    clearInterval(timer);
  } finally {
    console.error = err;
    console.log = log;
  }
  assert.ok(n >= 2);
  assert.match(String(logs[0]![1]), /tick cassé/);
});

test("cadenceBanner", () => {
  assert.equal(cadenceBanner(6 * 3_600_000, 30 * 60_000), "≤ 1×/6h, check 30min");
});
