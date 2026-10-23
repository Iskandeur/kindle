import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chainIdForDate, isIntermediatePhase, clipPhaseSummary, summarizePriorPhases, phaseParts, buildPhasePrompt,
  reportDestinationText, PHASE_SUMMARY_MAX, type PhaseDef, type PhaseJob,
} from "./phase-chain.ts";

const PHASES: PhaseDef[] = [
  { file: "01.md", label: "Mémoire" },
  { file: "02.md", label: "Amélioration" },
  { file: "03.md", label: "Rapport" },
];

test("chainIdForDate", () => {
  assert.equal(chainIdForDate("2026-10-10"), "dream-2026-10-10");
  assert.equal(chainIdForDate("2026-10-10", "nuit"), "nuit-2026-10-10");
});

test("isIntermediatePhase : toutes sauf la dernière, et seulement dans la chaîne", () => {
  assert.ok(isIntermediatePhase({ chain_kind: "dream", chain_seq: 1 }, 3));
  assert.ok(isIntermediatePhase({ created_by: "dream", chain_seq: 2 }, 3));
  assert.ok(!isIntermediatePhase({ chain_kind: "dream", chain_seq: 3 }, 3));
  assert.ok(!isIntermediatePhase({ chain_kind: "dream", chain_seq: 0 }, 3));
  assert.ok(!isIntermediatePhase({ chain_kind: "dream", chain_seq: null }, 3));
  assert.ok(!isIntermediatePhase({ chain_kind: "autre", chain_seq: 1 }, 3));
  assert.ok(isIntermediatePhase({ chain_kind: "nuit", chain_seq: 1 }, 3, "nuit"));
});

test("clipPhaseSummary : court intact, long gardé début ET fin avec une marque", () => {
  assert.equal(clipPhaseSummary("court"), "court");
  const head = "DEBUT" + "a".repeat(2000);
  const text = `${head}${"b".repeat(1000)}FIN-DETTES`;
  const clipped = clipPhaseSummary(text, "show 12");
  assert.ok(clipped.startsWith("DEBUT"));
  assert.ok(clipped.endsWith("FIN-DETTES"));
  assert.match(clipped, /\[… \d+ caractères coupés ici, le résumé entier : show 12 …\]/);
  assert.ok(clipped.length < PHASE_SUMMARY_MAX + 200);
  assert.doesNotMatch(clipPhaseSummary(text), /le résumé entier/);
});

test("summarizePriorPhases : seulement les phases finies, étiquetées, jamais vide à tort", () => {
  assert.equal(summarizePriorPhases([], PHASES), "");
  const jobs: PhaseJob[] = [
    { id: 1, chain_seq: 1, status: "done", result: "tout va bien" },
    { id: 2, chain_seq: 2, status: "error", result: null },
    { id: 3, chain_seq: 3, status: "running", result: "pas encore" },
    { id: 4, chain_seq: null, status: "done", result: "hors chaîne" },
  ];
  const s = summarizePriorPhases(jobs, PHASES, (j) => `job show ${j.id}`);
  assert.match(s, /### Phase 1 — Mémoire \(fait\)\ntout va bien/);
  assert.match(s, /### Phase 2 — Amélioration \(ÉCHEC\)\n\(pas de résumé\)/);
  assert.doesNotMatch(s, /pas encore|hors chaîne/);
  assert.match(summarizePriorPhases([{ id: 9, chain_seq: 7, status: "done", result: "x" }], PHASES), /phase 7/);
});

test("phaseParts : la destination n'apparaît que sur la dernière phase, les vides sont écartés", () => {
  const common = { phases: PHASES, body: "consigne", summary: "", destination: "DEST", trailer: "CLOTURE", clock: "lundi 05:00" };
  const first = phaseParts({ ...common, seq: 1 });
  assert.deepEqual(first.map((p) => p.id), ["entete", "consigne", "cloture"]);
  assert.match(first[0].text, /phase 1\/3 : Mémoire — lundi 05:00/);
  const last = phaseParts({ ...common, seq: 3, summary: "résumé" });
  assert.deepEqual(last.map((p) => p.id), ["entete", "phases-precedentes", "consigne", "destination", "cloture"]);
  assert.equal(buildPhasePrompt({ ...common, seq: 1 }), "[DREAM — phase 1/3 : Mémoire — lundi 05:00]\n\nconsigne\n\nCLOTURE");
});

test("reportDestinationText : avec et sans canal préféré", () => {
  const a = reportDestinationText({ depositCommand: "deposit --text-file F", preferred: "le canal Rapport", principal: "le chat principal" });
  assert.match(a, /deposit --text-file F/);
  assert.match(a, /code 3/);
  assert.match(a, /dans le canal Rapport, repli sur le chat principal/);
  const b = reportDestinationText({ depositCommand: "x", preferred: null, principal: "le chat principal" });
  assert.match(b, /sur le chat principal/);
  assert.doesNotMatch(b, /repli sur/);
});
