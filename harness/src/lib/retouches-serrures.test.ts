import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkApprovalGate, sendFingerprint } from "./approval-gate.ts";
import { publicGithubActInBash } from "./github-visibility.ts";
import { patchJsonFile } from "./json-patch.ts";
import { scanText } from "./leak-scan.ts";

const NOW = 1_800_000_000_000;
const fp = sendFingerprint("33600000000@c.us", "Bonjour");
const kind = (c: string): string | null => publicGithubActInBash(c)?.kind ?? null;
// Les fausses valeurs sont assemblées à l'exécution : le dépôt ne contient aucun chemin réel.
const HOME = "/hom" + "e/";
const rules = (text: string): string[] => scanText({ name: "t", text }).map((f) => f.rule);

test("approval-gate : une décision datée du futur est refusée", () => {
  const r = checkApprovalGate({ id: 9, status: "pending", fingerprint: fp, verdict: "👍", verdict_at: NOW + 60_000, consumed_at: null }, fp, NOW);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /futur/);
});

test("github-visibility : -XPOST collé, --method=POST, --request=POST", () => {
  assert.equal(kind("gh api -XPOST user/repos -f name=x"), "api-public");
  assert.equal(kind("gh api --method=POST user/repos -f name=x"), "api-public");
  assert.equal(kind("gh api -XGET user/repos"), null);
  assert.equal(kind("curl -XPOST https://api.github.com/user/repos -d '{\"name\":\"x\"}'"), "api-public");
  assert.equal(kind("curl --request=POST https://api.github.com/user/repos -d '{\"name\":\"x\"}'"), "api-public");
});

test("leak-scan : l'exception gabarit ne vaut que pour le segment de l'utilisateur", () => {
  assert.deepEqual(rules(HOME + "user/projet"), []);
  assert.deepEqual(rules(HOME + "<user>/projet"), []);
  assert.deepEqual(rules(HOME + "jean/example/notes"), ["private-filesystem-path"]);
  assert.deepEqual(rules(HOME + "jean/user.txt"), ["private-filesystem-path"]);
});

test("json-patch : une écriture qui échoue revient en erreur, sans lever, et libère l'approbation", { skip: process.getuid?.() === 0 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "jp-"));
  const f = join(dir, "s.json");
  writeFileSync(f, '{"a":1}');
  let released = false;
  const r = patchJsonFile(f, { set: { b: 2 } }, {
    apply: true,
    authorize: () => ({ ok: true, release: () => (released = true) }),
    // La sauvegarde est écrite dans le dossier : on le ferme juste avant.
    now: () => (chmodSync(dir, 0o555), 1),
  });
  chmodSync(dir, 0o755);
  assert.equal(r.status, "error");
  assert.equal(released, true);
  assert.equal(readFileSync(f, "utf8"), '{"a":1}');
});
