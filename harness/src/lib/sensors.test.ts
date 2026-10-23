import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSensorRegistry,
  evaluateSensor,
  prefetchSensorGate,
  parseSensorTag,
  parseFeed,
  feedSensor,
  githubReleaseSensor,
  type FetchFn,
  type KvStore,
} from "./sensors.ts";
import { createPrudenceGate } from "./prudence.ts";
import { openWakeStore, processDueWakes, startScheduler, type WakeEvent } from "../scheduler.ts";

function memStore(): KvStore & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getSetting: (k) => m.get(k) ?? null, setSetting: (k, v) => void m.set(k, v) };
}

function fakeFetch(responses: Array<{ status: number; body: string }>): FetchFn & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const r = responses.shift();
    if (!r) throw new Error("plus de réponse simulée");
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body };
  }) as FetchFn & { calls: string[] };
  f.calls = calls;
  return f;
}

const RSS = (ids: string[]): string =>
  `<?xml version="1.0"?><rss><channel><title>Blog</title>${ids
    .map((i) => `<item><title><![CDATA[Billet ${i} &amp; co]]></title><guid>${i}</guid><link>https://x.test/${i}</link></item>`)
    .join("")}</channel></rss>`;

const ATOM = (ids: string[]): string =>
  `<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title>${ids
    .map((i) => `<entry><id>tag:x,${i}</id><title>Billet ${i}</title><link href="https://x.test/${i}"/></entry>`)
    .join("")}</feed>`;

// ── registre et balise ────────────────────────────────────────────────────────────────────────

test("registre : inscription, doublon et nom invalide refusés", () => {
  const r = createSensorRegistry();
  r.register("flux-a", async () => ({ changed: false }));
  assert.deepEqual(r.names(), ["flux-a"]);
  assert.throws(() => r.register("flux-a", async () => ({ changed: false })), /déjà inscrit/);
  assert.throws(() => r.register("Mauvais Nom", async () => ({ changed: false })), /invalide/);
  assert.equal(r.get("absent"), undefined);
});

test("parseSensorTag : balise en tête d'intent seulement", () => {
  assert.deepEqual(parseSensorTag("@sensor:flux-a regarde le nouveau billet"), { sensor: "flux-a", rest: "regarde le nouveau billet" });
  assert.deepEqual(parseSensorTag("@sensor:flux-a"), { sensor: "flux-a", rest: "" });
  assert.equal(parseSensorTag("un intent normal"), null);
  assert.equal(parseSensorTag("note @sensor:flux-a au milieu"), null);
});

// ── evaluateSensor ────────────────────────────────────────────────────────────────────────────

test("evaluateSensor : changed / quiet", async () => {
  const registry = createSensorRegistry();
  registry.register("neuf", async () => ({ changed: true, note: "du neuf" }));
  registry.register("calme", async () => ({ changed: false, note: "ignorée" }));
  assert.deepEqual(await evaluateSensor("neuf", { registry }), { fire: true, reason: "changed", note: "du neuf" });
  assert.deepEqual(await evaluateSensor("calme", { registry }), { fire: false, reason: "quiet" });
});

test("evaluateSensor : inconnu ou en échec → réveil par prudence, jusqu'au plafond", async () => {
  const registry = createSensorRegistry();
  registry.register("casse", async () => {
    throw new Error("réseau mort");
  });
  const alerts: string[] = [];
  const prudence = createPrudenceGate(memStore(), { cap: 2, alert: (t) => alerts.push(t), log: () => {} });
  const opts = { registry, prudence, log: () => {} };
  const a = await evaluateSensor("fantome", opts);
  assert.equal(a.fire, true);
  assert.equal(a.reason, "unknown");
  assert.match(a.note!, /ANOMALIE/);
  const b = await evaluateSensor("casse", opts);
  assert.equal(b.reason, "error");
  assert.match(b.note!, /réseau mort/);
  const c = await evaluateSensor("fantome", opts);
  assert.deepEqual(c, { fire: false, reason: "prudence-cap" });
  assert.equal(alerts.length, 1);
});

// ── porte branchée sur le scheduler ───────────────────────────────────────────────────────────

test("scheduler + porte : récurrent muet réarmé sans fire ; récurrent bavard tire avec la note", async () => {
  const store = openWakeStore(":memory:");
  const registry = createSensorRegistry();
  registry.register("calme", async () => ({ changed: false }));
  registry.register("neuf", async () => ({ changed: true, note: "2 nouveaux items" }));
  const muet = store.addWake(1000, "@sensor:calme surveille A", 5000);
  const bavard = store.addWake(1000, "@sensor:neuf traite B", 5000);
  const nu = store.addWake(1000, "réveil sans capteur", 5000);
  const events: WakeEvent[] = [];

  const gate = await prefetchSensorGate(store.dueWakes(2000), { registry }, 2000);
  processDueWakes(store, (e) => events.push(e), 2000, 100, gate);

  assert.deepEqual(events.map((e) => e.id).sort(), [bavard, nu].sort());
  const ev = events.find((e) => e.id === bavard)!;
  assert.match(ev.intent, /^traite B\n\nCe qui a bougé : 2 nouveaux items$/);
  assert.equal(events.find((e) => e.id === nu)!.intent, "réveil sans capteur");
  assert.equal(store.firesSince(0), 2, "le réveil muet n'a PAS consommé de budget");
  const pending = store.listPending();
  assert.equal(pending.find((w) => w.id === muet)!.due_at, 6000, "muet mais réarmé");
  store.close();
});

test("scheduler + porte : un réveil UNIQUE n'est jamais fermé en silence", async () => {
  const store = openWakeStore(":memory:");
  const registry = createSensorRegistry();
  registry.register("calme", async () => ({ changed: false }));
  store.addWake(1000, "@sensor:calme rappel unique");
  const events: WakeEvent[] = [];
  const gate = await prefetchSensorGate(store.dueWakes(2000), { registry }, 2000);
  processDueWakes(store, (e) => events.push(e), 2000, 100, gate);
  assert.equal(events.length, 1);
  store.close();
});

test("porte : un capteur partagé par deux réveils n'est évalué qu'une fois par tick", async () => {
  const store = openWakeStore(":memory:");
  const registry = createSensorRegistry();
  let appels = 0;
  registry.register("partage", async () => {
    appels++;
    return { changed: true, note: "x" };
  });
  store.addWake(1000, "@sensor:partage un", 5000);
  store.addWake(1000, "@sensor:partage deux", 5000);
  const events: WakeEvent[] = [];
  const gate = await prefetchSensorGate(store.dueWakes(2000), { registry }, 2000);
  processDueWakes(store, (e) => events.push(e), 2000, 100, gate);
  assert.equal(appels, 1);
  assert.equal(events.length, 2, "les deux réveils voient le même verdict");
  store.close();
});

test("processDueWakes sans porte : comportement inchangé", () => {
  const store = openWakeStore(":memory:");
  store.addWake(1000, "@sensor:x tel quel");
  const events: WakeEvent[] = [];
  processDueWakes(store, (e) => events.push(e), 2000, 100);
  assert.equal(events[0]!.intent, "@sensor:x tel quel");
  store.close();
});

test("startScheduler avec porte asynchrone : un récurrent muet ne réveille pas", async () => {
  const store = openWakeStore(":memory:");
  const registry = createSensorRegistry();
  registry.register("calme", async () => ({ changed: false }));
  store.addWake(Date.now() - 1000, "@sensor:calme veille", 60_000);
  const events: WakeEvent[] = [];
  const timer = startScheduler(store, (e) => events.push(e), 20, (due) => prefetchSensorGate(due, { registry }));
  await new Promise((r) => setTimeout(r, 120));
  clearInterval(timer);
  assert.equal(events.length, 0);
  assert.equal(store.firesSince(0), 0);
  store.close();
});

// ── capteur de flux ───────────────────────────────────────────────────────────────────────────

test("parseFeed : RSS (guid) et Atom (id), CDATA et entités décodées", () => {
  const rss = parseFeed(RSS(["a", "b"]));
  assert.deepEqual(rss, [
    { id: "a", title: "Billet a & co" },
    { id: "b", title: "Billet b & co" },
  ]);
  assert.deepEqual(parseFeed(ATOM(["z"])), [{ id: "tag:x,z", title: "Billet z" }]);
  assert.deepEqual(parseFeed("<rss><item><title>t</title><link>https://l.test/1</link></item></rss>"), [
    { id: "https://l.test/1", title: "t" },
  ]);
  assert.deepEqual(parseFeed("pas du xml"), []);
});

test("feedSensor : amorçage silencieux, puis seulement le neuf", async () => {
  const store = memStore();
  const f = fakeFetch([
    { status: 200, body: RSS(["a", "b"]) },
    { status: 200, body: RSS(["a", "b"]) },
    { status: 200, body: RSS(["c", "a", "b"]) },
    { status: 200, body: RSS(["c", "a", "b"]) },
  ]);
  const s = feedSensor({ url: "https://x.test/feed", key: "blog", fetchFn: f, store });
  assert.deepEqual(await s(), { changed: false }, "amorçage : pas de réveil sur l'historique");
  assert.deepEqual(await s(), { changed: false });
  const r = await s();
  assert.equal(r.changed, true);
  assert.match(r.note!, /1 nouvel.*« Billet c & co »/);
  assert.deepEqual(await s(), { changed: false }, "déjà vu : silence");
});

test("feedSensor : plusieurs nouveaux items → titres cités, reste compté", async () => {
  const store = memStore();
  const f = fakeFetch([
    { status: 200, body: RSS(["a"]) },
    { status: 200, body: RSS(["e", "d", "c", "b", "a"]) },
  ]);
  const s = feedSensor({ url: "https://x.test/f", key: "k", fetchFn: f, store, maxTitles: 2 });
  await s();
  const r = await s();
  assert.match(r.note!, /4 nouvel/);
  assert.match(r.note!, /\+2 autres/);
});

test("feedSensor : HTTP en échec ou flux vide LÈVE et n'efface pas l'état", async () => {
  const store = memStore();
  const f = fakeFetch([
    { status: 200, body: RSS(["a"]) },
    { status: 503, body: "" },
    { status: 200, body: "<rss></rss>" },
    { status: 200, body: RSS(["b", "a"]) },
  ]);
  const s = feedSensor({ url: "https://x.test/f", key: "k", fetchFn: f, store });
  await s();
  await assert.rejects(s(), /HTTP 503/);
  await assert.rejects(s(), /sans item/);
  const r = await s();
  assert.equal(r.changed, true, "l'état n'a pas été vidé par les pannes : b est bien neuf, a ne l'est pas");
  assert.match(r.note!, /1 nouvel/);
});

test("feedSensor : l'état d'un état corrompu retombe sur « rien vu » sans lever", async () => {
  const store = memStore();
  store.setSetting("sensor:feed:k", "{pas du json");
  const f = fakeFetch([{ status: 200, body: RSS(["a"]) }]);
  const r = await feedSensor({ url: "https://x.test/f", key: "k", fetchFn: f, store })();
  assert.equal(r.changed, true);
});

// ── capteur de release GitHub ─────────────────────────────────────────────────────────────────

const REL = (tag: string, name = ""): string => JSON.stringify({ tag_name: tag, name });

test("githubReleaseSensor : amorçage, release nouvelle, stable", async () => {
  const store = memStore();
  const f = fakeFetch([
    { status: 200, body: REL("v1.0.0") },
    { status: 200, body: REL("v1.0.0") },
    { status: 200, body: REL("v1.1.0", "Grosse mise à jour") },
  ]);
  const s = githubReleaseSensor({ repo: "octo/proj", fetchFn: f, store });
  assert.deepEqual(await s(), { changed: false });
  assert.deepEqual(await s(), { changed: false });
  const r = await s();
  assert.equal(r.changed, true);
  assert.match(r.note!, /v1\.1\.0.*Grosse mise à jour.*octo\/proj.*précédente v1\.0\.0/);
  assert.match(f.calls[0]!, /repos\/octo\/proj\/releases\/latest/);
});

test("githubReleaseSensor : un dépôt sans release (404) n'est pas une panne, et la première release est signalée", async () => {
  const store = memStore();
  const f = fakeFetch([
    { status: 404, body: "{}" },
    { status: 404, body: "{}" },
    { status: 200, body: REL("v0.1.0") },
  ]);
  const s = githubReleaseSensor({ repo: "octo/neuf", fetchFn: f, store });
  assert.deepEqual(await s(), { changed: false });
  assert.deepEqual(await s(), { changed: false });
  const r = await s();
  assert.equal(r.changed, true);
  assert.match(r.note!, /v0\.1\.0/);
});

test("githubReleaseSensor : erreur HTTP ou réponse sans tag LÈVE ; dépôt mal formé refusé", async () => {
  const store = memStore();
  const f = fakeFetch([
    { status: 500, body: "" },
    { status: 200, body: "{}" },
  ]);
  const s = githubReleaseSensor({ repo: "octo/proj", fetchFn: f, store });
  await assert.rejects(s(), /HTTP 500/);
  await assert.rejects(s(), /tag_name/);
  assert.equal(store.getSetting("sensor:github-release:octo/proj"), null, "l'échec n'amorce rien");
  assert.throws(() => githubReleaseSensor({ repo: "pas un depot", fetchFn: f, store }), /owner\/repo/);
});

test("githubReleaseSensor : le jeton part en en-tête, pas dans l'URL", async () => {
  const store = memStore();
  let seen: { url: string; headers?: Record<string, string> } | null = null;
  const f: FetchFn = async (url, init) => {
    seen = { url, headers: init?.headers };
    return { ok: true, status: 200, text: async () => REL("v1") };
  };
  await githubReleaseSensor({ repo: "o/r", fetchFn: f, store, token: "SECRET" })();
  assert.equal(seen!.headers!.authorization, "Bearer SECRET");
  assert.doesNotMatch(seen!.url, /SECRET/);
});
