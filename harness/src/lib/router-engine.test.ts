import { test } from "node:test";
import assert from "node:assert/strict";
import { readEngineConfig, type EngineConfig } from "./engine-config.ts";
import { startFakeOpenAI } from "./fake-openai-server.ts";
import { buildRouterPrompt, classifyRoute, CLAUDE_ROUTE_MODELS, parseRouterDecision, ranksOf, raiseModel, ROUTE_MODELS, routeEngineOpts, routeModelsFor, type RouterStore } from "./router.ts";

const cfg = (env: Record<string, string>): EngineConfig => readEngineConfig(env).config as EngineConfig;

function memStore(): RouterStore {
  const m = new Map<string, string>();
  return { getSetting: (k) => m.get(k) ?? null, setSetting: (k, v) => void m.set(k, v) };
}

test("gamme : claude sans rôle nommé = la gamme d'avant, prompt identique", () => {
  assert.deepEqual(routeModelsFor(undefined), CLAUDE_ROUTE_MODELS);
  assert.deepEqual(routeModelsFor(cfg({})), CLAUDE_ROUTE_MODELS);
  assert.deepEqual(CLAUDE_ROUTE_MODELS.map((m) => m.id), ROUTE_MODELS);
  const p = buildRouterPrompt("ok");
  assert.ok(p.includes("- claude-haiku-4-5 : trivial (salutation, « ok », « ça va », accusé, emoji, question ultra-simple)."));
  assert.ok(p.includes("- claude-opus-4-1 : complexe"));
});

test("gamme : un fournisseur OpenAI route entre MODELE_RAPIDE et MODELE_FORT", () => {
  const c = cfg({ KINDLE_BASE_URL: "http://127.0.0.1:1/v1", MODELE_FORT: "grand", MODELE_RAPIDE: "petit" });
  const g = routeModelsFor(c);
  assert.deepEqual(g.map((m) => m.id), ["petit", "grand"]);
  assert.equal(parseRouterDecision('{"model":"grand","effort":"high"}', ["petit", "grand"])?.model, "grand");
  assert.equal(parseRouterDecision('{"model":"claude-opus-4-1","effort":"high"}', ["petit", "grand"]), null);
  assert.equal(raiseModel("petit", "grand", ranksOf(g)), "grand");
  assert.equal(raiseModel("grand", "petit", ranksOf(g)), "grand");
  const seul = routeModelsFor(cfg({ KINDLE_BASE_URL: "http://127.0.0.1:1/v1", MODELE_FORT: "unique" }));
  assert.deepEqual(seul.map((m) => m.id), ["unique"]);
  const claudeRapide = routeModelsFor(cfg({ MODELE_RAPIDE: "haiku" }));
  assert.deepEqual(claudeRapide.map((m) => m.id), ["haiku", "claude-opus-4-1"]);
});

test("classifyRoute : moteur OpenAI = un appel HTTP au modèle rapide, décision validée sur la gamme", async () => {
  const srv = await startFakeOpenAI({
    models: ["petit", "grand"],
    reply: () => ({ text: 'Voilà : {"model":"grand","effort":"high","reason":"code à écrire"}' }),
  });
  try {
    const c = cfg({ KINDLE_BASE_URL: srv.baseUrl, MODELE_FORT: "grand", MODELE_RAPIDE: "petit" });
    const d = await classifyRoute("réécris ce module", { engine: c });
    assert.deepEqual(d, { model: "grand", effort: "high", reason: "code à écrire" });
    const body = srv.requests[0].body as { model: string; messages: Array<{ content: string }> };
    assert.equal(body.model, "petit");
    assert.ok(body.messages[0].content.includes("- grand : complexe"));
    const store = memStore();
    const r = await routeEngineOpts(store, { model: "petit" }, "réécris ce module", { engine: c });
    assert.equal(r.opts.model, "grand");
  } finally {
    await srv.close();
  }
});

test("classifyRoute : fournisseur en panne = repli (null), jamais d'exception", async () => {
  const c = cfg({ KINDLE_BASE_URL: "http://127.0.0.1:9/v1", MODELE_FORT: "grand" });
  assert.equal(await classifyRoute("x", { engine: c, timeoutMs: 2000 }), null);
});
