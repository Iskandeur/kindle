import { test } from "node:test";
import assert from "node:assert/strict";
import { deadEventOrigin } from "./dead-event-alert.ts";

test("message de l'humain ou lane absente : épisode global, pas de libellé", () => {
  assert.deepEqual(deadEventOrigin(undefined), { key: "dead_event", label: null });
  assert.deepEqual(deadEventOrigin(null), { key: "dead_event", label: null });
  assert.deepEqual(deadEventOrigin({ source: "whatsapp" }), { key: "dead_event", label: null });
  assert.deepEqual(deadEventOrigin({ source: "message" }), { key: "dead_event", label: null });
});

test("chaque canal a SON épisode (deux canaux ne partagent pas de compteur)", () => {
  const a = deadEventOrigin({ source: "cron", sessionChannel: "veille-a" });
  const b = deadEventOrigin({ source: "cron", sessionChannel: "veille-b" });
  assert.notEqual(a.key, b.key);
  assert.equal(a.label, "la veille du canal « veille-a »");
});

test("les clés ne contiennent jamais l'identifiant illimité (jobs, tâches)", () => {
  assert.equal(deadEventOrigin({ jobWake: { jobId: 5 } }).key, deadEventOrigin({ jobWake: { jobId: 6 } }).key);
  assert.equal(deadEventOrigin({ jobWake: { jobId: 5 } }).label, "le rapport du job #5");
  assert.equal(deadEventOrigin({ taskId: "t1" }).key, deadEventOrigin({ taskId: "t2" }).key);
  assert.match(deadEventOrigin({ taskId: "t1" }).label!, /t1/);
});

test("cron et réveil programmé ont chacun leur clé ; le job l'emporte sur le canal", () => {
  assert.equal(deadEventOrigin({ source: "cron" }).key, "dead_event:cron");
  assert.equal(deadEventOrigin({ source: "wake" }).key, "dead_event:wake");
  assert.equal(deadEventOrigin({ jobWake: { jobId: 1 }, sessionChannel: "c" }).key, "dead_event:job");
});

test("toute lane de fond a un libellé : jamais annoncée comme « un de tes messages »", () => {
  for (const lane of [{ source: "cron" }, { source: "wake" }, { taskId: "t" }, { sessionChannel: "c" }, { jobWake: { jobId: 1 } }]) {
    assert.notEqual(deadEventOrigin(lane).label, null);
  }
});
