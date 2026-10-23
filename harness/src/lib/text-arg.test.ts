import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pointsToFile, textFromArgs } from "./text-arg.ts";

test("pointsToFile : chemin, extension, tag seul, espace", () => {
  assert.ok(pointsToFile("@/tmp/c.txt"));
  assert.ok(pointsToFile("@./c"));
  assert.ok(pointsToFile("@reponse.txt"));
  assert.ok(pointsToFile("@c.md"));
  assert.ok(!pointsToFile("@alice"));
  assert.ok(!pointsToFile("@a b.txt"));
  assert.ok(!pointsToFile("pas-un-fichier.txt"));
});

test("textFromArgs : inline, fichier réel, vide, illisible", () => {
  const dir = mkdtempSync(join(tmpdir(), "text-arg-"));
  const f = join(dir, "c.txt");
  writeFileSync(f, "  contenu\nsur deux lignes \n");
  const read = (p: string) => readFileSync(p, "utf8");
  assert.deepEqual(textFromArgs(["bonjour", "le", "monde"], read), { ok: true, text: "bonjour le monde", file: null });
  assert.deepEqual(textFromArgs([`@${f}`], read), { ok: true, text: "contenu\nsur deux lignes", file: f });
  assert.deepEqual(textFromArgs(["@alice"], read), { ok: true, text: "@alice", file: null });
  const empty = join(dir, "vide.txt");
  writeFileSync(empty, " \n");
  const r = textFromArgs([`@${empty}`], read);
  assert.ok(!r.ok && /vide/.test(r.reason));
  const missing = textFromArgs([`@${join(dir, "absent.txt")}`], read);
  assert.ok(!missing.ok && /illisible \(ENOENT\)/.test(missing.reason));
  assert.ok(!textFromArgs(["  "], read).ok);
  // deux arguments dont un en @ : jamais lu comme un fichier
  assert.deepEqual(textFromArgs([`@${f}`, "suite"], read), { ok: true, text: `@${f} suite`, file: null });
});
