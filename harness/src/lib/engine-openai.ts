/**
 * engine-openai — appel DIRECT d'un fournisseur compatible OpenAI (`POST {base}/chat/completions`),
 * zéro dépendance (`fetch` natif).
 *
 * Il sert aux appels qui n'ont pas besoin d'un agent complet : classer un message (routeur pré-vol),
 * extraire, résumer, répondre à un « ok ». Il sait aussi jouer une boucle d'outils COURTE avec des
 * fonctions que TU fournis (`tools`) : le modèle demande un outil, on exécute ta fonction, on lui rend le
 * résultat, jusqu'à une réponse finale ou `maxSteps`. Ce n'est pas un agent de code : pour bash,
 * l'édition de fichiers et les serveurs MCP, le tour passe par OpenCode (`engine-opencode.ts`).
 *
 * Les erreurs portent le code HTTP (« HTTP 429 … ») pour que `engine-failover.ts` les classe
 * (quota, auth, solde) comme celles du CLI Claude.
 */
import type { TurnResult } from "./engine-types.ts";

export interface LocalTool {
  name: string;
  description: string;
  /** JSON Schema des arguments. */
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<string> | string;
}

export interface ChatOptions {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  prompt: string;
  systemPrompt?: string;
  tools?: LocalTool[];
  /** Nombre maximal d'allers-retours avec le modèle (défaut 6). */
  maxSteps?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

interface ApiMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function result(model: string, partial: Partial<TurnResult>): TurnResult {
  return {
    ok: false,
    text: "",
    engine: "openai-compatible",
    model,
    costUsd: null,
    usage: { input: null, output: null },
    toolCalls: [],
    ...partial,
  };
}

export async function chatOpenAI(o: ChatOptions): Promise<TurnResult> {
  const fetchFn = o.fetchFn ?? fetch;
  const messages: ApiMessage[] = [];
  if (o.systemPrompt) messages.push({ role: "system", content: o.systemPrompt });
  messages.push({ role: "user", content: o.prompt });
  const tools = o.tools ?? [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const toolCalls: string[] = [];
  let input = 0;
  let output = 0;
  let sawUsage = false;
  const maxSteps = o.maxSteps ?? 6;

  for (let step = 0; step < maxSteps; step++) {
    const body: Record<string, unknown> = { model: o.model, messages, stream: false };
    if (tools.length) {
      body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    let res: Response;
    try {
      res = await fetchFn(`${o.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
      });
    } catch (e) {
      return result(o.model, { toolCalls, error: `réseau : ${(e as Error).message}` });
    }
    const raw = await res.text();
    if (!res.ok) return result(o.model, { toolCalls, error: `HTTP ${res.status} ${raw.slice(0, 300)}` });
    let j: { choices?: Array<{ message?: ApiMessage; finish_reason?: string }>; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
    try {
      j = JSON.parse(raw);
    } catch {
      return result(o.model, { toolCalls, error: `réponse illisible : ${raw.slice(0, 200)}` });
    }
    if (j.usage) {
      sawUsage = true;
      input += num(j.usage.prompt_tokens) ?? 0;
      output += num(j.usage.completion_tokens) ?? 0;
    }
    const msg = j.choices?.[0]?.message;
    if (!msg) return result(o.model, { toolCalls, error: "réponse sans `choices[0].message`" });
    const calls = msg.tool_calls ?? [];
    const usage = sawUsage ? { input, output } : { input: null, output: null };
    if (calls.length === 0) {
      return result(o.model, { ok: true, text: typeof msg.content === "string" ? msg.content : "", usage, toolCalls });
    }
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
    for (const c of calls) {
      const name = c.function?.name ?? "";
      toolCalls.push(name);
      const tool = byName.get(name);
      let out: string;
      if (!tool) out = `Erreur : outil inconnu « ${name} ».`;
      else {
        try {
          const args = c.function.arguments ? (JSON.parse(c.function.arguments) as Record<string, unknown>) : {};
          out = await tool.run(args);
        } catch (e) {
          out = `Erreur de l'outil « ${name} » : ${(e as Error).message}`;
        }
      }
      messages.push({ role: "tool", tool_call_id: c.id, content: out });
    }
  }
  return result(o.model, { toolCalls, error: `pas de réponse finale après ${maxSteps} étapes` });
}

/** `GET {base}/models` : la liste des modèles servis, pour `kindle doctor`. */
export async function listModels(baseUrl: string, apiKey: string | null, fetchFn: typeof fetch = fetch): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  try {
    const res = await fetchFn(`${baseUrl}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${raw.slice(0, 200)}` };
    const j = JSON.parse(raw) as { data?: Array<{ id?: unknown }> };
    return { ok: true, models: (j.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string") };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
