import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeControlBytes, findControlBytes } from "./source-hygiene.ts";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

test("tab, LF et CR sont permis", () => {
  assert.deepEqual(findControlBytes(bytes("a\tb\r\nc\n")), []);
});

test("un NUL est trouvé, avec sa ligne et son offset", () => {
  const hits = findControlBytes(new Uint8Array([0x61, 0x0a, 0x62, 0x00, 0x63]));
  assert.deepEqual(hits, [{ offset: 3, byte: 0, line: 2 }]);
});

test("l'échappement écrit en toutes lettres n'est pas un octet NUL", () => {
  assert.deepEqual(findControlBytes(bytes("const x = '\\u0000';")), []);
});

test("max borne le nombre de résultats", () => {
  assert.equal(findControlBytes(new Uint8Array(100), 3).length, 3);
});

test("describeControlBytes : rien si rien, sinon fichier + ligne + octet", () => {
  assert.equal(describeControlBytes("a.ts", []), "");
  const m = describeControlBytes("a.ts", [{ offset: 3, byte: 0x1b, line: 7 }]);
  assert.match(m, /a\.ts/);
  assert.match(m, /0x1b/);
  assert.match(m, /ligne 7/);
});

test("garde appliquée : aucun module de ce dossier ne contient d'octet de contrôle", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (!f.endsWith(".ts") || !statSync(p).isFile()) continue;
    const hits = findControlBytes(readFileSync(p));
    assert.deepEqual(hits, [], describeControlBytes(p, hits));
  }
});
