import { test } from "node:test";
import assert from "node:assert/strict";
import { jobWorkLanded, jobWorkVerdict, type GitRunner } from "./job-landed.ts";

interface Commit {
  subject: string;
  parents?: string[];
  /** epoch secondes (%ct) */
  ct?: number;
  /** chemin → sha de blob */
  files?: Record<string, string>;
  gitlinks?: string[];
}

/** Un faux dépôt : les commandes git utilisées par le module, répondues depuis une table. */
function fakeGit(commits: Record<string, Commit>, mainAncestors: string[], mainFiles: Record<string, string>): GitRunner {
  return (args) => {
    const [cmd, ...rest] = args;
    const rev = rest[rest.length - 1]!;
    if (cmd === "log") {
      const c = commits[rev];
      if (!c) return null;
      if (rest.includes("--format=%s")) return c.subject;
      if (rest.includes("--format=%P")) return (c.parents ?? []).join(" ");
      if (rest.includes("--format=%ct")) return String(c.ct ?? 0);
    }
    if (cmd === "show") {
      const c = commits[rev];
      return c ? Object.keys(c.files ?? {}).join("\n") : null;
    }
    if (cmd === "ls-tree") {
      const c = commits[args[1]!];
      const f = args[args.length - 1]!;
      return c?.gitlinks?.includes(f) ? `160000 commit abc\t${f}` : c?.files?.[f] ? `100644 blob ${c.files[f]}\t${f}` : "";
    }
    if (cmd === "merge-base") {
      const [, , a, b] = args;
      if (b === "main") return mainAncestors.includes(a!) ? "" : null;
      // ancêtre d'une base : on suit les parents
      let cur: string | undefined = b;
      for (let i = 0; i < 10 && cur; i++) {
        if (cur === a) return "";
        cur = commits[cur]?.parents?.[0];
      }
      return null;
    }
    if (cmd === "rev-parse") {
      const [r, f] = rev.split(":");
      if (r === "main") return mainFiles[f!] ?? null;
      return commits[r!]?.files?.[f!] ?? null;
    }
    return null;
  };
}

const WIP = "job-7-wip@w1";

test("pas de référence ou sha vide : unlanded, jamais une exception", () => {
  const g = fakeGit({}, [], {});
  assert.equal(jobWorkVerdict(null, g), "unlanded");
  assert.equal(jobWorkVerdict("job-7-wip", g), "unlanded");
  assert.equal(jobWorkVerdict("job-7-wip@", g), "unlanded");
});

test("git muet : unlanded (on ne se tait pas sur une ignorance)", () => {
  assert.equal(jobWorkVerdict(WIP, () => null), "unlanded");
});

test("commit propre ancêtre de main : landed (suffisant)", () => {
  const g = fakeGit({ w1: { subject: "fix: truc", files: { "a.ts": "b1" } } }, ["w1"], {});
  assert.equal(jobWorkVerdict(WIP, g), "landed");
});

test("squash-merge : sha non ancêtre, mais blob identique dans main : landed", () => {
  const g = fakeGit({ w1: { subject: "fix: truc", files: { "a.ts": "b1" } } }, [], { "a.ts": "b1" });
  assert.equal(jobWorkVerdict(WIP, g), "landed");
});

test("ni ancêtre ni blob identique : unlanded", () => {
  const g = fakeGit({ w1: { subject: "fix: truc", files: { "a.ts": "b1" } } }, [], { "a.ts": "AUTRE" });
  assert.equal(jobWorkVerdict(WIP, g), "unlanded");
});

test("un blob « identique » ne se cherche pas dans le scratch", () => {
  const g = fakeGit({ w1: { subject: "fix", files: { "scratch/n.md": "b9" } } }, [], { "scratch/n.md": "b9" });
  assert.equal(jobWorkVerdict(WIP, g), "unlanded");
});

test("instantané wip qui porte du non-scratch : on crie, même si le parent est dans main", () => {
  const g = fakeGit(
    {
      w1: { subject: "wip(job #7) interrompu", parents: ["p1"], files: { "src/x.ts": "b2" } },
      p1: { subject: "base", files: { "src/y.ts": "b3" } },
    },
    ["p1", "w1"],
    {},
  );
  assert.equal(jobWorkVerdict(WIP, g), "unlanded");
});

test("instantané wip ne portant que du scratch : on remonte au commit propre", () => {
  const g = fakeGit(
    {
      w1: { subject: "wip(job #7) scratch", parents: ["p1"], files: { "scratch/notes": "s1" } },
      p1: { subject: "feat: livré", files: { "src/y.ts": "b3" } },
    },
    ["p1"],
    {},
  );
  assert.equal(jobWorkVerdict(WIP, g), "landed");
});

test("un lien vers un dépôt imbriqué (160000) n'est pas du travail à récupérer", () => {
  const g = fakeGit(
    {
      w1: { subject: "wip(job #7) clone", parents: ["p1"], files: { "tiers": "g1" }, gitlinks: ["tiers"] },
      p1: { subject: "feat: livré", files: { "a.ts": "b1" } },
    },
    ["p1"],
    {},
  );
  assert.equal(jobWorkVerdict(WIP, g), "landed");
});

test("le commit de tête antérieur au job (baseSha ou date) : nothing-committed", () => {
  const g = fakeGit({ w1: { subject: "autre voie", ct: 1000, files: { "a.ts": "b1" } } }, ["w1"], {});
  assert.equal(jobWorkVerdict(WIP, g, { baseSha: "w1" }), "nothing-committed");
  assert.equal(jobWorkVerdict(WIP, g, { createdAt: 1000 * 1000 + 3_600_000 }), "nothing-committed");
  // commit postérieur à la création (marge de 60 s comprise) : le verdict suit l'ascendance
  assert.equal(jobWorkVerdict(WIP, g, { createdAt: 1000 * 1000 + 30_000 }), "landed");
});

test("une pile de wip qui se referme sur elle-même rend un verdict (profondeur bornée)", () => {
  const g = fakeGit({ w1: { subject: "wip(job #7) boucle", parents: ["w1"], files: { "scratch/x": "s" } } }, [], {});
  assert.equal(jobWorkVerdict(WIP, g), "unlanded");
});

test("jobWorkLanded : la question binaire", () => {
  const g = fakeGit({ w1: { subject: "fix", files: { "a.ts": "b1" } } }, ["w1"], {});
  assert.equal(jobWorkLanded(WIP, g), true);
  assert.equal(jobWorkLanded(null, g), false);
});
