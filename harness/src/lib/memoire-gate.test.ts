import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ETAT_MEMOIRE_INITIAL,
  GardeMemoire,
  observerMemoire,
  SEUILS_MEMOIRE_DEFAUT,
  seuilsMemoireDepuisEnv,
  type EtatMemoire,
} from "./memoire-gate.ts";

const S = SEUILS_MEMOIRE_DEFAUT;

function suite(valeurs: (number | null)[], pasMs = 30_000, depart: EtatMemoire = ETAT_MEMOIRE_INITIAL) {
  let etat = depart;
  const transitions: string[] = [];
  valeurs.forEach((v, i) => {
    const d = observerMemoire(etat, v, i * pasMs, S);
    etat = d.etat;
    if (d.transition) transitions.push(`${i}:${d.transition}`);
  });
  return { etat, transitions };
}

test("RAM sous le seuil pendant la durée → suspendre, pas avant", () => {
  assert.equal(suite([300, 300]).etat.suspendu, false); // 30 s < 60 s
  const r = suite([300, 300, 300]); // 60 s atteintes
  assert.equal(r.etat.suspendu, true);
  assert.deepEqual(r.transitions, ["2:suspendre"]);
});

test("un creux au-dessus du seuil remet le compteur à zéro", () => {
  assert.equal(suite([300, 300, 900, 300, 300]).etat.suspendu, false);
});

test("reprise seulement au-dessus du seuil de reprise, pendant la durée (hystérésis)", () => {
  const susp: EtatMemoire = { ...ETAT_MEMOIRE_INITIAL, suspendu: true, basseDepuis: 0 };
  assert.equal(suite([800, 800, 800, 800, 800], 30_000, susp).etat.suspendu, true, "800 Mo : entre les deux seuils, reste fermé");
  const r = suite([2000, 2000, 2000, 2000, 2000], 30_000, susp); // 120 s atteintes à l'index 4
  assert.equal(r.etat.suspendu, false);
  assert.deepEqual(r.transitions, ["4:reprendre"]);
});

test("une mesure illisible ne change rien", () => {
  const susp: EtatMemoire = { ...ETAT_MEMOIRE_INITIAL, suspendu: true };
  assert.equal(observerMemoire(susp, null, 1e9, S).etat.suspendu, true);
  assert.equal(observerMemoire(ETAT_MEMOIRE_INITIAL, null, 1e9, S).etat.suspendu, false);
});

test("seuils : défauts sobres, env pris, valeur absurde → défaut, reprise jamais sous la basse", () => {
  assert.deepEqual(seuilsMemoireDepuisEnv({}), S);
  const e = seuilsMemoireDepuisEnv({ MEM_DISPO_BASSE_MO: "800", MEM_DISPO_REPRISE_MO: "100", MEM_DUREE_MS: "abc", MEM_REPRISE_MS: "5000" });
  assert.equal(e.basseMo, 800);
  assert.equal(e.repriseMo, 800);
  assert.equal(e.dureeMs, S.dureeMs);
  assert.equal(e.repriseMs, 5000);
});

test("GardeMemoire : une alerte par épisode, ne lève jamais", () => {
  const alertes: string[] = [];
  let dispo: number | null = 300;
  const g = new GardeMemoire({ lire: () => dispo, alerte: (t) => alertes.push(t), seuils: S });
  assert.equal(g.observer(0, 1), false);
  assert.equal(g.observer(60_000, 1), true);
  assert.equal(alertes.length, 1);
  assert.match(alertes[0]!, /300 Mo/);
  g.observer(90_000, 1);
  assert.equal(alertes.length, 1);
  const cassee = new GardeMemoire({ lire: () => { throw new Error("proc"); }, alerte: () => {}, seuils: S });
  assert.equal(cassee.observer(0, 0), false);
  dispo = null;
});
