/**
 * engine-opencode — les tours AVEC OUTILS du moteur `openai-compatible`, joués par OpenCode.
 *
 * OpenCode (https://opencode.ai, licence MIT) est un CLI agentique libre : bash, lecture/édition de
 * fichiers, serveurs MCP, et n'importe quel fournisseur compatible OpenAI déclaré dans sa config. On le
 * lance en non interactif (`opencode run --format json`), il rend un flux d'évènements JSON (une ligne
 * par évènement : `step_start`, `tool_use`, `text`, `step_finish`) qu'on résume en un `TurnResult`.
 *
 * La clé ne touche jamais le disque : la config générée dit `"apiKey": "{env:KINDLE_API_KEY}"` et la clé
 * passe par l'environnement de l'enfant. La config part dans un fichier temporaire désigné par
 * `OPENCODE_CONFIG` ; un `opencode.json` à la racine du dépôt reste prioritaire (c'est l'ordre de chargement
 * d'OpenCode), donc tes réglages à toi (permissions fines, autres MCP) l'emportent.
 *
 * Permissions, alignées sur `--permission-mode` du moteur `claude` : `bypassPermissions` → tout est permis ;
 * tout autre mode → l'édition est permise, bash est en `ask`. En non interactif, OpenCode REFUSE seul un
 * `ask` (« auto-rejecting ») et le tour s'arrête là : le même comportement que `claude -p`.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineConfig } from "./engine-config.ts";
import type { TurnRequest, TurnResult } from "./engine-types.ts";

/** Identifiant du fournisseur dans la config OpenCode : les modèles s'y appellent `kindle/<nom>`. */
export const OPENCODE_PROVIDER = "kindle";

export type OpencodeMcp =
  | { type: "local"; command: string[]; environment?: Record<string, string>; enabled: boolean }
  | { type: "remote"; url: string; headers?: Record<string, string>; enabled: boolean };

/**
 * Convertit la section `mcpServers` d'un `.mcp.json` (format Claude Code) vers la section `mcp`
 * d'OpenCode : on déclare ses serveurs MCP une fois, ils servent aux deux moteurs. PUR.
 * `{command, args, env}` → `local` ; `{type: "http"|"sse", url, headers}` → `remote`.
 */
export function mcpFromClaude(json: unknown): Record<string, OpencodeMcp> {
  const servers = (json as { mcpServers?: Record<string, Record<string, unknown>> } | null)?.mcpServers ?? {};
  const out: Record<string, OpencodeMcp> = {};
  for (const [name, s] of Object.entries(servers)) {
    if (!s || typeof s !== "object") continue;
    if (typeof s.url === "string") {
      out[name] = { type: "remote", url: s.url, enabled: true, ...(s.headers && typeof s.headers === "object" ? { headers: s.headers as Record<string, string> } : {}) };
    } else if (typeof s.command === "string") {
      const args = Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === "string") : [];
      out[name] = {
        type: "local",
        command: [s.command, ...args],
        enabled: true,
        ...(s.env && typeof s.env === "object" ? { environment: s.env as Record<string, string> } : {}),
      };
    }
  }
  return out;
}

export interface OpencodeConfigOptions {
  /** Fichiers d'instructions lus à chaque tour (défaut : `CLAUDE.md`, l'âme du compagnon). */
  instructions?: string[];
  mcp?: Record<string, OpencodeMcp>;
  /** Tout permettre (équivalent de `bypassPermissions`). */
  allowAll?: boolean;
}

/** La config OpenCode d'un compagnon kindle (PUR). Ne contient jamais la clé, seulement sa référence. */
export function buildOpencodeConfig(cfg: EngineConfig, o: OpencodeConfigOptions = {}): Record<string, unknown> {
  const models: Record<string, { name: string }> = {};
  for (const role of ["fort", "rapide"] as const) {
    const m = cfg.models[role];
    if (m && !models[m]) models[m] = { name: m };
  }
  const conf: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    instructions: o.instructions ?? ["CLAUDE.md"],
    model: `${OPENCODE_PROVIDER}/${cfg.models.fort}`,
    small_model: `${OPENCODE_PROVIDER}/${cfg.models.rapide}`,
    provider: {
      [OPENCODE_PROVIDER]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Kindle (compatible OpenAI)",
        options: { baseURL: cfg.baseUrl, apiKey: "{env:KINDLE_API_KEY}" },
        models,
      },
    },
    permission: o.allowAll ? { edit: "allow", bash: "allow", webfetch: "allow" } : { edit: "allow", bash: "ask", webfetch: "allow" },
  };
  if (o.mcp && Object.keys(o.mcp).length) conf.mcp = o.mcp;
  return conf;
}

/** Arguments de `opencode run` (PUR). */
export function opencodeArgs(req: TurnRequest, model: string): string[] {
  const args = ["run", "--format", "json", "-m", `${OPENCODE_PROVIDER}/${model}`];
  if (req.cwd) args.push("--dir", req.cwd);
  const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt;
  args.push(prompt);
  return args;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Résume le flux `--format json` d'OpenCode (PUR). Le texte final = les parts `text` du DERNIER pas
 * (les pas précédents sont des étapes intermédiaires). Un outil en erreur (refus de permission compris)
 * est compté dans `toolCalls` et rapporté dans `error` si aucun texte final ne suit.
 */
export function parseOpencodeEvents(stdout: string, model: string): TurnResult {
  let lastStepTexts: string[] = [];
  let currentTexts: string[] = [];
  const toolCalls: string[] = [];
  const toolErrors: string[] = [];
  let input: number | null = null;
  let output: number | null = null;
  let cost = 0;
  let sawCost = false;
  let events = 0;
  let errorEvent: string | null = null;

  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let ev: { type?: string; part?: Record<string, unknown>; error?: unknown };
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    events++;
    const part = ev.part ?? {};
    switch (ev.type) {
      case "step_start":
        currentTexts = [];
        break;
      case "text":
        if (typeof part.text === "string") currentTexts.push(part.text);
        break;
      case "tool_use": {
        const name = typeof part.tool === "string" ? part.tool : "?";
        toolCalls.push(name);
        const state = (part.state ?? {}) as { status?: string; error?: unknown };
        if (state.status === "error") toolErrors.push(`${name} : ${String(state.error ?? "erreur")}`);
        break;
      }
      case "step_finish": {
        if (currentTexts.length) lastStepTexts = currentTexts;
        const tokens = (part.tokens ?? {}) as { input?: unknown; output?: unknown };
        const i = num(tokens.input);
        const o = num(tokens.output);
        if (i !== null) input = (input ?? 0) + i;
        if (o !== null) output = (output ?? 0) + o;
        const c = num(part.cost);
        if (c !== null && c > 0) {
          cost += c;
          sawCost = true;
        }
        break;
      }
      case "error":
        errorEvent = JSON.stringify(ev.error ?? part).slice(0, 300);
        break;
    }
  }
  if (currentTexts.length) lastStepTexts = currentTexts;
  const text = lastStepTexts.join("").trim();
  let error: string | undefined;
  if (errorEvent) error = errorEvent;
  else if (!events) error = "aucun évènement JSON reçu d'OpenCode";
  else if (!text && toolErrors.length) error = toolErrors.join(" ; ");
  else if (!text) error = "aucune réponse finale";
  return {
    ok: !error,
    text,
    engine: "openai-compatible/opencode",
    model,
    // OpenCode chiffre 0 un modèle dont il ne connaît pas le prix : 0 veut dire « inconnu », pas « gratuit ».
    costUsd: sawCost ? cost : null,
    usage: { input, output },
    toolCalls,
    error,
  };
}

export interface OpencodeRunOptions extends OpencodeConfigOptions {
  /** Environnement de base de l'enfant (défaut : `process.env`). */
  env?: Record<string, string | undefined>;
}

export function runOpencode(cfg: EngineConfig, req: TurnRequest, model: string, o: OpencodeRunOptions = {}): Promise<TurnResult> {
  const dir = mkdtempSync(join(tmpdir(), "kindle-opencode-"));
  const cfgPath = join(dir, "opencode.json");
  writeFileSync(cfgPath, JSON.stringify(buildOpencodeConfig(cfg, o), null, 2));
  const env: Record<string, string | undefined> = {
    ...(o.env ?? process.env),
    OPENCODE_CONFIG: cfgPath,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    KINDLE_API_KEY: cfg.apiKey ?? "",
  };
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const fail = (error: string): TurnResult => ({
    ok: false,
    text: "",
    engine: "openai-compatible/opencode",
    model,
    costUsd: null,
    usage: { input: null, output: null },
    toolCalls: [],
    error,
  });
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cfg.opencodeBin, opencodeArgs(req, model), { cwd: req.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      cleanup();
      return resolve(fail(`lancement de « ${cfg.opencodeBin} » impossible : ${(e as Error).message}`));
    }
    let out = "";
    let err = "";
    let done = false;
    const finish = (r: TurnResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cleanup();
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(fail(`délai dépassé (${req.timeoutMs} ms)`));
    }, req.timeoutMs ?? 600_000);
    timer.unref?.();
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", (e) =>
      finish(fail(`« ${cfg.opencodeBin} » introuvable ou illançable (${e.message}). Installe OpenCode : npm i -g opencode-ai`)),
    );
    child.on("close", (code) => {
      const r = parseOpencodeEvents(out, model);
      if (!r.ok && code !== 0) r.error = `${r.error} (code ${code}) ${err.trim().slice(-300)}`.trim();
      finish(r);
    });
  });
}
