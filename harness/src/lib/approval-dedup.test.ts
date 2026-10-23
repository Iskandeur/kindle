import { test } from "node:test";
import assert from "node:assert/strict";
import { cibleParDefaut, demandeRemplacee, memeEtat, verdictCreation, type VivanteRow } from "./approval-dedup.ts";

const row = (id: number, o: Partial<VivanteRow> = {}): VivanteRow => ({
  id,
  status: "pending",
  consumed_at: null,
  fingerprint: null,
  command: null,
  ...o,
});

test("cibleParDefaut : lit la cible et l'état, ou rien", () => {
  assert.deepEqual(cibleParDefaut("merge Org/Repo#12 at ABCDEF1234 (sensible)"), { cible: "org/repo#12", etat: "abcdef1234" });
  assert.equal(cibleParDefaut("autre chose"), null);
  assert.equal(cibleParDefaut(null), null);
});

test("memeEtat : un sha court est le préfixe du long", () => {
  assert.equal(memeEtat("abcdef1", "abcdef1234567"), true);
  assert.equal(memeEtat("abcdef1", "1234567"), false);
});

test("doublon : une demande vivante à la même empreinte rend SON numéro (la plus récente)", () => {
  const v = verdictCreation([row(3, { fingerprint: "f" }), row(5, { fingerprint: "f" }), row(6, { fingerprint: "g" })], "f", null);
  assert.deepEqual(v, { type: "doublon", id: 5 });
});

test("doublon : une demande servie ou fermée n'en est pas un", () => {
  const v = verdictCreation([row(3, { fingerprint: "f", consumed_at: 1 }), row(4, { fingerprint: "f", status: "decided" })], "f", null);
  assert.deepEqual(v, { type: "creer", perimees: [] });
});

test("sans empreinte, jamais de doublon", () => {
  assert.deepEqual(verdictCreation([row(1, { fingerprint: "f" })], null, null), { type: "creer", perimees: [] });
});

test("péremption : même PR, autre commit => superseded ; même commit ou autre PR => non", () => {
  const vivantes = [
    row(1, { command: "merge o/r#9 at aaaaaaa1111" }),
    row(2, { command: "merge o/r#9 at bbbbbbb2222" }),
    row(3, { command: "merge o/r#10 at ccccccc3333" }),
    row(4, { command: "merge o/r#9 at ddddddd4444", status: "decided" }),
  ];
  const v = verdictCreation(vivantes, "neuve", "merge o/r#9 at bbbbbbb2222ffff");
  assert.deepEqual(v, { type: "creer", perimees: [1] });
});

test("extracteur injecté : un autre format de commande", () => {
  const ext = (c: string | null) => {
    const m = /^deploy (\w+) v(\d+)$/.exec(c ?? "");
    return m ? { cible: m[1], etat: m[2] } : null;
  };
  const v = verdictCreation([row(1, { command: "deploy web v1" }), row(2, { command: "deploy api v1" })], null, "deploy web v2", ext);
  assert.deepEqual(v, { type: "creer", perimees: [1] });
});

test("demandeRemplacee : la plus récente non servie, même cible, autre état", () => {
  const ant = [
    { id: 1, status: "superseded", verdict: null, consumed_at: null, command: "merge o/r#9 at aaaaaaa1111" },
    { id: 2, status: "superseded", verdict: "\u{1F44D}", consumed_at: null, command: "merge o/r#9 at bbbbbbb2222" },
    { id: 3, status: "decided", verdict: "\u{1F44D}", consumed_at: 5, command: "merge o/r#9 at ccccccc3333" },
  ];
  assert.equal(demandeRemplacee(ant, "merge o/r#9 at ddddddd4444")?.id, 2);
  assert.equal(demandeRemplacee(ant, "merge o/r#8 at ddddddd4444"), null);
  assert.equal(demandeRemplacee(ant, "rien"), null);
});
