import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOUCLE_MIN, COMMANDE_LONGUE_MS, SILENCE_MS, cleAppel, detecter, nouveauxSignaux, relever,
  type Blocage,
} from "./job-stall.ts";

const T0 = Date.parse("2026-01-01T10:00:00Z");
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
const use = (id: string, offsetMs: number, name = "Bash", input: unknown = { command: "npm test" }): string =>
  JSON.stringify({ timestamp: iso(offsetMs), message: { content: [{ type: "tool_use", id, name, input }] } });
const res = (id: string, offsetMs: number, isError = false): string =>
  JSON.stringify({ timestamp: iso(offsetMs), message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError }] } });

test("cleAppel : espaces et chiffres sont normalisés, l'outil distingue", () => {
  assert.equal(cleAppel("Bash", { command: "ls  /tmp/12" }), cleAppel("Bash", { command: "ls /tmp/99" }));
  assert.notEqual(cleAppel("Bash", { command: "ls" }), cleAppel("Read", { command: "ls" }));
});

test("relever : appels, résultats, attente, lignes illisibles sautées", () => {
  const r = relever([use("a", 0), "pas du json", "", res("a", 1000), use("b", 2000)]);
  assert.equal(r.appels, 2);
  assert.equal(r.resultats.length, 1);
  assert.deepEqual(r.enAttente.map((a) => a.id), ["b"]);
  assert.equal(r.dernierAt, T0 + 2000);
});

test("commande-longue : un tool_use sans résultat au-delà du seuil", () => {
  const r = relever([use("a", 0)]);
  assert.deepEqual(detecter(r, T0 + COMMANDE_LONGUE_MS - 1, T0), []);
  const b = detecter(r, T0 + COMMANDE_LONGUE_MS, T0);
  assert.equal(b.length, 1);
  assert.equal(b[0]!.genre, "commande-longue");
});

test("silence : rien en attente et plus d'activité ; pas de silence si une commande est en attente", () => {
  const r = relever([use("a", 0), res("a", 1000)]);
  assert.deepEqual(detecter(r, T0 + 1000 + SILENCE_MS - 1, T0), []);
  assert.equal(detecter(r, T0 + 1000 + SILENCE_MS, T0)[0]!.genre, "silence");
  assert.equal(detecter(relever([]), T0 + SILENCE_MS, T0)[0]!.genre, "silence");
});

test("boucle-echecs : N erreurs de suite sur la même clé, un succès intercalé casse la série", () => {
  const lignes: string[] = [];
  for (let i = 0; i < BOUCLE_MIN; i++) lignes.push(use(`u${i}`, i * 10, "Bash", { command: `make ${i}` }), res(`u${i}`, i * 10 + 1, true));
  assert.ok(detecter(relever(lignes), T0 + 100, T0).some((x) => x.genre === "boucle-echecs"));
  const casse = [...lignes.slice(0, 2), use("ok", 50, "Bash", { command: "make 0" }), res("ok", 51, false), ...lignes.slice(2)];
  assert.ok(!detecter(relever(casse), T0 + 100, T0).some((x) => x.genre === "boucle-echecs"));
});

test("nouveauxSignaux : une alerte par (job, genre), ré-armée quand le signal disparaît", () => {
  const b: Blocage = { genre: "silence", detail: "x", depuis: 0 };
  const p1 = nouveauxSignaux({ j1: [b] }, {});
  assert.equal(p1.neufs.length, 1);
  const p2 = nouveauxSignaux({ j1: [b] }, p1.apres);
  assert.equal(p2.neufs.length, 0);
  const p3 = nouveauxSignaux({ j1: [] }, p2.apres);
  assert.deepEqual(p3.apres, {});
  assert.equal(nouveauxSignaux({ j1: [b] }, p3.apres).neufs.length, 1);
});
