import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkWipMerge,
  formatWipCheck,
  gitCallIn,
  parseDiffU0,
  parseMergeTree,
  parseShortStat,
  revertedLines,
  wipCheckAlarms,
  wipCheckVerdictLine,
} from "./wip-merge-check.ts";

test("parseDiffU0 : lignes par chemin, '--- ' dans un bloc n'est pas un en-tête", () => {
  const diff = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,2 +1,2 @@",
    "--- trait retiré",
    "+nouveau",
    "diff --git a/n.txt b/n.txt",
    "--- /dev/null",
    "+++ b/n.txt",
    "@@ -0,0 +1 @@",
    "+tout neuf",
    "diff --git a/d.txt b/d.txt",
    "--- a/d.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-disparu",
  ].join("\n");
  const m = parseDiffU0(diff);
  assert.deepEqual(m.get("a.txt"), { added: ["nouveau"], removed: ["-- trait retiré"] });
  assert.deepEqual(m.get("n.txt"), { added: ["tout neuf"], removed: [] });
  assert.deepEqual(m.get("d.txt"), { added: [], removed: ["disparu"] });
});

test("revertedLines : multiensemble, lignes courtes écartées, tri par ampleur", () => {
  const arrived = new Map([
    ["a", ["ligne importante", "ligne importante", "}", "autre ligne  "]],
    ["b", ["unique chose"]],
  ]);
  const removed = new Map([
    ["a", ["ligne importante", "ligne importante", "ligne importante", "}", "autre ligne"]],
    ["b", ["unique chose"]],
  ]);
  const r = revertedLines(arrived, removed);
  assert.deepEqual(r.map((x) => [x.path, x.lines]), [["a", 3], ["b", 1]]);
  assert.equal(r[0].sample, "ligne importante");
});

test("parseShortStat / parseMergeTree", () => {
  assert.deepEqual(parseShortStat(" 3 files changed, 10 insertions(+), 2 deletions(-)"), { files: 3, insertions: 10, deletions: 2 });
  assert.deepEqual(parseShortStat(""), { files: 0, insertions: 0, deletions: 0 });
  assert.deepEqual(parseShortStat(" 1 file changed, 1 deletion(-)"), { files: 1, insertions: 0, deletions: 1 });
  const tree = "a".repeat(40);
  assert.deepEqual(parseMergeTree(`${tree}\nx.txt\nx.txt\ny.txt\n\nmessage`), { tree, conflicts: ["x.txt", "y.txt"] });
  assert.deepEqual(parseMergeTree("erreur"), { tree: null, conflicts: [] });
});

function repo(): { dir: string; g: (...a: string[]) => string; write: (f: string, c: string) => void } {
  const dir = mkdtempSync(join(tmpdir(), "wipmerge-"));
  const g = (...a: string[]): string =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
  const write = (f: string, c: string): void => writeFileSync(join(dir, f), c);
  g("init", "-q", "-b", "main");
  return { dir, g, write };
}

test("ancetre : la pointe est déjà dans main", () => {
  const { dir, g, write } = repo();
  write("f.txt", "alpha line\n");
  g("add", ".");
  g("commit", "-q", "-m", "init");
  g("branch", "wip");
  const c = checkWipMerge(gitCallIn(dir), { wip: "wip", main: "main" });
  assert.equal(c.verdict, "ancetre");
  assert.equal(wipCheckAlarms(c), false);
});

test("sans-risque : la branche n'ajoute qu'un fichier", () => {
  const { dir, g, write } = repo();
  write("f.txt", "alpha line\n");
  g("add", ".");
  g("commit", "-q", "-m", "init");
  g("checkout", "-q", "-b", "wip");
  write("n.txt", "brand new\n");
  g("add", ".");
  g("commit", "-q", "-m", "feature");
  g("checkout", "-q", "main");
  write("f.txt", "alpha line\nbeta line\n");
  g("commit", "-q", "-am", "main avance");
  const c = checkWipMerge(gitCallIn(dir), { wip: "wip", main: "main" });
  assert.equal(c.verdict, "sans-risque");
  assert.ok(c.naive && c.own && c.naive.deletions >= c.own.deletions);
  assert.match(wipCheckVerdictLine(c, "wip"), /propre/);
});

test("efface : la branche rattachée à un main récent garde un disque périmé (base de départ connue)", () => {
  const { dir, g, write } = repo();
  write("f.txt", "alpha line\nbeta line\n");
  g("add", ".");
  g("commit", "-q", "-m", "c0");
  const depart = g("rev-parse", "HEAD");
  write("f.txt", "alpha line\nbeta line\ngamma line reçue\n");
  g("commit", "-q", "-am", "c1 : arrivée dans main");
  g("checkout", "-q", "-b", "wip");
  write("f.txt", "alpha line\nbeta line\n"); // disque périmé : la ligne reçue disparaît
  g("commit", "-q", "-am", "wip(1): filet");
  g("checkout", "-q", "main");
  write("g.txt", "autre fichier\n");
  g("add", ".");
  g("commit", "-q", "-m", "c2");

  const avec = checkWipMerge(gitCallIn(dir), { wip: "wip", main: "main", base: depart });
  assert.equal(avec.verdict, "efface");
  assert.equal(avec.baseSource, "depart");
  assert.equal(avec.reverted[0].path, "f.txt");
  assert.equal(avec.reverted[0].sample, "gamma line reçue");
  assert.equal(wipCheckAlarms(avec), true);
  assert.match(formatWipCheck(avec, "wip").join("\n"), /EFFACERAIT 1 ligne/);

  // Sans base de départ, la couche du filet trahit quand même : « douteux », jamais « sans risque ».
  const sans = checkWipMerge(gitCallIn(dir), { wip: "wip", main: "main" });
  assert.equal(sans.verdict, "douteux");
  assert.equal(sans.baseSource, "fusion");
  assert.equal(wipCheckAlarms(sans), true);
});

test("conflit : même ligne modifiée des deux côtés", () => {
  const { dir, g, write } = repo();
  write("f.txt", "valeur originale\n");
  g("add", ".");
  g("commit", "-q", "-m", "init");
  g("checkout", "-q", "-b", "wip");
  write("f.txt", "valeur branche\n");
  g("commit", "-q", "-am", "côté branche");
  g("checkout", "-q", "main");
  write("f.txt", "valeur principale\n");
  g("commit", "-q", "-am", "côté main");
  const c = checkWipMerge(gitCallIn(dir), { wip: "wip", main: "main" });
  assert.equal(c.verdict, "conflit");
  assert.deepEqual(c.conflicts, ["f.txt"]);
  assert.match(wipCheckVerdictLine(c, "wip"), /conflit/);
});

test("illisible : révision introuvable, git absent", () => {
  const { dir, g, write } = repo();
  write("f.txt", "x\n");
  g("add", ".");
  g("commit", "-q", "-m", "init");
  const c = checkWipMerge(gitCallIn(dir), { wip: "n-existe-pas", main: "main" });
  assert.equal(c.verdict, "illisible");
  assert.equal(wipCheckAlarms(c), true);
  assert.equal(checkWipMerge(() => null, { wip: "a" }).verdict, "illisible");
  assert.match(wipCheckVerdictLine(c, "n-existe-pas"), /non simulée/);
});
