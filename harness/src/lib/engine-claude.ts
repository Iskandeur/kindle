/**
 * engine-claude — l'adaptateur du moteur `claude` : le CLI officiel Claude Code en mode non interactif.
 *
 * C'est le chemin historique de kindle, gardé tel quel : `claude -p <prompt> --output-format json`,
 * l'authentification du CLI (OAuth de ton abonnement), et JAMAIS de clé API injectée dans le sous-process
 * (`ANTHROPIC_API_KEY` est retirée de l'environnement de l'enfant).
 *
 * Ce que ce moteur sait et qu'un autre n'a pas forcément : `--max-budget-usd` (plafond par tour),
 * `--permission-mode`, `--mcp-config`, les hooks et plugins de `.claude/settings.json`, et un coût
 * chiffré (`total_cost_usd`) dans la sortie JSON.
 */
import { spawn } from "node:child_process";
import type { EngineConfig } from "./engine-config.ts";
import type { TurnRequest, TurnResult } from "./engine-types.ts";

/** Arguments du CLI pour un tour (PUR, testable). `tools=false` = appel léger de classification :
 *  `--permission-mode default` (aucun outil ne s'exécute sans accord, et personne n'accorde). */
export function claudeArgs(cfg: EngineConfig, req: TurnRequest, model: string | null): string[] {
  const args = ["-p", req.prompt, "--output-format", "json"];
  if (model) args.push("--model", model);
  args.push("--permission-mode", req.tools ? cfg.claudePermissionMode : "default");
  if (cfg.budgetUsd !== null) args.push("--max-budget-usd", String(cfg.budgetUsd));
  if (req.tools && req.mcpConfig) args.push("--mcp-config", req.mcpConfig);
  if (req.systemPrompt) args.push("--append-system-prompt", req.systemPrompt);
  return args;
}

interface ClaudeJson {
  result?: unknown;
  is_error?: unknown;
  subtype?: unknown;
  total_cost_usd?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Lit la sortie `--output-format json` du CLI (PUR). */
export function parseClaudeOutput(stdout: string, model: string | null): TurnResult {
  let j: ClaudeJson;
  try {
    j = JSON.parse(stdout) as ClaudeJson;
  } catch {
    return failed(model, `sortie JSON illisible : ${stdout.slice(0, 200)}`);
  }
  const text = typeof j.result === "string" ? j.result : "";
  const isError = j.is_error === true || (typeof j.subtype === "string" && j.subtype !== "success");
  return {
    ok: !isError,
    text,
    engine: "claude",
    model: model ?? "(défaut du CLI)",
    costUsd: num(j.total_cost_usd),
    usage: { input: num(j.usage?.input_tokens), output: num(j.usage?.output_tokens) },
    toolCalls: [],
    error: isError ? text || String(j.subtype ?? "erreur") : undefined,
  };
}

function failed(model: string | null, error: string): TurnResult {
  return { ok: false, text: "", engine: "claude", model: model ?? "(défaut du CLI)", costUsd: null, usage: { input: null, output: null }, toolCalls: [], error };
}

export function runClaude(cfg: EngineConfig, req: TurnRequest, model: string | null): Promise<TurnResult> {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // garde-fou : l'auth du CLI, jamais une clé API.
  const timeoutMs = req.timeoutMs ?? 600_000;
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cfg.claudeBin, claudeArgs(cfg, req, model), { cwd: req.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve(failed(model, `lancement de « ${cfg.claudeBin} » impossible : ${(e as Error).message}`));
    }
    let out = "";
    let err = "";
    let done = false;
    const finish = (r: TurnResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(failed(model, `délai dépassé (${timeoutMs} ms)`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", (e) => finish(failed(model, `« ${cfg.claudeBin} » : ${e.message}`)));
    child.on("close", (code) => {
      if (out.trim()) return finish(parseClaudeOutput(out, model));
      finish(failed(model, `code ${code} : ${err.trim().slice(0, 300) || "aucune sortie"}`));
    });
  });
}
