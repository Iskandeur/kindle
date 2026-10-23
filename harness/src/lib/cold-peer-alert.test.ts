import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLD_PEER_DEDUP_MS,
  COLD_PEER_WINDOW_MS,
  coldPeerAlertText,
  decideColdPeerAlert,
  type ColdPeerDeps,
} from "./cold-peer-alert.ts";

const NOW = Date.UTC(2026, 5, 20, 12, 0, 0);

function deps(over: Partial<ColdPeerDeps> & { claims?: string[] } = {}): ColdPeerDeps {
  const taken = new Map<string, number>();
  return {
    now: NOW,
    lastOutgoingTs: async () => NOW - 3_600_000,
    claim: (chat, cooldown, now) => {
      const prev = taken.get(chat);
      if (prev !== undefined && now - prev < cooldown) return false;
      taken.set(chat, now);
      over.claims?.push(chat);
      return true;
    },
    ...over,
  };
}

test("fil ouvert récemment : alerte", async () => {
  assert.deepEqual(await decideColdPeerAlert("33600000000@c.us", deps()), { action: "alert", reason: "fil-ouvert" });
});

test("jamais écrit : silence, et le créneau n'est PAS consommé", async () => {
  const claims: string[] = [];
  const d = deps({ claims, lastOutgoingTs: async () => null });
  assert.deepEqual(await decideColdPeerAlert("c1", d), { action: "silence", reason: "jamais-ecrit" });
  assert.equal(claims.length, 0);
});

test("dernier sortant plus vieux que 30 jours : silence", async () => {
  const d = deps({ lastOutgoingTs: async () => NOW - COLD_PEER_WINDOW_MS - 1 });
  assert.deepEqual(await decideColdPeerAlert("c1", d), { action: "silence", reason: "jamais-ecrit" });
  const pile = deps({ lastOutgoingTs: async () => NOW - COLD_PEER_WINDOW_MS });
  assert.equal((await decideColdPeerAlert("c1", pile)).action, "alert");
});

test("lecture en échec : on alerte quand même (fail-open sur l'alerte)", async () => {
  const d = deps({
    lastOutgoingTs: async () => {
      throw new Error("historique indisponible");
    },
  });
  assert.deepEqual(await decideColdPeerAlert("c1", d), { action: "alert", reason: "lecture-en-echec" });
});

test("une seule alerte par chat et par 24 h ; un autre chat a son propre créneau", async () => {
  const d = deps();
  assert.equal((await decideColdPeerAlert("c1", d)).action, "alert");
  assert.deepEqual(await decideColdPeerAlert("c1", d), { action: "silence", reason: "deja-alerte" });
  assert.equal((await decideColdPeerAlert("c2", d)).action, "alert");
  assert.equal((await decideColdPeerAlert("c1", { ...d, now: NOW + COLD_PEER_DEDUP_MS })).action, "alert");
});

test("texte : identité, extrait tronqué, motif, fuseau", () => {
  const long = "bonjour ".repeat(40);
  const t = coldPeerAlertText({ who: "Contact", chatId: "33600000000@c.us", atMs: Date.UTC(2026, 5, 20, 12, 5), body: long, reason: "fil-ouvert" });
  assert.match(t, /Contact \(33600000000@c\.us\)/);
  assert.match(t, /12:05/);
  assert.match(t, /…/);
  assert.match(t, /J'ai écrit dans ce fil/);
  const tz = coldPeerAlertText({ who: "", chatId: "c1", atMs: Date.UTC(2026, 5, 20, 12, 5), body: "salut", reason: "lecture-en-echec", timeZone: "Asia/Tokyo" });
  assert.match(tz, /21:05/);
  assert.match(tz, /pas pu vérifier/);
  assert.match(tz, /message non traité de c1 /i);
});
