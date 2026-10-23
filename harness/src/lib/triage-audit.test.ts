import { test } from "node:test";
import assert from "node:assert/strict";
import { p0Criterion, classedLow, suspiciousSilence, morningLines, wholeWord, JOBS_TO_COUNT_AS_WORKING, type TicketView } from "./triage-audit.ts";

const NOW = Date.parse("2026-10-10T08:00:00Z");
const t = (over: Partial<TicketView>): TicketView => ({ key: "T-1", title: "x", priority: "P2", created_by: "agent/triage", created_at: NOW - 3_600_000, status: "open", ...over });

test("wholeWord : accents compris, pas de sous-chaîne", () => {
  const re = wholeWord("échéance|down");
  assert.ok(re.test("Une échéance demain"));
  assert.ok(re.test("serveur DOWN"));
  assert.ok(!re.test("downtown"));
  assert.ok(!re.test("préchéancier"));
});

test("p0Criterion : un titre par critère, rien sinon", () => {
  assert.equal(p0Criterion("Le serveur ne répond plus"), "panne");
  assert.equal(p0Criterion("Facture à régler avant 18h"), "échéance"); // le premier critère de la table qui mord
  assert.equal(p0Criterion("Facture de 120 €"), "argent");
  assert.equal(p0Criterion("Clé API visible dans le dépôt"), "fuite");
  assert.equal(p0Criterion("Port ouvert sur la machine"), "service exposé");
  assert.equal(p0Criterion("Ranger les photos"), null);
  assert.equal(p0Criterion("anything", [["tout", /any/]]), "tout");
});

test("classedLow : fenêtre, auteur, priorité, statut", () => {
  const list = [
    t({ key: "A", title: "Panne du serveur" }),
    t({ key: "B", title: "Panne du serveur", priority: "P0" }),
    t({ key: "C", title: "Panne du serveur", created_by: "human" }),
    t({ key: "D", title: "Panne du serveur", created_at: NOW - 48 * 3_600_000 }),
    t({ key: "E", title: "Panne du serveur", status: "done" }),
    t({ key: "F", title: "Ranger les photos" }),
    t({ key: "G", title: "Fuite de données clients", priority: null }),
  ];
  const r = classedLow(list, NOW, { agentPrefix: "agent" });
  assert.deepEqual(r.map((x) => [x.key, x.criterion]), [["A", "panne"], ["G", "fuite"]]);
  assert.equal(classedLow(list, NOW, { agentPrefix: "agent", windowMs: 60_000 }).length, 0);
});

test("suspiciousSilence : seuil de jobs, demandes, tickets", () => {
  const base = { jobs24h: JOBS_TO_COUNT_AS_WORKING, requests24h: 0, ticketsForHuman24h: 0 };
  assert.match(suspiciousSilence(base)!, /Silence suspect : 5 jobs/);
  assert.equal(suspiciousSilence({ ...base, jobs24h: 4 }), null);
  assert.equal(suspiciousSilence({ ...base, requests24h: 1 }), null);
  assert.equal(suspiciousSilence({ ...base, ticketsForHuman24h: 1 }), null);
  assert.ok(suspiciousSilence({ ...base, jobs24h: 2, minJobs: 2 }));
});

test("morningLines : rien, silence, plafond d'affichage", () => {
  assert.deepEqual(morningLines(null, []), ["rien"]);
  const low = Array.from({ length: 5 }, (_, i) => ({ ...t({ key: `K${i}`, title: "Panne" }), criterion: "panne" }));
  const lines = morningLines("silence", low, 3);
  assert.equal(lines.length, 5);
  assert.equal(lines[0], "silence");
  assert.match(lines[1], /K0 « Panne » : classé P2, touche « panne »/);
  assert.equal(lines[4], "+2 autre(s) classé(s) bas");
});
