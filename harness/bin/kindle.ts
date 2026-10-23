#!/usr/bin/env node
/**
 * kindle — vérifier et utiliser le moteur d'inférence de ton compagnon.
 *
 *   node harness/bin/kindle.ts doctor           # la config est-elle bonne ? le fournisseur répond-il ?
 *   node harness/bin/kindle.ts doctor --fake    # la même chaîne contre un faux serveur local (aucun compte)
 *   node harness/bin/kindle.ts opencode-config [--write]
 *                                                # la config OpenCode du mode session (sans la clé)
 *   node harness/bin/kindle.ts ask "Bonjour" [--outils] [--role rapide|fort]
 *
 * La config vient de l'environnement, complété par le `.env` à la racine du dépôt s'il existe (une
 * variable déjà posée dans le shell n'est pas écrasée). Variables : voir `.env.example`.
 * Code de sortie : 0 si tout va bien, 1 sinon.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeConfig, readEngineConfig, type EngineConfig } from "../src/lib/engine-config.ts";
import { runTurn } from "../src/lib/engine.ts";
import { listModels } from "../src/lib/engine-openai.ts";
import { buildOpencodeConfig, mcpFromClaude } from "../src/lib/engine-opencode.ts";
import { startFakeOpenAI } from "../src/lib/fake-openai-server.ts";

const repo = join(import.meta.dirname, "..", "..");
const envFile = join(repo, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(name);
const option = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

const ok = (s: string) => console.log(`  ✓ ${s}`);
const ko = (s: string) => console.log(`  ✗ ${s}`);
const note = (s: string) => console.log(`  · ${s}`);

function loadConfig(env: Record<string, string | undefined> = process.env): EngineConfig | null {
  const { config, errors, warnings } = readEngineConfig(env);
  for (const e of errors) ko(e);
  for (const w of warnings) note(w);
  return config;
}

function binVersion(bin: string): string | null {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 20_000 });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || r.stderr).trim().split("\n")[0];
}

function mcpOfRepo() {
  const f = join(repo, ".mcp.json");
  if (!existsSync(f)) return {};
  return mcpFromClaude(JSON.parse(readFileSync(f, "utf8")));
}

async function doctor(cfg: EngineConfig): Promise<boolean> {
  let good = true;
  for (const l of describeConfig(cfg)) note(l);
  if (cfg.kind === "claude") {
    const v = binVersion(cfg.claudeBin);
    if (v) ok(`CLI Claude présent (${v})`);
    else {
      ko(`« ${cfg.claudeBin} » introuvable : npm i -g @anthropic-ai/claude-code, puis \`claude\` une fois pour te connecter.`);
      return false;
    }
  } else if (cfg.kind === "opencode") {
    const v = binVersion(cfg.opencodeBin);
    if (!v) {
      ko(`« ${cfg.opencodeBin} » introuvable : npm i -g opencode-ai, puis \`opencode auth login\` (ou un modèle gratuit d'OpenCode Zen).`);
      return false;
    }
    ok(`OpenCode présent (${v})`);
    const ls = spawnSync(cfg.opencodeBin, ["models"], { encoding: "utf8", timeout: 60_000 });
    const known = ls.status === 0 ? ls.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
    if (known.length) {
      ok(`${known.length} modèle(s) connu(s) d'OpenCode`);
      for (const role of ["fort", "rapide"] as const) {
        const m = cfg.models[role] as string;
        if (!known.includes(m)) {
          ko(`MODELE_${role.toUpperCase()}=« ${m} » absent de \`opencode models\`. Exemples : ${known.slice(0, 8).join(", ")}`);
          good = false;
        }
      }
    } else note("`opencode models` n'a rien rendu : on tente quand même un tour.");
    const settings = join(repo, ".claude", "settings.json");
    if (existsSync(settings) && /"hooks"\s*:/.test(readFileSync(settings, "utf8"))) {
      ko("`.claude/settings.json` déclare des hooks : ils ne tournent PAS sous OpenCode. Voir harness/docs/brancher-ton-api.md § 6.");
    }
  } else {
    const list = await listModels(cfg.baseUrl as string, cfg.apiKey);
    if (!list.ok) {
      ko(`GET ${cfg.baseUrl}/models : ${list.error}`);
      note("Certains fournisseurs n'exposent pas /models : on tente quand même un appel.");
    } else {
      ok(`${list.models.length} modèle(s) servi(s)`);
      for (const role of ["fort", "rapide"] as const) {
        const m = cfg.models[role] as string;
        if (list.models.length && !list.models.includes(m)) {
          ko(`MODELE_${role.toUpperCase()}=« ${m} » absent de /models. Disponibles : ${list.models.slice(0, 15).join(", ")}`);
          good = false;
        }
      }
    }
    const settings = join(repo, ".claude", "settings.json");
    if (existsSync(settings) && /"hooks"\s*:/.test(readFileSync(settings, "utf8"))) {
      ko("`.claude/settings.json` déclare des hooks : ils ne tournent PAS sous OpenCode (un garde-fou en PreToolUse, comme wa-guard, est inactif). Voir harness/docs/brancher-ton-api.md § 6.");
    }
    const v = binVersion(cfg.opencodeBin);
    if (v) ok(`OpenCode présent (${v}) : les tours avec outils marcheront`);
    else note(`OpenCode absent : les tours AVEC OUTILS échoueront (npm i -g opencode-ai). Le texte seul marche sans lui.`);
  }
  const t0 = Date.now();
  const r = await runTurn(cfg, { prompt: "Réponds seulement par le mot : pong", role: "rapide", timeoutMs: 120_000 });
  if (r.ok) ok(`un tour de texte (${r.model}, ${Date.now() - t0} ms) : « ${r.text.trim().slice(0, 60)} »`);
  else {
    ko(`un tour de texte (${r.model}) : ${r.error}`);
    good = false;
  }
  return good;
}

async function doctorFake(): Promise<boolean> {
  const srv = await startFakeOpenAI({ apiKey: "cle-factice" });
  try {
    note(`faux serveur compatible OpenAI sur ${srv.baseUrl}`);
    const cfg = loadConfig({
      KINDLE_BASE_URL: srv.baseUrl,
      KINDLE_API_KEY: "cle-factice",
      MODELE_FORT: "modele-fort",
      MODELE_RAPIDE: "modele-rapide",
      KINDLE_QUOTA: "illimite",
      KINDLE_OPENCODE_BIN: process.env.KINDLE_OPENCODE_BIN,
    });
    if (!cfg) return false;
    let good = await doctor(cfg);
    if (binVersion(cfg.opencodeBin)) {
      // Dossier jetable, jamais le dépôt ; permissions minimales : seule la commande `echo kindle-ok` est permise.
      const scratch = mkdtempSync(join(tmpdir(), "kindle-doctor-"));
      writeFileSync(join(scratch, "CLAUDE.md"), "Agent de test de kindle doctor.\n");
      const r = await runTurn(cfg, { prompt: "Lance la commande de test.", tools: true, cwd: scratch, timeoutMs: 180_000 }, { bashAllow: ["echo kindle-ok"] });
      rmSync(scratch, { recursive: true, force: true });
      if (r.ok && r.toolCalls.includes("bash")) ok(`un tour avec outil via OpenCode : ${r.toolCalls.join(", ")} → « ${r.text} »`);
      else {
        ko(`un tour avec outil via OpenCode : ${r.error ?? "aucun outil appelé"}`);
        good = false;
      }
    }
    return good;
  } finally {
    await srv.close();
  }
}

async function main(): Promise<number> {
  switch (cmd) {
    case "doctor": {
      console.log("kindle doctor");
      if (flag("--fake")) return (await doctorFake()) ? 0 : 1;
      const cfg = loadConfig();
      if (!cfg) return 1;
      return (await doctor(cfg)) ? 0 : 1;
    }
    case "opencode-config": {
      const cfg = loadConfig();
      if (!cfg) return 1;
      if (cfg.kind === "claude") {
        ko("opencode-config sert aux moteurs openai-compatible (KINDLE_BASE_URL + MODELE_FORT) et opencode (KINDLE_ENGINE=opencode + MODELE_FORT).");
        return 1;
      }
      const conf = JSON.stringify(buildOpencodeConfig(cfg, { mcp: mcpOfRepo() }), null, 2) + "\n";
      if (flag("--write")) {
        const out = join(repo, "opencode.json");
        writeFileSync(out, conf);
        ok(`écrit : ${out} ${cfg.kind === "opencode" ? "(aucun fournisseur déclaré : OpenCode garde ses propres identifiants)" : "(sans la clé : OpenCode la lit dans KINDLE_API_KEY)"}`);
      } else process.stdout.write(conf);
      return 0;
    }
    case "ask": {
      const prompt = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--role").join(" ");
      if (!prompt) {
        ko('usage : kindle ask "<message>" [--outils] [--role rapide|fort]');
        return 1;
      }
      const cfg = loadConfig();
      if (!cfg) return 1;
      const role = option("--role") === "rapide" ? "rapide" : "fort";
      const r = await runTurn(cfg, { prompt, role, tools: flag("--outils"), cwd: repo });
      if (!r.ok) {
        ko(r.error ?? "échec");
        return 1;
      }
      console.log(r.text);
      const cost = r.costUsd === null ? "coût non chiffré" : `${r.costUsd.toFixed(4)} $`;
      console.error(`[${r.engine} · ${r.model} · ${cost}${r.toolCalls.length ? ` · outils : ${r.toolCalls.join(", ")}` : ""}]`);
      return 0;
    }
    default:
      console.log("usage : kindle doctor [--fake] | opencode-config [--write] | ask \"<message>\" [--outils] [--role rapide|fort]");
      return cmd ? 1 : 0;
  }
}

process.exitCode = await main();
