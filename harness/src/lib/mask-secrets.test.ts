import { test } from "node:test";
import assert from "node:assert/strict";
import { MASK, maskSecrets } from "./mask-secrets.ts";

// Faux secrets assemblés à l'exécution : aucun littéral ne ressemble à un vrai jeton dans le dépôt.
const fake = (prefix: string, n: number): string => prefix + "a1B2c3D4e5F6g7H8i9J0".repeat(4).slice(0, n);

test("clés de fournisseurs et jetons Git", () => {
  assert.equal(maskSecrets(`clé ${fake("sk-", 30)} fin`), `clé ${MASK} fin`);
  assert.equal(maskSecrets(`t=${fake("ghp_", 30)}`), `t=${MASK}`);
  assert.equal(maskSecrets(`aws AKIA${"A1B2C3D4E5F6G7H8".slice(0, 16)}`), `aws ${MASK}`);
});

test("JWT, Bearer, mot de passe", () => {
  assert.equal(maskSecrets("eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.sig_abc"), MASK);
  assert.equal(maskSecrets("Authorization: Bearer abcdefghij0123456789"), `Authorization: Bearer ${MASK}`);
  assert.equal(maskSecrets("mot de passe : hunter2"), `mot de passe : ${MASK}`);
  assert.equal(maskSecrets("PASSWORD=hunter2 ok"), `PASSWORD=${MASK} ok`);
});

test("un SHA git (40 hexa) reste lisible, un hexa de 64 est masqué", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(maskSecrets(`commit ${sha}`), `commit ${sha}`);
  assert.equal(maskSecrets(`h ${sha}${sha.slice(0, 24)}`), `h ${MASK}`);
});

test("une longue chaîne base64 mixte est masquée, un chemin ne l'est pas", () => {
  const b64 = "Zm9vQmFyMTIzNDU2Nzg5MEFiQ2RFZkdoSWpLbE1uT3BxUnN0";
  assert.equal(maskSecrets(`x ${b64}`), `x ${MASK}`);
  assert.equal(maskSecrets("/usr/local/lib/node_modules/some/very/long/path/to/a/file/name"), "/usr/local/lib/node_modules/some/very/long/path/to/a/file/name");
});

test("un texte ordinaire passe tel quel", () => {
  const t = "Fusionner la PR #12 au commit abc123 après les tests.";
  assert.equal(maskSecrets(t), t);
});
