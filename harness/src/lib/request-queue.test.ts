import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextSlot, decideOnRequest, runnerAlive, BATCH_MS, sendText, singleRequestText, okNumbers, passFile,
  bodyShowsAct, requestBody, type QueueRow,
} from "./request-queue.ts";
import { parseQuietHours } from "./quiet-hours.ts";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const normal = { mode: "normal" as const };
const away = { mode: "absent" as const };

test("nextSlot : libre, paquet de 15 min, absent", () => {
  assert.equal(nextSlot({ now: NOW, modeState: normal, lastSent: null }).when, NOW);
  assert.equal(nextSlot({ now: NOW, modeState: normal, lastSent: NOW - 60_000 }).when, NOW - 60_000 + BATCH_MS);
  assert.equal(nextSlot({ now: NOW, modeState: normal, lastSent: NOW - BATCH_MS - 1 }).when, NOW);
  const a = nextSlot({ now: NOW, modeState: away, lastSent: null });
  assert.equal(a.when, null);
  assert.match(a.reason, /ton retour/);
});

test("nextSlot : heures calmes optionnelles retiennent jusqu'à leur fin", () => {
  const q = parseQuietHours("23:00-07:00 UTC");
  const night = Date.parse("2026-10-10T02:10:00Z");
  const s = nextSlot({ now: night, modeState: normal, lastSent: null, quietHours: q });
  assert.ok(s.when! >= Date.parse("2026-10-10T07:00:00Z") && s.when! <= Date.parse("2026-10-10T07:15:00Z"));
  assert.equal(nextSlot({ now: NOW, modeState: normal, lastSent: null, quietHours: q }).when, NOW);
});

test("decideOnRequest : urgente, première, file non vide, coupée", () => {
  const base = { now: NOW, modeState: normal, lastSent: null, urgent: false, active: true, queueNotEmpty: false };
  assert.equal(decideOnRequest(base).now, true);
  assert.equal(decideOnRequest({ ...base, active: false }).now, true);
  assert.equal(decideOnRequest({ ...base, modeState: away, urgent: true }).now, true);
  const second = decideOnRequest({ ...base, lastSent: NOW - 5 * 60_000 });
  assert.equal(second.now, false);
  assert.equal(second.next, NOW + 10 * 60_000);
  const joined = decideOnRequest({ ...base, queueNotEmpty: true });
  assert.equal(joined.now, false);
  assert.match(joined.reason, /rejoint/);
  assert.equal(decideOnRequest({ ...base, modeState: away }).next, null);
});

test("runnerAlive : frais, périmé, futur lointain, null", () => {
  assert.ok(runnerAlive(NOW - 60_000, NOW));
  assert.ok(!runnerAlive(NOW - 6 * 60_000, NOW));
  assert.ok(!runnerAlive(NOW + 3_600_000, NOW));
  assert.ok(!runnerAlive(null, NOW));
});

test("texte : une seule demande garde son pouce, un paquet demande « ok N »", () => {
  const one = sendText([{ id: 7, kind: "reversible", body: "corps" }]);
  assert.match(one, /Réagis/);
  assert.match(singleRequestText(8, "destructive", "x"), /une réaction ne suffit pas/);
  const many = sendText([{ id: 7, kind: "reversible", body: "a" }, { id: 8, kind: "destructive", body: "b" }]);
  assert.match(many, /2 demandes/);
  assert.match(many, /ok 7 8/);
  assert.match(many, /une réaction[^.]*ne décide rien/);
  assert.throws(() => sendText([]));
});

test("okNumbers", () => {
  assert.deepEqual(okNumbers("ok 12"), [12]);
  assert.deepEqual(okNumbers("OK #12, 13 12"), [12, 13]);
  assert.equal(okNumbers("ok"), null);
  assert.equal(okNumbers("ok 12 merci"), null);
});

const row = (id: number, over: Partial<QueueRow> = {}): QueueRow => ({
  requestId: id, body: `corps ${id}`, kind: "reversible", status: "pending", createdAt: NOW - 1000, command: null, ...over,
});

function harness(queue: QueueRow[], over: Record<string, unknown> = {}) {
  const log = { dropped: [] as Array<[number[], string]>, texts: [] as string[], marked: [] as unknown[] };
  const deps = {
    now: NOW, modeState: normal, queue, lastSent: null, expiryMs: 3_600_000,
    drop: (ids: number[], r: string) => log.dropped.push([ids, r]),
    send: async (t: string) => { log.texts.push(t); return "msg-1"; },
    markSent: (...a: unknown[]) => log.marked.push(a),
    ...over,
  };
  return { deps, log };
}

test("passFile : écarte fermées et périmées, envoie le reste en un message", async () => {
  const { deps, log } = harness([row(1, { status: "approved" }), row(2, { createdAt: NOW - 2 * 3_600_000 }), row(3), row(4)]);
  const r = await passFile(deps);
  assert.deepEqual(r.dropped, [1, 2]);
  assert.deepEqual(r.sent, [3, 4]);
  assert.equal(log.texts.length, 1);
  assert.deepEqual(log.marked[0], [[3, 4], NOW, "msg-1", true]);
});

test("passFile : en attente en mode absent ou dans le paquet, rien n'est envoyé", async () => {
  const a = harness([row(1)], { modeState: away });
  assert.match((await passFile(a.deps)).waiting!, /retour/);
  assert.equal(a.log.texts.length, 0);
  const b = harness([row(1)], { lastSent: NOW - 60_000 });
  assert.match((await passFile(b.deps)).waiting!, /prochain envoi/);
});

test("passFile : le corps qui ne montre plus l'acte enregistré n'est pas envoyé", async () => {
  const body = requestBody("desc", null, "rm -rf /tmp/x");
  assert.ok(bodyShowsAct({ body, command: "rm -rf /tmp/x" }));
  const { deps, log } = harness([row(1, { body, command: "rm -rf /tmp/x" }), row(2, { body: "desc", command: "git push" })]);
  const r = await passFile(deps);
  assert.deepEqual(r.dropped, [2]);
  assert.deepEqual(r.sent, [1]);
  assert.equal(log.marked.length, 1);
});

test("passFile : erreur d'envoi remonte sans marquer, id absent signalé", async () => {
  const { deps, log } = harness([row(1)], { send: async () => { throw new Error("réseau"); } });
  await assert.rejects(passFile(deps), /réseau/);
  assert.equal(log.marked.length, 0);
  const n = harness([row(1)], { send: async () => null });
  assert.equal((await passFile(n.deps)).noId, true);
  assert.deepEqual((await passFile(harness([]).deps)).sent, []);
});
