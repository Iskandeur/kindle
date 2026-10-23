/**
 * engine — la façade « moteur » : un tour de ton compagnon, quel que soit le fournisseur d'inférence.
 *
 *     const { config } = readEngineConfig();          // lit KINDLE_ENGINE, KINDLE_BASE_URL, MODELE_FORT…
 *     const r = await runTurn(config, { prompt, tools: true, cwd: repo });
 *     if (!r.ok) …r.error (avec « HTTP 429 » etc., lisible par engine-failover.ts)
 *
 * Aiguillage :
 *
 * | moteur              | `tools: false` (texte seul)        | `tools: true` (bash, édition, MCP) |
 * |---------------------|------------------------------------|------------------------------------|
 * | `claude`            | `claude -p` dans un dossier temp.  | `claude -p` dans `cwd`             |
 * | `openai-compatible` | HTTP direct (`engine-openai.ts`)   | OpenCode (`engine-opencode.ts`)    |
 *
 * Le chemin `claude` est celui d'avant ce module, argument pour argument.
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { modelFor, type EngineConfig } from "./engine-config.ts";
import { runClaude } from "./engine-claude.ts";
import { chatOpenAI, type LocalTool } from "./engine-openai.ts";
import { mcpFromClaude, runOpencode } from "./engine-opencode.ts";
import type { TurnRequest, TurnResult } from "./engine-types.ts";

export type { TurnRequest, TurnResult } from "./engine-types.ts";

export interface TurnDeps {
  /** Outils locaux pour un appel `openai-compatible` sans OpenCode (boucle courte, `engine-openai.ts`). */
  localTools?: LocalTool[];
  fetchFn?: typeof fetch;
  env?: Record<string, string | undefined>;
}

/** Le modèle effectivement demandé pour ce tour (`null` = défaut du CLI Claude). */
export function resolveModel(cfg: EngineConfig, req: TurnRequest): string | null {
  return req.model ?? modelFor(cfg, req.role ?? "fort");
}

export async function runTurn(cfg: EngineConfig, req: TurnRequest, deps: TurnDeps = {}): Promise<TurnResult> {
  const model = resolveModel(cfg, req);
  if (cfg.kind === "claude") {
    return runClaude(cfg, { ...req, cwd: req.tools ? req.cwd : (req.cwd ?? tmpdir()) }, model);
  }
  // openai-compatible : `model` est toujours posé (readEngineConfig exige MODELE_FORT).
  const m = model as string;
  if (req.tools && !deps.localTools) {
    let mcp = {};
    if (req.mcpConfig) {
      try {
        mcp = mcpFromClaude(JSON.parse(readFileSync(req.mcpConfig, "utf8")));
      } catch (e) {
        return { ok: false, text: "", engine: "openai-compatible/opencode", model: m, costUsd: null, usage: { input: null, output: null }, toolCalls: [], error: `config MCP illisible (${req.mcpConfig}) : ${(e as Error).message}` };
      }
    }
    return runOpencode(cfg, req, m, { mcp, allowAll: cfg.claudePermissionMode === "bypassPermissions", env: deps.env });
  }
  return chatOpenAI({
    baseUrl: cfg.baseUrl as string,
    apiKey: cfg.apiKey,
    model: m,
    prompt: req.prompt,
    systemPrompt: req.systemPrompt,
    tools: deps.localTools,
    timeoutMs: req.timeoutMs,
    fetchFn: deps.fetchFn,
  });
}
