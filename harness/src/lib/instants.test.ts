import { test } from "node:test";
import assert from "node:assert/strict";
import { ageJours, instantMs, instantMsOuNull } from "./instants.ts";

const UN_INSTANT = 1789089511574; // 2026-09-11T01:18:31.574Z
const MAINTENANT = Date.UTC(2026, 8, 14, 8, 0, 0);

test("epoch-ms : nombre ET chaîne de 13 chiffres se lisent pareil", () => {
  assert.equal(instantMs(UN_INSTANT), UN_INSTANT);
  assert.equal(instantMs(String(UN_INSTANT)), UN_INSTANT);
  assert.equal(new Date(instantMs(String(UN_INSTANT))).toISOString(), "2026-09-11T01:18:31.574Z");
});

test("ISO : l'autre monde (les fichiers d'état JSON) se lit aussi", () => {
  assert.equal(instantMs("2026-09-11T01:18:31.574Z"), UN_INSTANT);
});

test("la chaîne de 13 chiffres ne passe pas par Date.parse", () => {
  assert.ok(Number.isNaN(Date.parse(String(UN_INSTANT))), "prémisse du test : Date.parse échoue bien");
  assert.equal(instantMs(String(UN_INSTANT)), UN_INSTANT);
});

test("illisible : ça LÈVE, ça ne rend pas un NaN qui se ferait passer pour une mesure", () => {
  for (const mauvais of ["pas-une-date", "", null, undefined, {}, NaN, Infinity]) {
    assert.throws(() => instantMs(mauvais), /illisible/, `aurait dû lever sur ${JSON.stringify(mauvais)}`);
  }
});

test("hors plage : secondes, 0, négatif et chaînes courtes lèvent au lieu de passer pour des ms", () => {
  for (const mauvais of [1789089511, 0, -5, 1.5, "1", "12", "2026", "2026-09-11 01:18", "2026-09-11T01:18:31"]) {
    assert.throws(() => instantMs(mauvais), /illisible/, `aurait dû lever sur ${JSON.stringify(mauvais)}`);
  }
  assert.equal(instantMs("2026-09-11T03:18:31.574+02:00"), UN_INSTANT);
  assert.equal(instantMs("2026-09-11"), Date.UTC(2026, 8, 11));
});

test("ageJours : le verdict est juste, et une valeur illisible refuse d'en rendre un", () => {
  const j = ageJours(String(UN_INSTANT), MAINTENANT);
  assert.ok(Math.abs(j - 3.28) < 0.02, `attendu ~3,28 j, obtenu ${j}`);
  assert.throws(() => ageJours("1789089511574x", MAINTENANT), /illisible/);
});

test("ouNull : une absence légitime rend null, une valeur présente mais cassée lève quand même", () => {
  assert.equal(instantMsOuNull(null), null);
  assert.equal(instantMsOuNull(undefined), null);
  assert.equal(instantMsOuNull("   "), null);
  assert.equal(instantMsOuNull(UN_INSTANT), UN_INSTANT);
  assert.throws(() => instantMsOuNull("nope"), /illisible/, "présent mais cassé = panne, pas absence");
});
