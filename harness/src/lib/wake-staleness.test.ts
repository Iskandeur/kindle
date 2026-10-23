import { test } from "node:test";
import assert from "node:assert/strict";
import { STALE_WAKE_AGE_MS, dayFormatter, stalenessBanner, withStalenessBanner } from "./wake-staleness.ts";

const NOW = Date.UTC(2026, 5, 20, 12, 0, 0);

test("récurrent : jamais de bandeau, même très vieux", () => {
  assert.equal(stalenessBanner({ created_at: NOW - 400 * 86_400_000, recurrence_ms: 3_600_000 }, NOW), null);
});

test("ponctuel récent (< 72 h) : pas de bandeau, pile au seuil : bandeau", () => {
  assert.equal(stalenessBanner({ created_at: NOW - STALE_WAKE_AGE_MS + 1 }, NOW), null);
  assert.ok(stalenessBanner({ created_at: NOW - STALE_WAKE_AGE_MS }, NOW));
});

test("ponctuel ancien : dit l'âge en jours, les deux dates, et les vérifications", () => {
  const b = stalenessBanner({ created_at: Date.UTC(2026, 4, 27, 8, 0, 0) }, NOW)!;
  assert.match(b, /POSÉ IL Y A 24 JOURS/);
  assert.match(b, /le 2026-05-27 ; tiré le 2026-06-20/);
  assert.match(b, /git log --since=2026-05-27/);
  assert.match(b, /Prémisse morte/);
});

test("created_at absent, futur, corrompu ou en chaîne : pas de faux bandeau, chaîne lue", () => {
  assert.equal(stalenessBanner({}, NOW), null);
  assert.equal(stalenessBanner({ created_at: null }, NOW), null);
  assert.equal(stalenessBanner({ created_at: NOW + 86_400_000 }, NOW), null);
  assert.equal(stalenessBanner({ created_at: Number.NaN }, NOW), null);
  assert.ok(stalenessBanner({ created_at: String(NOW - 10 * 86_400_000) as unknown as number }, NOW));
});

test("withStalenessBanner : texte inchangé sans bandeau, précédé du bandeau sinon", () => {
  assert.equal(withStalenessBanner({ created_at: NOW - 1000 }, NOW, "fais X"), "fais X");
  const t = withStalenessBanner({ created_at: NOW - 10 * 86_400_000 }, NOW, "fais X");
  assert.ok(t.startsWith("⏳ RÉVEIL POSÉ"));
  assert.ok(t.endsWith("\n\nfais X"));
});

test("le fuseau du formateur décide de la date affichée", () => {
  const minuitPasse = Date.UTC(2026, 5, 20, 23, 30, 0);
  assert.equal(dayFormatter("UTC")(minuitPasse), "2026-06-20");
  assert.equal(dayFormatter("Asia/Tokyo")(minuitPasse), "2026-06-21");
  const b = stalenessBanner({ created_at: minuitPasse - 5 * 86_400_000 }, minuitPasse, dayFormatter("Asia/Tokyo"))!;
  assert.match(b, /le 2026-06-16 ; tiré le 2026-06-21/);
});
