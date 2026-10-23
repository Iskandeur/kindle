import { test } from "node:test";
import assert from "node:assert/strict";
import { addedDiffSources, parseMosaicInventory, parsePrivateInventory, scanSources, scanText } from "./leak-scan.ts";

// Les fausses valeurs sont assemblées à l'exécution : le dépôt ne contient aucune valeur plausible.
const HOME = "/hom" + "e/";
const rules = (text: string, o = {}): string[] => scanText({ name: "t", text }, o).map((f) => f.rule);

test("secrets : clé privée, jeton de fournisseur, Bearer", () => {
  assert.deepEqual(rules("-----BEGIN RSA PRIVATE KEY-----"), ["private-key"]);
  assert.deepEqual(rules("tok ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2"), ["provider-token"]);
  assert.deepEqual(rules("Authorization: Bearer " + "abcdefghij12klmnopqrstuv"), ["bearer-token"]);
  assert.deepEqual(rules("Authorization: Bearer YOUR_TOKEN_GOES_HERE_PLEASE"), []);
  assert.deepEqual(rules("Bearer SETTINGS_ACCESS_TOKEN_VARIABLE"), []);
});

test("email : exemples, attribution et remote git sont sûrs, le reste non", () => {
  assert.deepEqual(rules("contact: jane.doe@acme-corp.fr"), ["email-address"]);
  assert.deepEqual(rules("a@example.com b@example.org"), []);
  assert.deepEqual(rules("Co-Authored-By: X <noreply@anthropic.com>"), []);
  assert.deepEqual(rules("x-noreply@anthropic.com"), ["email-address"]);
  assert.deepEqual(rules("git@github.com:org/repo.git"), []);
  assert.deepEqual(rules("12345+jane@users.noreply.github.com"), ["email-address"]);
});

test("identifiant de messagerie : le format est détecté", () => {
  assert.deepEqual(rules("to 33600000000@c.us"), ["whatsapp-identifier"]);
  assert.deepEqual(rules("grp 120363000000000000@g.us"), ["whatsapp-identifier"]);
});

test("IP : privées/doc/résolveurs sûrs, une IP publique non", () => {
  assert.deepEqual(rules("192.168.1.10 10.0.0.1 127.0.0.1 203.0.113.9 8.8.8.8"), []);
  assert.deepEqual(rules("server 93.184.216.34"), ["ip-address"]);
  assert.deepEqual(rules("version 1.2.3"), []);
});

test("téléphones", () => {
  assert.deepEqual(rules("tel +33 6 00 00 00 00"), ["international-phone"]);
  assert.ok(rules("tel 06 00 00 00 00").includes("french-phone"));
  assert.deepEqual(rules("build 2026-10-23"), []);
});

test("chemin d'utilisateur : détecté sauf placeholder", () => {
  assert.deepEqual(rules(`cd ${HOME}alice/projet`), ["private-filesystem-path"]);
  assert.deepEqual(rules(`cd ${HOME}<user>/projet`), []);
  assert.deepEqual(rules(`cd ${HOME}user/projet`), []);
});

test("allow : une valeur explicitement autorisée passe", () => {
  assert.deepEqual(rules("contact: jane.doe@acme-corp.fr", { allow: ["jane.doe@acme-corp.fr"] }), []);
  assert.deepEqual(rules("tel +33 6 00 00 00 00", { allow: ["33600000000"] }), []);
});

test("le rapport ne recopie jamais la valeur", () => {
  const f = scanText({ name: "doc.md", text: "x\njane.doe@acme-corp.fr" }, { privateLiterals: ["jane.doe"] });
  assert.ok(f.length >= 1);
  assert.equal(f[0].line, 2);
  assert.ok(!JSON.stringify(f).includes("jane"));
});

test("inventaire privé : mot entier, insensible à la casse, numéro normalisé", () => {
  assert.deepEqual(rules("Je vis à Trifouilly-les-Oies", { privateLiterals: ["trifouilly-les-oies"] }), ["private-inventory"]);
  assert.deepEqual(rules("le bidule", { privateLiterals: ["bid"] }), []); // trop court
  assert.deepEqual(rules("sous-bidule", { privateLiterals: ["bidu"] }), []); // « bidu » est dans « bidule » : pas un mot entier
  assert.deepEqual(rules("appelle le 06.11.22.33.44 vite", { privateLiterals: ["0611223344"] }).includes("private-inventory"), true);
});

test("parsePrivateInventory / parseMosaicInventory", () => {
  assert.deepEqual(parsePrivateInventory("# note\nabcd\nxy\n\n  terme exact  \n"), ["abcd", "terme exact"]);
  assert.deepEqual(parseMosaicInventory("# c\nville\tLyonnais\nécole|Lycée Truc\nmal formé\nx|ab"), [
    { category: "ville", term: "Lyonnais" },
    { category: "école", term: "Lycée Truc" },
  ]);
});

test("mosaïque : une ancre seule passe, deux catégories qui se recoupent bloquent", () => {
  const patterns = parseMosaicInventory("ville|Lyonnais\nclub|Escrime Royale");
  const sortie = [{ name: "post.md", text: "J'adore le pays Lyonnais." }];
  assert.equal(scanSources(sortie, { mosaicPatterns: patterns }).ok, true);
  const contexte = [{ name: "readme.md", text: "Le club Escrime Royale recrute." }];
  const r = scanSources(sortie, { mosaicPatterns: patterns, contextSources: contexte });
  assert.equal(r.ok, false);
  assert.equal(r.findings[0].rule, "mosaic-effect");
  assert.ok(!JSON.stringify(r).includes("Escrime"));
  // deux ancres de la MÊME catégorie ne suffisent pas
  const memes = parseMosaicInventory("ville|Lyonnais\nville|Marseillais");
  assert.equal(scanSources(sortie, { mosaicPatterns: memes, contextSources: [{ name: "c", text: "Marseillais" }] }).ok, true);
});

test("addedDiffSources : seulement les lignes ajoutées, avec leur numéro de ligne", () => {
  const diff = ["diff --git a/f.md b/f.md", "--- a/f.md", "+++ b/f.md", "@@ -1,2 +10,3 @@", " ctx", "-vieux", "+neuf", "+autre"].join("\n");
  const s = addedDiffSources(diff);
  assert.deepEqual(s.map((x) => [x.name, x.text, x.lineOffset]), [["f.md", "neuf", 10], ["f.md", "autre", 11]]);
  const r = scanSources(addedDiffSources("+++ b/g.md\n@@ -0,0 +5 @@\n+jane.doe@acme-corp.fr"));
  assert.deepEqual(r.findings.map((f) => [f.source, f.line]), [["g.md", 5]]);
});
