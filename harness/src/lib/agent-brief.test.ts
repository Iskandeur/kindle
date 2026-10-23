import { test } from "node:test";
import assert from "node:assert/strict";
import { notebookRules, engineMayRead, briefing, agentIntent, NOTEBOOK_MAX_LINES } from "./agent-brief.ts";

const charter = { mission: "Trier\nles tickets.", droits: ["observer"], sensibilite: "generic", statut: "actif", lecons: ["leçon montée"] };

test("notebookRules : seulement les puces", () => {
  assert.deepEqual(notebookRules("# titre\n- a\ntexte\n- b \n-pas une puce"), ["a", "b"]);
  assert.deepEqual(notebookRules(null), []);
});

test("engineMayRead : un moteur externe ne lit qu'une mémoire generic", () => {
  assert.ok(engineMayRead({ sensibilite: "perso" }, "claude"));
  assert.ok(!engineMayRead({ sensibilite: "perso" }, "externe"));
  assert.ok(engineMayRead({ sensibilite: "generic" }, "externe"));
  assert.ok(!engineMayRead({ sensibilite: "secu" }, "x", ["x"]));
});

test("briefing : statut, extra, tickets tronqués, derniers gestes", () => {
  const t = Array.from({ length: 12 }, (_, i) => ({ key: `T-${i}`, title: `titre ${i}`, status: "open" }));
  const b = briefing({
    statut: "actif", extra: ["ligne extra"], tickets: t,
    journal: [{ at: Date.parse("2026-10-10T08:05:00Z"), acte: "close", key: "T-1", raison: "doublon" }],
  });
  assert.equal(b[0], "Statut : actif.");
  assert.equal(b[1], "ligne extra");
  assert.match(b[2], /… \+2\./);
  assert.ok(b.some((l) => l.includes("10-10 08:05 UTC close T-1 — doublon")));
  assert.ok(briefing({ statut: "s" }).includes("Aucun geste journalisé pour l'instant."));
});

test("agentIntent : sections, leçons avant carnet, voix unique", () => {
  const s = agentIntent({
    id: "triage", name: "Trieur", charter, briefing: ["Statut : actif."], notebook: ["règle 1"],
    thread: ["il a dit X"], task: ["Fais le tri."], mainVoice: "Principal", commands: { wake: "wake.ts --in 1h" },
  });
  assert.match(s, /Tu es Trieur \(`triage`\)/);
  assert.match(s, /Ta mission : Trier les tickets\./);
  assert.ok(s.indexOf("Tes leçons") < s.indexOf("ton carnet"));
  assert.match(s, /- règle 1/);
  assert.match(s, /Une seule voix vers l'humain : Principal/);
  assert.match(s, /wake\.ts --in 1h/);
  assert.match(s, /Ce que j'attends de toi/);
  assert.match(s, /il a dit X/);
});

test("agentIntent : carnet tronqué aux dernières lignes, et non transmis à un moteur externe sensible", () => {
  const many = Array.from({ length: NOTEBOOK_MAX_LINES + 5 }, (_, i) => `r${i}`);
  const s = agentIntent({ id: "a", name: "A", charter, briefing: [], notebook: many, task: [] });
  assert.ok(!s.includes("- r0\n") && s.includes(`- r${NOTEBOOK_MAX_LINES + 4}`));
  const hidden = agentIntent({ id: "a", name: "A", charter: { ...charter, sensibilite: "perso" }, engine: "externe", briefing: [], notebook: ["secret"], task: [] });
  assert.ok(!hidden.includes("secret") && !hidden.includes("leçon montée"));
  assert.match(hidden, /carnet non transmis/);
});
