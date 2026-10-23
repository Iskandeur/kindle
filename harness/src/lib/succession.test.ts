import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blocAlarmes, juger, observerAucune, observerFichier, rapportSuccession, validerRegistre,
  type EntreeSuccession, type Observation,
} from "./succession.ts";

const entree = (o: Partial<EntreeSuccession> = {}): EntreeSuccession => ({
  id: "e1",
  ancien: { nom: "vieux-capteur", sonde: { type: "custom", nom: "boucle", argument: "vieux" } },
  successeur: { nom: "nouveau-capteur", sonde: { type: "custom", nom: "boucle", argument: "nouveau" } },
  statut: "a-eteindre",
  date: "2026-05-01",
  raison: "remplacé",
  preuve: "src/main.ts:12",
  ...o,
});
const tourne = (preuve = "p"): Observation => ({ tourne: true, preuve });
const arrete = (preuve = "p"): Observation => ({ tourne: false, preuve });
const inconnu = (preuve = "p"): Observation => ({ tourne: null, preuve });

test("registre valide : aucune erreur", () => {
  assert.deepEqual(validerRegistre({ entrees: [entree()] }), []);
});

test("registre : forme, doublons d'id, date, statut, preuves", () => {
  assert.deepEqual(validerRegistre({}), ["le registre n'a pas de tableau « entrees »"]);
  const e = validerRegistre({ entrees: [entree(), entree({ statut: "bof" as never, date: "demain", raison: "" })] });
  assert.ok(e.some((x) => x.includes("id en double")));
  assert.ok(e.some((x) => x.includes("statut inconnu")));
  assert.ok(e.some((x) => x.includes("date AAAA-MM-JJ")));
  assert.ok(e.some((x) => x.includes("raison manquante")));
});

test("registre : un doublon à trancher porte sa proposition ; une extinction exige une sonde sur l'ancien", () => {
  assert.ok(validerRegistre({ entrees: [entree({ statut: "a-trancher" })] }).some((x) => x.includes("proposition")));
  const muet = entree({ ancien: { nom: "x", sonde: { type: "aucune", raison: "manuel" } } });
  assert.ok(validerRegistre({ entrees: [muet] }).some((x) => x.includes("sonde sur l'ancien")));
  assert.deepEqual(validerRegistre({ entrees: [{ ...muet, statut: "coexistence" }] }), []);
  assert.ok(validerRegistre({ entrees: [entree({ ancien: { nom: "x", sonde: { type: "fichier" } as never } })] }).some((x) => x.includes("sonde invalide")));
});

test("eteint : alarme si l'ancien tourne, inconnu si muet, ok sinon", () => {
  const e = entree({ statut: "eteint" });
  assert.equal(juger(e, tourne(), arrete(), "2026-06-01").niveau, "alarme");
  assert.match(juger(e, tourne(), tourne(), "2026-06-01").texte, /en même temps que son successeur/);
  assert.equal(juger(e, inconnu(), tourne(), "2026-06-01").niveau, "inconnu");
  assert.equal(juger(e, arrete(), tourne(), "2026-06-01").niveau, "ok");
});

test("a-eteindre : alarme tant que l'ancien tourne, échéance dépassée dite", () => {
  const e = entree({ statut: "a-eteindre", date: "2026-05-01" });
  assert.match(juger(e, tourne(), arrete(), "2026-06-01").texte, /dépassée/);
  assert.doesNotMatch(juger(e, tourne(), arrete(), "2026-04-01").texte, /dépassée/);
  assert.equal(juger(e, inconnu(), arrete(), "2026-06-01").niveau, "inconnu");
  assert.match(juger(e, arrete(), tourne(), "2026-06-01").texte, /passer l'entrée en « eteint »/);
});

test("a-trancher : doublon seulement si les deux tournent ; jamais une alarme", () => {
  const e = entree({ statut: "a-trancher", proposition: "garder le nouveau" });
  const d = juger(e, tourne(), tourne(), "2026-06-01");
  assert.equal(d.niveau, "doublon");
  assert.match(d.texte, /garder le nouveau/);
  assert.equal(juger(e, inconnu(), tourne(), "2026-06-01").niveau, "inconnu");
  assert.equal(juger(e, arrete(), tourne(), "2026-06-01").niveau, "ok");
});

test("coexistence : ok, avec la condition de bascule", () => {
  const v = juger(entree({ statut: "coexistence", bascule: "quand le 2e stabilise" }), tourne(), tourne(), "2026-06-01");
  assert.equal(v.niveau, "ok");
  assert.match(v.texte, /quand le 2e stabilise/);
});

test("rapport : alarmes en tête, compte juste ; bloc d'alarmes jamais vide", () => {
  const ok = juger(entree({ id: "a", statut: "coexistence" }), tourne(), tourne(), "2026-06-01");
  const al = juger(entree({ id: "b", statut: "eteint" }), tourne(), arrete(), "2026-06-01");
  const r = rapportSuccession([ok, al]);
  const lignes = r.split("\n");
  assert.match(lignes[0]!, /2 entrées, 1 alarme\(s\), 0 doublon\(s\)/);
  assert.ok(lignes[1]!.startsWith("🔴"));
  assert.equal(blocAlarmes([ok]), "rien");
  assert.ok(blocAlarmes([ok, al]).startsWith("🔴"));
});

test("observerFichier et observerAucune : un instrument muet ne passe pas pour une extinction", () => {
  assert.equal(observerFichier({ chemin: "a.ts" }, null).tourne, false);
  assert.equal(observerFichier({ chemin: "a.ts", motif: "boucle" }, "rien").tourne, false);
  assert.equal(observerFichier({ chemin: "a.ts", motif: "boucle" }, "ma boucle").tourne, true);
  assert.equal(observerFichier({ chemin: "a.ts" }, "").tourne, true);
  assert.equal(observerAucune({ raison: "outil manuel" }).tourne, null);
});
