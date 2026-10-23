import { test } from "node:test";
import assert from "node:assert/strict";
import {
  writeAskBlock,
  readAskBlock,
  askBlockComplete,
  askBlockMissing,
  prependAskBlock,
  bodyHasCompleteAskBlock,
  askBlockFromArgs,
  askBlockRule,
} from "./ask-block.ts";

test("write puis read : aller-retour complet avec défaut", () => {
  const txt = writeAskBlock({
    question: "choisir l'hébergeur",
    options: [{ label: "X", consequence: "3 €/mois" }, { label: "Y", consequence: "1 €/mois" }],
    defaultOption: "B",
    ifNoAnswer: "je pars sur B le 15",
  });
  assert.equal(
    txt,
    "Ce que j'attends de toi : choisir l'hébergeur\nOptions : A) X — 3 €/mois ; B) Y — 1 €/mois (défaut : B)\nSans réponse : je pars sur B le 15",
  );
  const b = readAskBlock(txt)!;
  assert.equal(b.lang, "fr");
  assert.equal(b.defaultLetter, "B");
  assert.deepEqual(b.options.map((o) => [o.letter, o.label, o.consequence]), [["A", "X", "3 €/mois"], ["B", "Y", "1 €/mois"]]);
  assert.ok(askBlockComplete(b));
});

test("version anglaise, défaut par indice, pas de ligne Options pour un oui/non", () => {
  const txt = writeAskBlock({ lang: "en", question: "approve?", ifNoAnswer: "I skip it" });
  assert.equal(txt, "Ask: approve?\nIf no answer: I skip it");
  const b = readAskBlock(txt)!;
  assert.equal(b.lang, "en");
  assert.equal(b.options.length, 0);
  assert.ok(askBlockComplete(b));
  const t2 = writeAskBlock({ lang: "en", question: "q?", options: ["a", "b"], defaultOption: 0, ifNoAnswer: "x" });
  assert.match(t2, /\(default: A\)/);
});

test("un défaut qui ne désigne aucune option est omis, les séparateurs sont neutralisés", () => {
  const t = writeAskBlock({ question: "q", options: ["a ; b", "c — d"], defaultOption: "Z", ifNoAnswer: "x" });
  assert.ok(!/défaut/.test(t));
  assert.match(t, /A\) a, b ; B\) c, d/);
});

test("lecture tolérante : gras, puce, casse, deux-points espacé", () => {
  const body = ["> **Ce que j'attend de toi :** valider", "- OPTIONS : A) oui ; B) non (default: A)", "1. sans reponse : rien ne bouge"].join("\n");
  const b = readAskBlock(body)!;
  assert.equal(b.question, "valider");
  assert.equal(b.defaultLetter, "A");
  assert.equal(b.options.length, 2);
  assert.equal(b.ifNoAnswer, "rien ne bouge");
});

test("une phrase qui commence par « Options » n'est pas la ligne Options", () => {
  const b = readAskBlock("Ce que j'attends de toi : lire\nOptions : il y en a plusieurs.\nSans réponse : rien");
  assert.equal(b!.options.length, 0);
});

test("complétude : une seule option, ou sans-réponse manquant", () => {
  assert.deepEqual(askBlockMissing(null).length, 2);
  const one = readAskBlock("Ce que j'attends de toi : q ok\nOptions : A) seule\nSans réponse : rien");
  assert.match(askBlockMissing(one).join(), /deuxième option/);
  const noNone = readAskBlock("Ce que j'attends de toi : une question");
  assert.equal(askBlockComplete(noNone), false);
  assert.equal(readAskBlock("rien de tout ça"), null);
  assert.equal(readAskBlock(null), null);
});

test("prependAskBlock ne double pas un bloc complet", () => {
  const block = writeAskBlock({ question: "faire X", ifNoAnswer: "rien" });
  const withBody = prependAskBlock(block, "contexte");
  assert.equal(withBody, `${block}\n\ncontexte`);
  assert.equal(prependAskBlock(block, withBody), withBody);
  assert.equal(prependAskBlock(block, ""), block);
  assert.ok(bodyHasCompleteAskBlock(withBody));
});

test("askBlockFromArgs : flags retirés, options séparées par |", () => {
  const r = askBlockFromArgs(["titre", "--attends", "choisir", "--options", "A1 — c1 | B1 — c2", "--defaut", "B", "--sans-reponse", "je tranche"]);
  assert.deepEqual(r.rest, ["titre"]);
  assert.equal(r.input!.options!.length, 2);
  assert.equal(r.input!.defaultOption, "B");
  assert.equal(askBlockFromArgs(["--attends", "x"]).input, null);
});

test("askBlockRule : le texte de consigne mentionne les trois lignes", () => {
  const rule = askBlockRule().join("\n");
  assert.match(rule, /Ce que j'attends de toi/);
  assert.match(rule, /Sans réponse/);
});
