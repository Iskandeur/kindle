import { test } from "node:test";
import assert from "node:assert/strict";
import { ENGINE_TOLERANCE_MS, engineAt, engineMix, mixWarning, singleEngineSpans, type EngineTurn } from "./engine-timeline.ts";

const H = 3_600_000;
const turns: EngineTurn[] = [
  { ts: 1 * H, engine: "A" },
  { ts: 2 * H, engine: "A" },
  { ts: 3 * H, engine: "B" },
  { ts: 4 * H, engine: "B" },
];

test("journal vide : incertain", () => {
  assert.deepEqual(engineAt([], 5), { certain: false });
});

test("encadré par le même moteur : certain", () => {
  assert.deepEqual(engineAt(turns, 1.5 * H), { engine: "A", certain: true });
  assert.deepEqual(engineAt(turns, 3.5 * H), { engine: "B", certain: true });
});

test("dans une bascule : le plus proche, mais incertain", () => {
  assert.deepEqual(engineAt(turns, 2.4 * H), { engine: "A", certain: false });
  assert.deepEqual(engineAt(turns, 2.6 * H), { engine: "B", certain: false });
});

test("bord de journal : accepté dans la tolérance, avoué au-delà", () => {
  assert.deepEqual(engineAt(turns, 0.5 * H, H), { engine: "A", certain: true });
  assert.deepEqual(engineAt(turns, 10 * H, H), { certain: false });
  assert.deepEqual(engineAt(turns, 4.5 * H), { engine: "B", certain: true });
  assert.equal(ENGINE_TOLERANCE_MS, H);
});

test("engineMix : décroissant, `?` pour l'inconnu, suffixe pour l'incertain", () => {
  const mix = engineMix([
    { engine: "A", certain: true }, { engine: "A", certain: true }, { engine: "B", certain: false }, { certain: false },
  ]);
  assert.deepEqual(mix, [{ engine: "A", n: 2 }, { engine: "?", n: 1 }, { engine: "B?", n: 1 }]);
});

test("singleEngineSpans : coupe sur les bascules, pas sur le calendrier", () => {
  const spans = singleEngineSpans(turns);
  assert.deepEqual(spans, [
    { engine: "A", from: 1 * H, to: 2 * H, turns: 2 },
    { engine: "B", from: 3 * H, to: 4 * H, turns: 2 },
  ]);
});

test("singleEngineSpans : les bornes recoupent après coup, sans fabriquer de bascule", () => {
  const spans = singleEngineSpans(turns, 1.5 * H, 3.5 * H);
  assert.deepEqual(spans.map((s) => [s.engine, s.from, s.to]), [["A", 1.5 * H, 2 * H], ["B", 3 * H, 3.5 * H]]);
  assert.deepEqual(singleEngineSpans(turns, 2.2 * H, 2.8 * H), []);
});

test("mixWarning : muet si un seul moteur, bavard dès qu'il y en a deux", () => {
  assert.equal(mixWarning([{ engine: "A", n: 3 }, { engine: "?", n: 2 }]), undefined);
  assert.equal(mixWarning([{ engine: "A", n: 3 }, { engine: "A?", n: 1 }]), undefined);
  const w = mixWarning([{ engine: "A", n: 3 }, { engine: "B?", n: 1 }]);
  assert.match(w!, /PLUSIEURS moteurs \(A 3, B\? 1\)/);
});
