import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCharter, validate, buildOrgChart, loadRegistry, bulletsOf, serializeOrgChart, DEFAULT_VOCABULARY,
  type Charter, type Nomenclature,
} from "./charters.ts";

const CHARTER = `---
id: triage
statut: actif
marche: 2
gardien: non
droits: [observer, reversible]
moteur: claude
sensibilite: generic
rattachement: chef
organes: [src/triage.ts]
declencheurs: [ticket-cree, matin]
---

## Mission

Trier les tickets entrants.

## Ce qui reste à écrire

Les doublons.

## Leçons

- une première leçon
  qui continue ici
- une seconde
`;

const NOMS: Nomenclature = {
  entites: {
    chef: { nom: "Chef", type: "processus", role: "orchestre" },
    triage: { nom: "Trieur", type: "agent", role: "trie" },
  },
};

const ok = (over: Partial<Charter> = {}): Charter => ({ ...parseCharter(CHARTER), ...over });

test("parseCharter : champs, sections, puces multi-lignes", () => {
  const c = parseCharter(CHARTER);
  assert.equal(c.id, "triage");
  assert.equal(c.marche, 2);
  assert.deepEqual(c.droits, ["observer", "reversible"]);
  assert.deepEqual(c.declencheurs, ["ticket-cree", "matin"]);
  assert.equal(c.mission, "Trier les tickets entrants.");
  assert.equal(c.delta, "Les doublons.");
  assert.deepEqual(c.lecons, ["une première leçon qui continue ici", "une seconde"]);
  assert.deepEqual(bulletsOf("- a\n- b"), ["a", "b"]);
});

test("parseCharter : erreurs de format", () => {
  assert.throws(() => parseCharter("pas de frontmatter"), /frontmatter absent/);
  assert.throws(() => parseCharter("---\nid: a\nligne sans deux points\n---\n"), /hors format/);
  assert.throws(() => parseCharter("---\nid: a\nid: b\n---\n"), /double/);
  assert.throws(() => parseCharter("---\nid: a\nstatut: actif\nmoteur: claude\n---\n"), /sensibilite/);
  assert.throws(() => parseCharter(CHARTER.replace("[observer, reversible]", "observer")), /liste/);
  assert.throws(() => parseCharter(CHARTER.replace("marche: 2", "marche: deux")), /entier/);
  assert.throws(() => parseCharter(CHARTER.replace("gardien: non", "gardien: peut-etre")), /oui ou non/);
});

test("validate : un ensemble sain est valide", () => {
  assert.deepEqual(validate(NOMS, [ok()]), []);
});

test("validate : sensibilité x moteur externe, gardien, rattachement, organe, marche", () => {
  const e = (c: Charter) => validate(NOMS, [c]).join(" | ");
  assert.match(e(ok({ sensibilite: "perso", moteur: "externe" })), /interdit le moteur/);
  assert.equal(validate(NOMS, [ok({ sensibilite: "generic", moteur: "externe" })]).length, 0);
  assert.match(e(ok({ gardien: true, droits: ["proposer"] })), /doit au moins observer/);
  assert.match(e(ok({ rattachement: "inconnu" })), /rattachement inconnu/);
  assert.match(e(ok({ rattachement: "triage" })), /rattaché à lui-même/);
  assert.match(e(ok({ mission: "" })), /Mission/);
  assert.match(e(ok({ droits: [] })), /aucun droit/);
  assert.match(e(ok({ droits: ["tout"] })), /droit inconnu/);
  assert.match(e(ok({ marche: 99 })), /hors 0\.\./);
  assert.match(e(ok({ statut: "a-naitre", marche: null })), /à quelle marche/);
  assert.match(e(ok({ moteur: "x" })), /moteur inconnu/);
  assert.match(e(ok({ sensibilite: "x" })), /sensibilité inconnue/);
  assert.match(e(ok({ statut: "x" })), /statut inconnu/);
  const missing = validate(NOMS, [ok()], { exists: () => false });
  assert.match(missing.join(), /organe introuvable/);
});

test("validate : racine exemptée, vocabulaire remplaçable, incohérences de nomenclature", () => {
  assert.equal(validate(NOMS, [ok({ statut: "a-naitre", marche: null })], { rootId: "triage" }).length, 0);
  const v = { ...DEFAULT_VOCABULARY, engines: ["maison"], externalEngines: ["maison"] };
  assert.equal(validate(NOMS, [ok({ moteur: "maison" })], { vocabulary: v }).length, 0);
  assert.match(validate(NOMS, [ok({ moteur: "maison", sensibilite: "perso" })], { vocabulary: v }).join(), /interdit/);
  assert.match(validate(NOMS, []).join(), /sans charte/);
  assert.match(validate({ entites: {} }, [ok()]).join(), /absente de la nomenclature/);
  assert.match(validate({ entites: { chef: { nom: "C", type: "processus", role: "r" } } }, [ok({ id: "chef" })]).join(), /réservée aux agents/);
  assert.match(validate({ entites: { Bad_Id: { nom: "", type: "zzz", role: "" } } }, []).join(), /identifiant invalide/);
});

test("buildOrgChart + loadRegistry sur un dossier temporaire", () => {
  const dir = mkdtempSync(join(tmpdir(), "charters-"));
  mkdirSync(join(dir, "chartes"));
  writeFileSync(join(dir, "nomenclature.json"), JSON.stringify(NOMS));
  writeFileSync(join(dir, "chartes", "triage.md"), CHARTER);
  const { nomenclature, charters } = loadRegistry(dir);
  const chart = buildOrgChart(nomenclature, charters);
  assert.equal(chart.entites.length, 2);
  assert.equal(chart.entites.find((x) => x.id === "triage")!.mission, "Trier les tickets entrants.");
  assert.equal(chart.entites.find((x) => x.id === "chef")!.statut, null);
  assert.ok(serializeOrgChart(chart).endsWith("}\n"));
  writeFileSync(join(dir, "chartes", "autre.md"), CHARTER);
  assert.throws(() => loadRegistry(dir), /ne correspond pas au nom du fichier/);
});
