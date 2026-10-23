import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_GATE_TTL_MS,
  actFingerprint,
  checkApprovalGate,
  isApprovingVerdict,
  patchFingerprint,
  sendFingerprint,
  type GateRow,
} from "./approval-gate.ts";

const NOW = 1_800_000_000_000;
const fp = sendFingerprint("33600000000@c.us", "Bonjour");
const base = (o: Partial<GateRow> = {}): GateRow => ({
  id: 7,
  status: "decided",
  fingerprint: fp,
  verdict: "\u{1F44D}",
  verdict_at: NOW - 60_000,
  consumed_at: null,
  ...o,
});

test("isApprovingVerdict : pouce (teintes comprises) et « ok », rien d'autre", () => {
  assert.equal(isApprovingVerdict("\u{1F44D}"), true);
  assert.equal(isApprovingVerdict("\u{1F44D}\u{1F3FD}"), true);
  assert.equal(isApprovingVerdict("\u{1F44D}\u{FE0F}"), true);
  assert.equal(isApprovingVerdict(" OK "), true);
  assert.equal(isApprovingVerdict("\u{1F64F}"), false);
  assert.equal(isApprovingVerdict("\u{1F44E}"), false);
  assert.equal(isApprovingVerdict("ok bof"), false);
  assert.equal(isApprovingVerdict(null), false);
  assert.equal(isApprovingVerdict(""), false);
});

test("empreintes : destination, texte, fichier et patch comptent", () => {
  assert.equal(sendFingerprint("a", "x\r\n"), sendFingerprint("a", "x"));
  assert.notEqual(sendFingerprint("a", "x"), sendFingerprint("b", "x"));
  assert.notEqual(sendFingerprint("a", "x"), sendFingerprint("a", "y"));
  assert.notEqual(patchFingerprint("/etc/a.json", { set: { a: 1 } }), patchFingerprint("/etc/b.json", { set: { a: 1 } }));
  assert.notEqual(patchFingerprint("/etc/a.json", { set: { a: 1 } }), patchFingerprint("/etc/a.json", { set: { a: 2 } }));
  assert.notEqual(actFingerprint("publish", "deploy"), actFingerprint("merge", "deploy"));
  assert.equal(actFingerprint("publish", "deploy\n"), actFingerprint("publish", "deploy"));
});

test("checkApprovalGate : le chemin heureux", () => {
  assert.deepEqual(checkApprovalGate(base(), fp, NOW), { ok: true });
});

test("checkApprovalGate : chaque refus nomme sa raison", () => {
  const refus = (row: GateRow | null, expected = fp): string => {
    const d = checkApprovalGate(row, expected, NOW);
    assert.equal(d.ok, false);
    return d.ok ? "" : d.reason;
  };
  assert.match(refus(null), /introuvable/);
  assert.match(refus(base({ fingerprint: null })), /aucun acte/);
  assert.match(refus(base(), sendFingerprint("33600000000@c.us", "Bonjour !")), /pas ce qui a été validé/);
  assert.match(refus(base({ status: "cancelled" })), /fermée/);
  assert.match(refus(base({ status: "superseded" })), /fermée/);
  assert.match(refus(base({ verdict: null, verdict_at: null })), /aucune décision/);
  assert.match(refus(base({ verdict: "\u{1F64F}" })), /pas un pouce/);
  assert.match(refus(base({ consumed_at: NOW - 1000 })), /déjà servi/);
  assert.match(refus(base({ verdict_at: NOW - APPROVAL_GATE_TTL_MS - 1 })), /au-delà/);
  assert.match(refus(base({ verdict_at: null })), /au-delà/);
});

test("checkApprovalGate : l'empreinte est testée avant le statut (un autre acte n'emprunte pas une demande fermée)", () => {
  const d = checkApprovalGate(base({ status: "cancelled" }), "autre", NOW);
  assert.equal(d.ok, false);
  assert.match(d.ok ? "" : d.reason, /pas ce qui a été validé/);
});

test("checkApprovalGate : un TTL réduit s'applique", () => {
  assert.equal(checkApprovalGate(base({ verdict_at: NOW - 120_000 }), fp, NOW, 60_000).ok, false);
  assert.equal(checkApprovalGate(base({ verdict_at: NOW - 30_000 }), fp, NOW, 60_000).ok, true);
});
