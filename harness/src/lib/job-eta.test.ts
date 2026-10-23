import { test } from "node:test";
import assert from "node:assert/strict";
import { DUREE_TYPE_DEFAUT_MS, dureeType, estimer, hhmm, ligneEtat, relancesDues, type EtatFile } from "./job-eta.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-01-01T12:00:00Z");
const file = (o: Partial<EtatFile> = {}): EtatFile => ({
  enFile: [], agesEnVol: [], concurrence: 1, dureeTypeMs: 40 * MIN, drainageJusqua: null, ...o,
});

test("dureeType : médiane, ignore le bruit, défaut sans données", () => {
  assert.equal(dureeType([]), DUREE_TYPE_DEFAUT_MS);
  assert.equal(dureeType([NaN, -5, 0]), DUREE_TYPE_DEFAUT_MS);
  assert.equal(dureeType([10 * MIN, 90 * MIN, 30 * MIN]), 30 * MIN);
});

test("un job en vol finit à durée type moins son âge, au plus tôt dans 5 min", () => {
  assert.equal(estimer(1, file(), NOW, true, 10 * MIN).finMs, NOW + 30 * MIN);
  assert.equal(estimer(1, file(), NOW, true, 120 * MIN).finMs, NOW + 5 * MIN);
});

test("file vide devant, slot libre : départ immédiat", () => {
  const e = estimer(7, file({ enFile: [7] }), NOW);
  assert.equal(e.etat, "en-file");
  assert.equal(e.position, 1);
  assert.equal(e.departMs, NOW);
  assert.equal(e.finMs, NOW + 40 * MIN);
});

test("derrière un job en vol, le départ attend la libération du slot", () => {
  const e = estimer(7, file({ enFile: [7], agesEnVol: [15 * MIN] }), NOW);
  assert.equal(e.departMs, NOW + 25 * MIN);
});

test("la position s'empile : le deuxième part après le premier", () => {
  const f = file({ enFile: [1, 2] });
  assert.equal(estimer(2, f, NOW).departMs, NOW + 40 * MIN);
});

test("la concurrence répartit sur plusieurs slots", () => {
  const f = file({ enFile: [1, 2], concurrence: 2 });
  assert.equal(estimer(2, f, NOW).departMs, NOW);
});

test("un drainage en cours repousse tout départ à sa fin", () => {
  const f = file({ enFile: [1], drainageJusqua: NOW + 20 * MIN });
  assert.equal(estimer(1, f, NOW).departMs, NOW + 20 * MIN);
});

test("un job absent de la file est « inconnu »", () => {
  assert.equal(estimer(99, file({ enFile: [1] }), NOW).etat, "inconnu");
});

test("ligneEtat : fuseau injecté, drainage dit", () => {
  const f = file({ enFile: [4], drainageJusqua: NOW + 30 * MIN });
  const l = ligneEtat(4, estimer(4, f, NOW), f, NOW, "UTC");
  assert.match(l, /position 1\/1/);
  assert.match(l, /gelée par un rechargement jusqu'à ~12:30/);
  assert.equal(hhmm(NOW, "UTC"), "12:00");
  assert.match(ligneEtat(5, estimer(5, f, NOW), f, NOW), /ni en file ni en vol/);
});

test("relancesDues : annonce dépassée de 50 %, une seule fois, jamais si le job est fini", () => {
  const a = { job: 1, fil: "t1", annonceeA: NOW, minutes: 40 };
  assert.deepEqual(relancesDues([a], new Set(), NOW + 59 * MIN), []);
  assert.equal(relancesDues([a], new Set(), NOW + 60 * MIN).length, 1);
  assert.deepEqual(relancesDues([a], new Set([1]), NOW + 90 * MIN), []);
  assert.deepEqual(relancesDues([{ ...a, relanceeA: NOW + 61 * MIN }], new Set(), NOW + 90 * MIN), []);
});
