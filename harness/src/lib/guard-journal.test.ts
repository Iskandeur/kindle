import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decisionDeSortie, ecrireLigneSerrure, empreinte, ligneApprovalGate, tracerApprovalGate, tronquerRaison } from "./guard-journal.ts";

test("decisionDeSortie : deny avec sa raison, allow, ou laisse", () => {
  const deny = JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: 'refus "net"' } });
  assert.deepEqual(decisionDeSortie(deny), { decision: "deny", raison: 'refus "net"' });
  assert.equal(decisionDeSortie('{"permissionDecision":"allow"}').decision, "allow");
  assert.deepEqual(decisionDeSortie(""), { decision: "laisse", raison: "" });
});

test("tronquerRaison : la queue « — règles : … » survit", () => {
  const longue = `${"x".repeat(400)} — règles : email, ip`;
  const t = tronquerRaison(longue, 100);
  assert.ok(t.length <= 100);
  assert.ok(t.endsWith(" — règles : email, ip"));
  assert.ok(t.includes("…"));
  assert.equal(tronquerRaison("court", 100), "court");
  assert.equal(tronquerRaison("y".repeat(300), 50).length, 50);
});

test("tronquerRaison : une queue plus longue que la borne est elle-même coupée", () => {
  const t = tronquerRaison(`a — chemins sensibles : ${"z".repeat(300)}`, 40);
  assert.ok(t.length <= 40);
  assert.ok(t.startsWith("…"));
});

test("empreinte : 16 hex, stable, sans la valeur", () => {
  const e = empreinte({ cmd: "secret-value" });
  assert.match(e, /^[0-9a-f]{16}$/);
  assert.equal(e, empreinte({ cmd: "secret-value" }));
  assert.notEqual(e, empreinte({ cmd: "autre" }));
  assert.ok(!e.includes("secret"));
});

test("ligneApprovalGate : allow/deny, raison aplatie et bornée", () => {
  const l = ligneApprovalGate({ porte: "patch-json", demande: 4, acte: "abc", ok: false, raison: "a\n  b   c", at: 9 });
  assert.equal(l.decision, "deny");
  assert.equal(l.raison, "a b c");
  assert.equal(l.serrure, "approval-gate");
  assert.equal(ligneApprovalGate({ porte: "p", demande: null, acte: "a", ok: true, raison: "ok", at: 1 }).decision, "allow");
  assert.equal(ligneApprovalGate({ porte: "p", demande: 1, acte: "a", ok: false, raison: "r".repeat(500), at: 1 }).raison.length, 200);
});

test("tracerApprovalGate écrit une ligne JSON ; un chemin impossible ne lève pas", () => {
  const dir = mkdtempSync(join(tmpdir(), "guardj-"));
  const f = join(dir, "sous", "serrures.jsonl");
  tracerApprovalGate({ porte: "x", demande: 1, acte: "a", ok: true, raison: "bon" }, f, () => 123);
  const lignes = readFileSync(f, "utf8").trim().split("\n");
  assert.equal(lignes.length, 1);
  assert.equal(JSON.parse(lignes[0]).at, 123);
  assert.doesNotThrow(() => ecrireLigneSerrure({ at: 1, serrure: "s", outil: "o", decision: "deny", raison: "r", empreinte: "e" }, join(f, "impossible", "x.jsonl")));
});
