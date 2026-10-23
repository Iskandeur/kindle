import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classerFichiers,
  decisionFusion,
  globToRegex,
  lireNiveaux,
  memeTete,
  mergeActText,
  queueChemins,
  sensDuDossier,
  verifierPreuveSerrures,
  type DossierFusion,
  type EntreeFusion,
} from "./merge-gate.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const niveaux = lireNiveaux("# commentaire\nsrc/auth/**\n.github/**\n[souple]\nsrc/**\nconfig/*.json\n");

const dossier = (o: Partial<DossierFusion> = {}): DossierFusion => ({
  depot: "Org/Repo",
  pr: 5,
  sha: SHA,
  relecture: { verdict: "ok", points: [] },
  serrures: "aucune",
  tests: { ok: true, resume: "42 tests" },
  testsRequis: true,
  ...o,
});
const entree = (o: Partial<EntreeFusion> = {}): EntreeFusion => ({
  depot: "org/repo",
  pr: 5,
  sha: SHA,
  fichiers: ["docs/a.md"],
  niveaux,
  dossier: dossier(),
  approuve: false,
  ...o,
});

test("globToRegex : ** traverse les dossiers, * non", () => {
  assert.equal(globToRegex("src/**").test("src/a/b/c.ts"), true);
  assert.equal(globToRegex("src/*.ts").test("src/a/b.ts"), false);
  assert.equal(globToRegex("**/package.json").test("package.json"), true);
  assert.equal(globToRegex("**/package.json").test("a/b/package.json"), true);
  assert.equal(globToRegex("a.b").test("axb"), false);
});

test("lireNiveaux : avant tout en-tête = dur, en-tête inconnu = dur", () => {
  assert.deepEqual(niveaux, { dur: ["src/auth/**", ".github/**"], souple: ["src/**", "config/*.json"] });
  assert.deepEqual(lireNiveaux("[bizarre]\nx/**"), { dur: ["x/**"], souple: [] });
});

test("classerFichiers : un fichier dur et souple est dur", () => {
  assert.deepEqual(classerFichiers(["src/auth/login.ts", "src/util.ts", "README.md"], niveaux), { dur: ["src/auth/login.ts"], souples: ["src/util.ts"] });
});

test("memeTete : préfixe court/long ; vide ou trop court jamais", () => {
  assert.equal(memeTete(SHA, SHA.slice(0, 12)), true);
  assert.equal(memeTete(SHA, "ffffffffffff"), false);
  assert.equal(memeTete("", SHA), false);
  assert.equal(memeTete("abc", "abc"), false);
});

test("chemin ordinaire, relecture ok, tests verts : fusion sans accord", () => {
  const d = decisionFusion(entree());
  assert.equal(d.ok, true);
  assert.match(d.raison, /aucun chemin sensible/);
});

test("pas de dossier / autre PR / autre tête / pas de relecture : refus", () => {
  assert.equal(decisionFusion(entree({ dossier: null })).ok, false);
  assert.match(decisionFusion(entree({ dossier: dossier({ pr: 6 }) })).raison, /pas de org\/repo#5/);
  assert.match(decisionFusion(entree({ dossier: dossier({ sha: "f".repeat(40) }) })).raison, /autre tête/);
  assert.match(decisionFusion(entree({ dossier: dossier({ relecture: null }) })).raison, /personne n'a relu/);
});

test("verdict corriger/bloquer, ok-sous-reserve sans arbitrage : refus", () => {
  const c = decisionFusion(entree({ dossier: dossier({ relecture: { verdict: "corriger", points: ["fuite de secret"] } }) }));
  assert.equal(c.ok, false);
  assert.match(c.raison, /corriger/);
  assert.match(c.raison, /fuite de secret/);
  const r = dossier({ relecture: { verdict: "ok-sous-reserve", points: ["p1"] } });
  assert.equal(decisionFusion(entree({ dossier: r })).ok, false);
  assert.equal(decisionFusion(entree({ dossier: r, arbitrage: true })).ok, true);
});

test("tests : requis mais absents, ou rouges : refus ; sans suite constatée : ok", () => {
  assert.match(decisionFusion(entree({ dossier: dossier({ tests: null }) })).raison, /suite de tests/);
  assert.match(decisionFusion(entree({ dossier: dossier({ tests: { ok: false, resume: "3 échecs" } }) })).raison, /3 échecs/);
  const sans = decisionFusion(entree({ dossier: dossier({ tests: null, testsRequis: false }) }));
  assert.equal(sans.ok, true);
  assert.match(sans.raison, /non vérifiés/);
});

test("chemin dur : accord humain toujours exigé, l'acte est fourni", () => {
  const e = entree({ fichiers: ["src/auth/login.ts", "src/util.ts"] });
  const refus = decisionFusion(e);
  assert.equal(refus.ok, false);
  assert.deepEqual(refus.sensibles, ["src/auth/login.ts", "src/util.ts"]);
  assert.match(refus.raison, /--- acte ---\nmerge org\/repo#5 at 0123456789ab \(sensitive paths: src\/auth\/login\.ts, src\/util\.ts\)\n--- fin ---/);
  assert.equal(decisionFusion({ ...e, approuve: true }).ok, true);
  // même « serrures : aucune » ne dispense pas un chemin dur
  assert.equal(decisionFusion({ ...e, dossier: dossier({ serrures: "aucune" }) }).ok, false);
});

test("chemin souple : dispensé si serrures aucune ; sinon accord humain", () => {
  const e = entree({ fichiers: ["src/util.ts"] });
  const libre = decisionFusion(e);
  assert.equal(libre.ok, true);
  assert.deepEqual(libre.souples, ["src/util.ts"]);
  for (const serrures of [null, "touchees"] as const) {
    const d = decisionFusion({ ...e, dossier: dossier({ serrures }) });
    assert.equal(d.ok, false, String(serrures));
    assert.match(d.raison, /chemins souples/);
  }
  assert.equal(decisionFusion({ ...e, dossier: dossier({ serrures: null }), approuve: true }).ok, true);
});

test("serrures touchées : restreint/neutre AVEC preuve dispensent, sans preuve ou élargit non", () => {
  const e = entree({ fichiers: ["src/util.ts"] });
  const avec = (sens: DossierFusion["serruresSens"], preuve?: string) => decisionFusion({ ...e, dossier: dossier({ serrures: "touchees", serruresSens: sens, serruresPreuve: preuve }) });
  assert.equal(avec("restreint", "- allow = true").ok, true);
  assert.equal(avec("neutre", "ligne").ok, true);
  assert.equal(avec("restreint").ok, false);
  assert.equal(avec("restreint", "   ").ok, false);
  assert.equal(avec("elargit", "preuve").ok, false);
  assert.equal(avec(undefined, "preuve").ok, false);
});

test("sensDuDossier", () => {
  assert.equal(sensDuDossier({ serrures: "aucune" }), null);
  assert.equal(sensDuDossier(null), null);
  assert.equal(sensDuDossier({ serrures: "touchees", serruresSens: "neutre", serruresPreuve: "x" }), "neutre");
  assert.equal(sensDuDossier({ serrures: "touchees", serruresSens: "neutre" }), "elargit");
});

test("verifierPreuveSerrures : la preuve doit être une ligne + ou - du diff, signe compris ; sinon élargit", () => {
  const v = { serrures: "touchees" as const, serruresSens: "restreint" as const, serruresPreuve: "+allow = false;" };
  const diff = "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@ function reglage()\n contexte inchangé ici\n-allow = true;\n+allow = false;\n";
  const sens = (preuve: string | undefined) => verifierPreuveSerrures({ ...v, serruresPreuve: preuve }, diff).serruresSens;
  assert.equal(verifierPreuveSerrures(v, diff).serruresSens, "restreint");
  assert.equal(sens("-allow = true;"), "restreint");
  assert.equal(sens("+  allow = false;  "), "restreint");
  assert.equal(sens("+contexte inchangé ici"), "elargit", "contexte");
  assert.equal(sens(" contexte inchangé ici"), "elargit", "contexte sans signe");
  assert.equal(sens("+++ b/x"), "elargit", "en-tête +++");
  assert.equal(sens("@@ -1,3 +1,3 @@ function reglage()"), "elargit", "en-tête @@");
  assert.equal(sens("+allow = fal"), "elargit", "sous-chaîne");
  assert.equal(sens("allow = false;"), "elargit", "sans signe");
  assert.equal(sens("-allow = false;"), "elargit", "mauvais signe");
  assert.equal(sens(undefined), "elargit", "preuve absente");
  assert.deepEqual(verifierPreuveSerrures({ serrures: "aucune" as const }, ""), { serrures: "aucune" });
});

test("dépôt qui publie : accord humain quels que soient les chemins, l'acte couvre tous les fichiers", () => {
  const e = entree({ depotPublic: true, fichiers: ["docs/a.md", "docs/b.md"] });
  const d = decisionFusion(e);
  assert.equal(d.ok, false);
  assert.deepEqual(d.sensibles, ["docs/a.md", "docs/b.md"]);
  assert.match(d.raison, /met en ligne/);
  assert.equal(decisionFusion({ ...e, approuve: true }).ok, true);
});

test("un refus dit si un accord humain est en jeu (queue des chemins)", () => {
  assert.equal(queueChemins([], []), " — chemins sensibles : aucun");
  assert.equal(queueChemins(["a", "b", "c", "d"], ["s"]), " — chemins sensibles : dur a, b, c +1 / souple s");
  const d = decisionFusion(entree({ dossier: null, fichiers: ["src/auth/x.ts"] }));
  assert.ok(d.raison.endsWith(" — chemins sensibles : dur src/auth/x.ts"));
});

test("mergeActText : le sha court fait partie de l'acte", () => {
  assert.notEqual(mergeActText("o/r", 1, SHA, ["a"]), mergeActText("o/r", 1, "f".repeat(40), ["a"]));
});
