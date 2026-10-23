import { test } from "node:test";
import assert from "node:assert/strict";
import { croisementsDeclares, formatDoublons, jourLocal, motsDe, trouverDoublons, type WakePourDoublon } from "./wake-doublons.ts";

const H = 3_600_000;
const J = Date.UTC(2026, 2, 10, 9, 0, 0);

const SUJET_A =
  "Vérifier si le fournisseur zephyrcloud a régénéré les exports calendrier anniversaires; contexte quartz-1805 demande citée; écrire un message au propriétaire";
const SUJET_B =
  "Contrôler si zephyrcloud a régénéré les exports calendrier anniversaires; contexte quartz-1805 demande citée; prévenir le propriétaire par un message";

function w(id: number, dueAt: number, intent: string, extra: Partial<WakePourDoublon> = {}): WakePourDoublon {
  return { id, dueAt, intent, ...extra };
}

test("motsDe : minuscules, longueur minimale, chiffres seuls écartés, accents gardés", () => {
  const m = motsDe("Le Café 2026 de Drécourt va-t-il ouvrir ?");
  assert.ok(m.has("café"));
  assert.ok(m.has("drécourt"));
  assert.ok(m.has("va-t-il"));
  assert.ok(!m.has("2026"));
  assert.ok(!m.has("le"));
});

test("deux réveils jumeaux le même jour sont signalés avec leurs mots rares", () => {
  const autres = [
    w(3, J, "Relancer la sauvegarde nocturne du dépôt principal"),
    w(4, J, "Rappeler de renouveler le certificat du domaine secondaire"),
  ];
  const paires = trouverDoublons([w(1, J, SUJET_A), w(2, J + 45 * 60_000, SUJET_B), ...autres]);
  assert.equal(paires.length, 1);
  assert.deepEqual([paires[0]!.a, paires[0]!.b], [1, 2]);
  assert.equal(paires[0]!.ecartMinutes, 45);
  assert.ok(paires[0]!.communs.includes("zephyrcloud"));
  assert.ok(paires[0]!.communs.includes("quartz-1805"));
});

test("jours différents : pas de paire", () => {
  assert.deepEqual(trouverDoublons([w(1, J, SUJET_A), w(2, J + 30 * H, SUJET_B)]), []);
});

test("les récurrents et les réveils gardés par un capteur sont écartés", () => {
  assert.deepEqual(trouverDoublons([w(1, J, SUJET_A, { recurrenceMs: 600_000 }), w(2, J, SUJET_B)]), []);
  assert.deepEqual(trouverDoublons([w(1, J, SUJET_A, { sensor: "flux" }), w(2, J, SUJET_B)]), []);
});

test("sujets distincts qui partagent seulement des mots courants : pas de paire", () => {
  const a = w(1, J, "Penser à vérifier la facture du fournisseur et écrire un message court");
  const b = w(2, J, "Penser à vérifier le planning de l'équipe et écrire un message court");
  assert.deepEqual(trouverDoublons([a, b]), []);
});

test("un mot présent dans trop d'intents n'est plus rare (corpus du jour)", () => {
  // Les 4 intents partagent les mêmes mots : aucun n'est rare au sens maxDocs=3.
  const ws = [1, 2, 3, 4].map((i) => w(i, J, SUJET_A));
  assert.deepEqual(trouverDoublons(ws), []);
  // Avec un maxDocs plus large, la paire ressort.
  assert.ok(trouverDoublons(ws, { maxDocs: 4 }).length > 0);
});

test("CROISEMENT VÉRIFIÉ #id tait la paire nommée, tolère la flexion, et seulement celle-là", () => {
  assert.deepEqual([...croisementsDeclares("x croisement vérifié #12 et Croisements verifies # 7")].sort((x, y) => x - y), [7, 12]);
  const a = w(1, J, `${SUJET_A} CROISEMENT VÉRIFIÉ #2`);
  const b = w(2, J, SUJET_B);
  const c = w(3, J, SUJET_B);
  const paires = trouverDoublons([a, b, c], { maxDocs: 3 });
  assert.ok(!paires.some((p) => (p.a === 1 && p.b === 2) || (p.a === 2 && p.b === 1)));
});

test("le fuseau décide du « même jour »", () => {
  const tard = Date.UTC(2026, 2, 10, 23, 30, 0);
  const tot = Date.UTC(2026, 2, 11, 0, 30, 0);
  assert.equal(jourLocal(tard, "UTC"), "2026-03-10");
  assert.equal(jourLocal(tot, "UTC"), "2026-03-11");
  assert.equal(jourLocal(tard, "Asia/Tokyo"), jourLocal(tot, "Asia/Tokyo"));
  assert.equal(trouverDoublons([w(1, tard, SUJET_A), w(2, tot, SUJET_B)], { timeZone: "UTC" }).length, 0);
  assert.equal(trouverDoublons([w(1, tard, SUJET_A), w(2, tot, SUJET_B)], { timeZone: "Asia/Tokyo" }).length, 1);
});

test("formatDoublons : 🟢 quand rien, détail quand paire", () => {
  assert.match(formatDoublons([], 5), /^🟢 Aucun doublon.*5 réveils/);
  const paires = trouverDoublons([w(1, J, SUJET_A), w(2, J, SUJET_B)]);
  const txt = formatDoublons(paires, 2);
  assert.match(txt, /#1 ↔ #2/);
  assert.match(txt, /CROISEMENT VÉRIFIÉ/);
});

test("moins de deux ponctuels : liste vide", () => {
  assert.deepEqual(trouverDoublons([]), []);
  assert.deepEqual(trouverDoublons([w(1, J, SUJET_A)]), []);
});
