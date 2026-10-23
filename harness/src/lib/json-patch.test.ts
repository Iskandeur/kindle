import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch, patchJsonFile } from "./json-patch.ts";

test("set crée les niveaux manquants et n'altère pas l'original", () => {
  const input = { a: 1 };
  const out = applyPatch(input, { set: { "x.y.z": 2 } }) as Record<string, unknown>;
  assert.deepEqual(out, { a: 1, x: { y: { z: 2 } } });
  assert.deepEqual(input, { a: 1 });
});

test("appendUnique : crée le tableau, ne duplique pas (comparaison structurelle)", () => {
  const out = applyPatch({ p: { allow: ["a", { k: 1 }] } }, { appendUnique: { "p.allow": ["a", { k: 1 }, "b"], "q.list": ["z"] } });
  assert.deepEqual(out, { p: { allow: ["a", { k: 1 }, "b"] }, q: { list: ["z"] } });
});

test("unset : retire une clé, idempotent sur une clé absente", () => {
  const out = applyPatch({ s: { a: 1, b: 2 } }, { unset: ["s.a", "s.zz", "nope.deep"] });
  assert.deepEqual(out, { s: { b: 2 } });
});

test("chemin invalide ou dangereux : refusé", () => {
  assert.throws(() => applyPatch({}, { set: { "a..b": 1 } }), /invalide/);
  assert.throws(() => applyPatch({}, { set: { "__proto__.x": 1 } }), /refusé/);
  assert.throws(() => applyPatch({}, { appendUnique: { "a.constructor": [1] } }), /refusé/);
  assert.equal(({} as Record<string, unknown>).x, undefined);
});

function setup(content: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "jsonpatch-"));
  const file = join(dir, "settings.json");
  writeFileSync(file, content);
  return { dir, file };
}

test("patchJsonFile : dry-run n'écrit rien, rend avant/après", () => {
  const { file } = setup('{"a":1}');
  const r = patchJsonFile(file, { set: { b: 2 } });
  assert.equal(r.status, "dry-run");
  assert.equal(readFileSync(file, "utf8"), '{"a":1}');
});

test("patchJsonFile : déjà appliqué => unchanged", () => {
  const { file } = setup(JSON.stringify({ a: 1 }, null, 2) + "\n");
  assert.equal(patchJsonFile(file, { set: { a: 1 } }, { apply: true }).status, "unchanged");
});

test("patchJsonFile : apply sans autorisation ou refusée => refus, fichier intact", () => {
  const { file } = setup('{"a":1}');
  assert.equal(patchJsonFile(file, { set: { b: 2 } }, { apply: true }).status, "refused");
  const r = patchJsonFile(file, { set: { b: 2 } }, { apply: true, authorize: () => ({ ok: false, reason: "pas de 👍" }) });
  assert.deepEqual(r, { status: "refused", reason: "pas de 👍" });
  assert.equal(readFileSync(file, "utf8"), '{"a":1}');
});

test("patchJsonFile : l'autorisation reçoit le chemin résolu ; apply écrit, sauvegarde et consomme", () => {
  const { dir, file } = setup('{"a":1}');
  let recu = "";
  let consomme = 0;
  const r = patchJsonFile(file, { set: { b: 2 } }, {
    apply: true,
    now: () => 42,
    authorize: (p) => {
      recu = p;
      return { ok: true, consume: () => (consomme++, true) };
    },
  });
  assert.equal(r.status, "applied");
  assert.ok(recu.endsWith("settings.json"));
  assert.equal(consomme, 1);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: 1, b: 2 });
  assert.ok(readdirSync(dir).includes("settings.json.bak-42"));
  assert.equal(readFileSync(join(dir, "settings.json.bak-42"), "utf8"), '{"a":1}');
});

test("patchJsonFile : une approbation déjà consommée ailleurs refuse", () => {
  const { file } = setup('{"a":1}');
  const r = patchJsonFile(file, { set: { b: 2 } }, { apply: true, authorize: () => ({ ok: true, consume: () => false }) });
  assert.equal(r.status, "refused");
  assert.equal(readFileSync(file, "utf8"), '{"a":1}');
});

test("patchJsonFile : cible absente ou non JSON => error", () => {
  const { dir, file } = setup("pas du json");
  assert.equal(patchJsonFile(join(dir, "absent.json"), {}).status, "error");
  assert.equal(patchJsonFile(file, { set: { a: 1 } }).status, "error");
});
