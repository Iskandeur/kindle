import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeConfig, limitsOf, normalizeBaseUrl, readEngineConfig, type EngineConfig } from "./engine-config.ts";
import { claudeArgs, parseClaudeOutput } from "./engine-claude.ts";
import { chatOpenAI, listModels } from "./engine-openai.ts";
import { buildOpencodeConfig, mcpFromClaude, opencodeArgs, parseOpencodeEvents } from "./engine-opencode.ts";
import { resolveModel, runTurn } from "./engine.ts";
import { contentText, startFakeOpenAI } from "./fake-openai-server.ts";

const THREE_LINES = { KINDLE_BASE_URL: "https://inference.example.com/v1", KINDLE_API_KEY: "sk-test-123", MODELE_FORT: "modele-fort" };

function cfgOf(env: Record<string, string | undefined>): EngineConfig {
  const r = readEngineConfig(env);
  assert.deepEqual(r.errors, []);
  assert.ok(r.config);
  return r.config;
}

/** Écrit un faux binaire (script node exécutable) dans un dossier temporaire. */
function fakeBin(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kindle-fakebin-"));
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

// ————— Config —————

test("config : bypassPermissions est refusé sans KINDLE_ALLOW_BYPASS=1, et averti avec", () => {
  const sans = readEngineConfig({ ...THREE_LINES, KINDLE_CLAUDE_PERMISSION_MODE: "bypassPermissions" });
  assert.equal(sans.config, null);
  assert.match(sans.errors.join(" "), /KINDLE_ALLOW_BYPASS=1/);
  const claude = readEngineConfig({ KINDLE_CLAUDE_PERMISSION_MODE: "bypassPermissions" });
  assert.equal(claude.config, null);
  const avec = readEngineConfig({ ...THREE_LINES, KINDLE_CLAUDE_PERMISSION_MODE: "bypassPermissions", KINDLE_ALLOW_BYPASS: "1" });
  assert.deepEqual(avec.errors, []);
  assert.equal(avec.config?.claudePermissionMode, "bypassPermissions");
  assert.match(avec.warnings.join(" "), /bash libre/);
});

test("opencode : bashAllow ouvre une seule commande, le reste de bash reste en ask", () => {
  const c = cfgOf(THREE_LINES);
  assert.deepEqual(buildOpencodeConfig(c, { bashAllow: ["echo kindle-ok"] }).permission, {
    edit: "allow",
    bash: { "*": "ask", "echo kindle-ok": "allow" },
    webfetch: "ask",
  });
  assert.deepEqual(buildOpencodeConfig(c).permission, { edit: "allow", bash: "ask", webfetch: "ask" });
});

test("config : rien de posé = moteur claude, aucun modèle forcé (le CLI garde son défaut)", () => {
  const c = cfgOf({});
  assert.equal(c.kind, "claude");
  assert.deepEqual(c.models, { rapide: null, fort: null });
  assert.equal(c.quota, "abonnement");
  assert.equal(c.apiKey, null);
});

test("config : les trois lignes suffisent (moteur déduit, rapide = fort)", () => {
  const r = readEngineConfig(THREE_LINES);
  assert.deepEqual(r.errors, []);
  assert.equal(r.config?.kind, "openai-compatible");
  assert.equal(r.config?.baseUrl, "https://inference.example.com/v1");
  assert.deepEqual(r.config?.models, { fort: "modele-fort", rapide: "modele-fort" });
  assert.equal(r.config?.quota, "non-mesure");
  assert.ok(r.warnings.some((w) => w.includes("KINDLE_QUOTA=illimite")));
});

test("config : MODELE_FORT ou KINDLE_BASE_URL manquants = erreurs lisibles, pas de config", () => {
  const r = readEngineConfig({ KINDLE_ENGINE: "openai-compatible" });
  assert.equal(r.config, null);
  assert.ok(r.errors.some((e) => e.includes("KINDLE_BASE_URL")));
  assert.ok(r.errors.some((e) => e.includes("MODELE_FORT")));
  assert.ok(readEngineConfig({ ...THREE_LINES, KINDLE_BASE_URL: "inference.example.com" }).errors[0].includes("http"));
  assert.ok(readEngineConfig({ KINDLE_ENGINE: "gemini" }).errors[0].includes("inconnu"));
});

test("config : alias anglais, URL collée avec /chat/completions, budget refusé hors claude", () => {
  const c = cfgOf({ KINDLE_BASE_URL: "http://127.0.0.1:8000/v1/chat/completions/", MODEL_STRONG: "big", MODEL_FAST: "small", KINDLE_BUDGET_USD: "2" });
  assert.equal(c.baseUrl, "http://127.0.0.1:8000/v1");
  assert.deepEqual(c.models, { fort: "big", rapide: "small" });
  assert.equal(normalizeBaseUrl("https://x.example/v1/"), "https://x.example/v1");
  const r = readEngineConfig({ ...THREE_LINES, KINDLE_BUDGET_USD: "2" });
  assert.ok(r.warnings.some((w) => w.includes("KINDLE_BUDGET_USD ignoré")));
  assert.ok(readEngineConfig({ KINDLE_BUDGET_USD: "-1" }).errors.length === 1);
});

test("limites : un fournisseur sans quota ne bride rien, le mode illimité est explicite", () => {
  const nonMesure = limitsOf(cfgOf(THREE_LINES));
  assert.deepEqual(nonMesure, { budgetEnforced: false, budgetUsd: null, costReported: false, quota: "non-mesure", quotaCanThrottle: false });
  const illimite = cfgOf({ ...THREE_LINES, KINDLE_QUOTA: "illimite" });
  assert.equal(illimite.quota, "illimite");
  assert.equal(limitsOf(illimite).quotaCanThrottle, false);
  assert.ok(!readEngineConfig({ ...THREE_LINES, KINDLE_QUOTA: "illimite" }).warnings.some((w) => w.includes("Quota")));
  const claude = limitsOf(cfgOf({ KINDLE_BUDGET_USD: "1.5" }));
  assert.deepEqual(claude, { budgetEnforced: true, budgetUsd: 1.5, costReported: true, quota: "abonnement", quotaCanThrottle: true });
  assert.ok(readEngineConfig({ KINDLE_QUOTA: "beaucoup" }).errors[0].includes("KINDLE_QUOTA"));
});

test("describeConfig ne recopie jamais la clé", () => {
  const lines = describeConfig(cfgOf(THREE_LINES)).join("\n");
  assert.ok(!lines.includes("sk-test-123"));
  assert.ok(lines.includes("(11 car.)"));
});

test("resolveModel : rôle, défaut fort, épinglage explicite", () => {
  const c = cfgOf({ ...THREE_LINES, MODELE_RAPIDE: "petit" });
  assert.equal(resolveModel(c, { prompt: "x" }), "modele-fort");
  assert.equal(resolveModel(c, { prompt: "x", role: "rapide" }), "petit");
  assert.equal(resolveModel(c, { prompt: "x", model: "autre" }), "autre");
  assert.equal(resolveModel(cfgOf({}), { prompt: "x" }), null);
});

// ————— Moteur claude : inchangé —————

test("claude : les arguments d'avant, sans --model quand aucun rôle n'est nommé", () => {
  const c = cfgOf({});
  assert.deepEqual(claudeArgs(c, { prompt: "salut" }, null), ["-p", "salut", "--output-format", "json", "--permission-mode", "default"]);
  assert.deepEqual(claudeArgs(c, { prompt: "fais", tools: true }, "sonnet"), ["-p", "fais", "--output-format", "json", "--model", "sonnet", "--permission-mode", "acceptEdits"]);
  const b = cfgOf({ KINDLE_BUDGET_USD: "0.5" });
  assert.deepEqual(claudeArgs(b, { prompt: "p", tools: true, mcpConfig: "/x/.mcp.json" }, null).slice(-4), ["--max-budget-usd", "0.5", "--mcp-config", "/x/.mcp.json"]);
});

test("claude : sortie JSON lue (texte, coût, usage) ; erreur et sortie illisible", () => {
  const r = parseClaudeOutput(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "bonjour", total_cost_usd: 0.012, usage: { input_tokens: 10, output_tokens: 3 } }), null);
  assert.equal(r.ok, true);
  assert.equal(r.text, "bonjour");
  assert.equal(r.costUsd, 0.012);
  assert.deepEqual(r.usage, { input: 10, output: 3 });
  assert.equal(parseClaudeOutput(JSON.stringify({ subtype: "error_max_budget_usd", is_error: true }), "x").ok, false);
  assert.ok(parseClaudeOutput("pas du json", null).error?.includes("illisible"));
});

test("claude : runTurn lance le binaire avec ces arguments et sans ANTHROPIC_API_KEY", async () => {
  const bin = fakeBin(
    "claude",
    `process.stdout.write(JSON.stringify({ subtype: "success", is_error: false, result: JSON.stringify({ args: process.argv.slice(2), key: process.env.ANTHROPIC_API_KEY ?? null }), total_cost_usd: 0.001 }));`,
  );
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ne-doit-pas-passer";
  try {
    const r = await runTurn(cfgOf({ KINDLE_CLAUDE_BIN: bin }), { prompt: "salut" });
    assert.equal(r.ok, true, r.error);
    const seen = JSON.parse(r.text);
    assert.deepEqual(seen.args, ["-p", "salut", "--output-format", "json", "--permission-mode", "default"]);
    assert.equal(seen.key, null);
    assert.equal(r.costUsd, 0.001);
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  }
});

// ————— Moteur openai-compatible : HTTP direct —————

test("openai : un tour avec appel d'outil contre un faux serveur local (aller, outil, retour)", async () => {
  const srv = await startFakeOpenAI({ apiKey: "sk-test-123" });
  try {
    const seenArgs: unknown[] = [];
    const r = await chatOpenAI({
      baseUrl: srv.baseUrl,
      apiKey: "sk-test-123",
      model: "modele-fort",
      prompt: "Lance la commande de test.",
      tools: [
        {
          name: "bash",
          description: "Exécute une commande (simulée).",
          parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
          run: (a) => {
            seenArgs.push(a);
            return "kindle-ok";
          },
        },
      ],
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.text, "FAIT : kindle-ok");
    assert.deepEqual(r.toolCalls, ["bash"]);
    assert.deepEqual(seenArgs, [{ command: "echo kindle-ok", description: "test de fumée" }]);
    assert.deepEqual(r.usage, { input: 24, output: 14 });
    assert.equal(r.costUsd, null);
    assert.equal(srv.requests.length, 2);
    assert.equal(srv.requests[0].authorization, "Bearer sk-test-123");
    const second = srv.requests[1].body as { messages: Array<{ role: string; content: unknown; tool_call_id?: string }> };
    const toolMsg = second.messages.at(-1);
    assert.equal(toolMsg?.role, "tool");
    assert.equal(toolMsg?.tool_call_id, "call_1_0");
    assert.equal(contentText(toolMsg?.content), "kindle-ok");
  } finally {
    await srv.close();
  }
});

test("openai : une erreur porte son code HTTP (lisible par engine-failover), un outil inconnu ne plante pas", async () => {
  const srv = await startFakeOpenAI({ apiKey: "la-bonne" });
  try {
    const bad = await chatOpenAI({ baseUrl: srv.baseUrl, apiKey: "la-mauvaise", model: "modele-fort", prompt: "x" });
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? "", /^HTTP 401/);
    const unknown = await chatOpenAI({
      baseUrl: srv.baseUrl,
      apiKey: "la-bonne",
      model: "modele-fort",
      prompt: "x",
      tools: [{ name: "autre", description: "", parameters: { type: "object" }, run: () => "" }],
    });
    assert.equal(unknown.ok, true); // le script n'appelle `bash` que s'il est offert
    assert.equal(unknown.text, "pong");
  } finally {
    await srv.close();
  }
  const down = await chatOpenAI({ baseUrl: "http://127.0.0.1:9/v1", apiKey: null, model: "m", prompt: "x", timeoutMs: 3000 });
  assert.equal(down.ok, false);
  assert.match(down.error ?? "", /réseau/);
});

test("openai : listModels et runTurn texte seul passent par HTTP, jamais par un binaire", async () => {
  const srv = await startFakeOpenAI({});
  try {
    const l = await listModels(srv.baseUrl, null);
    assert.deepEqual(l, { ok: true, models: ["modele-fort", "modele-rapide"] });
    const c = cfgOf({ KINDLE_BASE_URL: srv.baseUrl, MODELE_FORT: "modele-fort", MODELE_RAPIDE: "modele-rapide", KINDLE_OPENCODE_BIN: "/nulle/part/opencode" });
    const r = await runTurn(c, { prompt: "ping", role: "rapide" });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.text, "pong");
    assert.equal((srv.requests.at(-1)?.body as { model?: string }).model, "modele-rapide");
  } finally {
    await srv.close();
  }
});

// ————— OpenCode : config, arguments, évènements —————

test("opencode : la config référence la clé sans la contenir, déclare les deux rôles et les MCP", () => {
  const c = cfgOf({ ...THREE_LINES, MODELE_RAPIDE: "modele-rapide" });
  const mcp = mcpFromClaude({
    mcpServers: {
      local: { command: "node", args: ["serveur.js", "--x"], env: { A: "1" } },
      distant: { type: "http", url: "https://mcp.example.com/mcp", headers: { authorization: "Bearer {env:MCP_TOKEN}" } },
      casse: "rien",
    },
  });
  assert.deepEqual(mcp, {
    local: { type: "local", command: ["node", "serveur.js", "--x"], enabled: true, environment: { A: "1" } },
    distant: { type: "remote", url: "https://mcp.example.com/mcp", enabled: true, headers: { authorization: "Bearer {env:MCP_TOKEN}" } },
  });
  const conf = buildOpencodeConfig(c, { mcp });
  const s = JSON.stringify(conf);
  assert.ok(!s.includes("sk-test-123"));
  assert.ok(s.includes("{env:KINDLE_API_KEY}"));
  assert.equal(conf.model, "kindle/modele-fort");
  assert.equal(conf.small_model, "kindle/modele-rapide");
  assert.deepEqual(conf.instructions, ["CLAUDE.md"]);
  // acceptEdits (défaut) : comme `claude -p`, seule l'édition passe sans accord.
  assert.deepEqual(conf.permission, { edit: "allow", bash: "ask", webfetch: "ask" });
  assert.deepEqual(buildOpencodeConfig(c, { allowAll: true }).permission, { edit: "allow", bash: "allow", webfetch: "allow" });
  assert.equal("mcp" in buildOpencodeConfig(c), false);
  assert.deepEqual(opencodeArgs({ prompt: "fais", cwd: "/depot" }, "modele-fort"), ["run", "--format", "json", "-m", "kindle/modele-fort", "--dir", "/depot", "fais"]);
});

// Flux réel relevé sur OpenCode 1.19.4 contre le faux serveur (identifiants raccourcis).
const OC_OK = [
  `{"type":"step_start","part":{"type":"step-start"}}`,
  `{"type":"tool_use","part":{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"echo kindle-ok"},"output":"kindle-ok\\n"}}}`,
  `{"type":"step_finish","part":{"reason":"tool-calls","type":"step-finish","tokens":{"total":19,"input":12,"output":7},"cost":0}}`,
  `{"type":"step_start","part":{"type":"step-start"}}`,
  `{"type":"text","part":{"type":"text","text":"FAIT : kindle-ok"}}`,
  `{"type":"step_finish","part":{"reason":"stop","type":"step-finish","tokens":{"total":19,"input":12,"output":7},"cost":0}}`,
].join("\n");
const OC_REJECTED = [
  `{"type":"step_start","part":{"type":"step-start"}}`,
  `{"type":"tool_use","part":{"type":"tool","tool":"bash","state":{"status":"error","error":"The user rejected permission to use this specific tool call."}}}`,
  `{"type":"step_finish","part":{"reason":"tool-calls","type":"step-finish","tokens":{"input":12,"output":7},"cost":0}}`,
].join("\n");

test("opencode : flux d'évènements résumé (dernier texte, outils, jetons, coût 0 = inconnu)", () => {
  const r = parseOpencodeEvents(OC_OK, "modele-fort");
  assert.equal(r.ok, true);
  assert.equal(r.text, "FAIT : kindle-ok");
  assert.deepEqual(r.toolCalls, ["bash"]);
  assert.deepEqual(r.usage, { input: 24, output: 14 });
  assert.equal(r.costUsd, null);
  const rej = parseOpencodeEvents(OC_REJECTED, "m");
  assert.equal(rej.ok, false);
  assert.match(rej.error ?? "", /rejected permission/);
  assert.equal(parseOpencodeEvents("", "m").ok, false);
  assert.equal(parseOpencodeEvents(`{"type":"step_finish","part":{"cost":0.25}}\n{"type":"text","part":{"text":"x"}}`, "m").costUsd, 0.25);
});

test("opencode : runTurn avec outils lance OpenCode, config dans OPENCODE_CONFIG, clé par l'env seulement", async () => {
  const bin = fakeBin(
    "opencode",
    `const fs = require("node:fs");
const conf = fs.readFileSync(process.env.OPENCODE_CONFIG, "utf8");
const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
line({ type: "step_start", part: {} });
line({ type: "text", part: { text: JSON.stringify({ args: process.argv.slice(2), keyInFile: conf.includes("sk-test-123"), keyInEnv: process.env.KINDLE_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY ?? null, mcp: JSON.parse(conf).mcp ?? null }) } });
line({ type: "step_finish", part: { tokens: { input: 1, output: 1 }, cost: 0 } });`,
  );
  const dir = mkdtempSync(join(tmpdir(), "kindle-mcp-"));
  const mcpFile = join(dir, ".mcp.json");
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { outil: { command: "node", args: ["s.js"] } } }));
  const c = cfgOf({ ...THREE_LINES, KINDLE_OPENCODE_BIN: bin });
  const r = await runTurn(c, { prompt: "fais", tools: true, cwd: dir, mcpConfig: mcpFile }, { env: { ...process.env, ANTHROPIC_API_KEY: "sk-ne-doit-pas-passer" } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.engine, "openai-compatible/opencode");
  const seen = JSON.parse(r.text);
  assert.deepEqual(seen.args, ["run", "--format", "json", "-m", "kindle/modele-fort", "--dir", dir, "fais"]);
  assert.equal(seen.keyInFile, false);
  assert.equal(seen.keyInEnv, "sk-test-123");
  assert.equal(seen.anthropic, null);
  assert.deepEqual(seen.mcp, { outil: { type: "local", command: ["node", "s.js"], enabled: true } });
  const missing = await runTurn(cfgOf({ ...THREE_LINES, KINDLE_OPENCODE_BIN: join(dir, "absent") }), { prompt: "x", tools: true, cwd: dir });
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? "", /opencode-ai/);
});

// ————— OpenCode réel, si installé : un tour avec bash ET un outil MCP, contre le faux serveur —————

const realOpencode = process.env.KINDLE_OPENCODE_BIN ?? "opencode";
const hasOpencode = spawnSync(realOpencode, ["--version"], { encoding: "utf8", timeout: 20_000 }).status === 0;

test("OpenCode réel : bash puis MCP, hors réseau (sauté si OpenCode n'est pas installé)", { skip: !hasOpencode && "OpenCode absent (npm i -g opencode-ai pour ce test)", timeout: 300_000 }, async () => {
  let step = 0;
  const srv = await startFakeOpenAI({
    reply: (body) => {
      const names = (body.tools ?? []).map((t) => t.function?.name ?? "");
      if (!names.length) return { text: "titre" }; // génération du titre de session
      const last = body.messages?.at(-1);
      if (last?.role !== "tool") return { toolCalls: [{ name: "bash", arguments: { command: "echo kindle-ok", description: "test" } }] };
      step++;
      const mcp = names.find((n) => n.endsWith("ping"));
      if (step === 1 && mcp) return { toolCalls: [{ name: mcp, arguments: {} }] };
      return { text: `FAIT : ${contentText(last.content).trim()}` };
    },
  });
  const root = mkdtempSync(join(tmpdir(), "kindle-oc-real-"));
  try {
    const mcpFile = join(root, "mcp.json");
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { kindletest: { command: process.execPath, args: [join(import.meta.dirname, "fake-mcp-server.ts")] } } }));
    writeFileSync(join(root, "CLAUDE.md"), "Agent de test.\n");
    const c = cfgOf({ KINDLE_BASE_URL: srv.baseUrl, KINDLE_API_KEY: "cle", MODELE_FORT: "modele-fort", KINDLE_OPENCODE_BIN: realOpencode, KINDLE_CLAUDE_PERMISSION_MODE: "bypassPermissions", KINDLE_ALLOW_BYPASS: "1" });
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: join(root, ".config"),
      XDG_DATA_HOME: join(root, ".data"),
      XDG_CACHE_HOME: join(root, ".cache"),
      XDG_STATE_HOME: join(root, ".state"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    };
    const r = await runTurn(c, { prompt: "Lance le test.", tools: true, cwd: root, mcpConfig: mcpFile, timeoutMs: 240_000 }, { env });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.toolCalls[0], "bash");
    assert.ok(r.toolCalls.some((t) => t.endsWith("ping")), `outils vus : ${r.toolCalls.join(", ")}`);
    assert.equal(r.text, "FAIT : mcp-ok");
  } finally {
    await srv.close();
  }
});
