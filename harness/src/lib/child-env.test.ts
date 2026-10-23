import { test } from "node:test";
import assert from "node:assert/strict";
import { ALWAYS_STRIPPED, createChildEnv, SYSTEM_ENV } from "./child-env.ts";

test("une variable inconnue n'est pas transmise (le repos est le refus)", () => {
  const f = createChildEnv();
  const out = f.env({ PATH: "/usr/bin", HOME: "/h", MY_SECRET_TOKEN: "x", AWS_SECRET_ACCESS_KEY: "y" });
  assert.deepEqual(out, { PATH: "/usr/bin", HOME: "/h" });
});

test("la clé d'API et les plugins de l'appelant sont retirés même si une règle les autorise", () => {
  const f = createChildEnv({ allow: ["ANTHROPIC_API_KEY"], allowPrefixes: ["CLAUDE_CODE_"] });
  const out = f.env({ ANTHROPIC_API_KEY: "sk", CLAUDE_CODE_PLUGIN_DIRS: "/p", CLAUDE_CODE_FOO: "1", PATH: "/bin" });
  assert.deepEqual(out, { CLAUDE_CODE_FOO: "1", PATH: "/bin" });
  for (const k of ALWAYS_STRIPPED) assert.equal(f.allows(k), false);
});

test("les noms et préfixes ajoutés passent, `strip` l'emporte", () => {
  const f = createChildEnv({ allow: ["DATA_DIR", "TOKEN_A"], allowPrefixes: ["APP_"], strip: ["TOKEN_A"] });
  const out = f.env({ DATA_DIR: "/d", TOKEN_A: "a", APP_MODE: "x", LC_ALL: "C", OTHER: "o" });
  assert.deepEqual(out, { DATA_DIR: "/d", APP_MODE: "x", LC_ALL: "C" });
});

test("une valeur undefined est ignorée et l'env d'origine n'est pas modifié", () => {
  const parent: NodeJS.ProcessEnv = { PATH: "/bin", HOME: undefined, SECRET: "s" };
  const out = createChildEnv().env(parent);
  assert.deepEqual(out, { PATH: "/bin" });
  assert.equal(parent.SECRET, "s");
});

test("la liste système ne contient aucun secret évident", () => {
  // MAX_MCP_OUTPUT_TOKENS est un réglage de taille, pas un jeton d'accès.
  for (const k of SYSTEM_ENV) if (k !== "MAX_MCP_OUTPUT_TOKENS") assert.doesNotMatch(k, /KEY|TOKEN|SECRET|PASSWORD/);
});
