import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpActText, publicGithubActInBash, publicGithubActInMcp, shellSegments, stripHeredocs } from "./github-visibility.ts";

const kind = (c: string): string | null => publicGithubActInBash(c)?.kind ?? null;

test("gh repo create : public oui, privé non", () => {
  assert.equal(kind("gh repo create mon-depot --public"), "repo-create-public");
  assert.equal(kind("gh repo create mon-depot --visibility=public --source=."), "repo-create-public");
  assert.equal(kind("gh repo create mon-depot --private"), null);
  assert.equal(kind("gh repo create mon-depot"), null);
});

test("gh repo edit / fork / gist", () => {
  assert.equal(kind("gh repo edit o/r --visibility public"), "repo-visibility-public");
  assert.equal(kind("gh repo edit o/r --visibility private"), null);
  assert.equal(kind("gh repo fork o/r"), "fork");
  assert.equal(kind("gh gist create f.txt --public"), "gist-public");
  assert.equal(kind("gh gist create f.txt"), null);
});

test("gh api : champs publics, création sans private=true", () => {
  assert.equal(kind("gh api repos/o/r -X PATCH -f private=false"), "api-public");
  assert.equal(kind("gh api user/repos -f name=x"), "api-public");
  assert.equal(kind("gh api user/repos -f name=x -F private=true"), null);
  assert.equal(kind("gh api repos/o/r/issues"), null);
  assert.equal(kind("gh api -X POST /orgs/acme/repos -f name=x"), "api-public");
});

test("curl vers api.github.com", () => {
  assert.equal(kind("curl -X POST https://api.github.com/user/repos -d '{\"name\":\"x\"}'"), "api-public");
  assert.equal(kind("curl -X PATCH https://api.github.com/repos/o/r -d '{\"private\": false}'"), "api-public");
  assert.equal(kind("curl https://api.github.com/repos/o/r"), null);
});

test("chaîne de commandes, chemin absolu, citation dans un message", () => {
  assert.equal(kind("cd x && /usr/bin/gh repo create y --public"), "repo-create-public");
  assert.equal(kind("git commit -m 'doc : gh repo create --public'"), null);
  assert.equal(kind("echo 'gh repo create --public'"), null);
});

test("here-document : le texte cité n'est pas une commande", () => {
  const cmd = "git commit -F - <<'EOF'\ngh repo create x --public\nEOF";
  assert.equal(kind(cmd), null);
  assert.ok(!stripHeredocs(cmd).includes("--public"));
  assert.equal(kind("cat <<EOF\nok\nEOF\ngh repo create y --public"), "repo-create-public");
});

test("shellSegments : guillemets = un mot, séparateurs hors guillemets", () => {
  assert.deepEqual(shellSegments('a "b c" ; d|e'), [["a", "b c"], ["d"], ["e"]]);
});

test("MCP : création non privée et fork", () => {
  assert.equal(publicGithubActInMcp("create_repository", { name: "x" })?.kind, "repo-create-public");
  assert.equal(publicGithubActInMcp("create_repository", { name: "x", private: true }), null);
  assert.equal(publicGithubActInMcp("fork_repository", {})?.kind, "fork");
  assert.equal(publicGithubActInMcp("get_file_contents", {}), null);
});

test("mcpActText : clés triées, donc stable", () => {
  assert.equal(mcpActText("t", { b: 1, a: 2 }), mcpActText("t", { a: 2, b: 1 }));
  assert.equal(mcpActText("t", { b: 1, a: 2 }), 't {"a":2,"b":1}');
});
