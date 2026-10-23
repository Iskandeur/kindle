/**
 * fake-openai-server — un faux fournisseur d'inférence « compatible OpenAI », local, sans réseau.
 *
 * Sert aux tests (et au `kindle doctor --fake`) : il parle juste assez du protocole pour qu'un client
 * réel s'y trompe — `GET /v1/models`, `POST /v1/chat/completions` en réponse entière ET en flux SSE,
 * avec des appels d'outil (`tool_calls`) et un bloc `usage`. Ce qu'il répond est SCRIPTÉ : par défaut,
 * s'il reçoit des outils et que le dernier message n'est pas un résultat d'outil, il en appelle un ;
 * sinon il conclut en citant le résultat reçu. Un vrai tour agentique en deux appels, donc.
 *
 * Écoute sur 127.0.0.1 uniquement, port aléatoire. Chaque requête est gardée dans `requests` pour que
 * le test vérifie ce que le client a vraiment envoyé (modèle, clé, messages, outils).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** Ce que le faux modèle répond à un appel : du texte, ou des appels d'outil. */
export interface FakeReply {
  text?: string;
  toolCalls?: FakeToolCall[];
}

export interface FakeRequest {
  path: string;
  method: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

export interface FakeServerOptions {
  /** Noms de modèle annoncés par `/v1/models` (défaut : `modele-fort`, `modele-rapide`). */
  models?: string[];
  /** Clé attendue (`Authorization: Bearer …`). Absent = toute requête passe. */
  apiKey?: string;
  /** Script de réponse. Défaut : `defaultScript("bash", {command:"echo kindle-ok"})`. */
  reply?: (body: ChatBody) => FakeReply;
}

export interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
}

export interface ChatBody {
  model?: string;
  stream?: boolean;
  messages?: ChatMessage[];
  tools?: Array<{ type?: string; function?: { name?: string } }>;
}

export interface FakeServer {
  baseUrl: string;
  requests: FakeRequest[];
  close(): Promise<void>;
}

/** Texte d'un `content` OpenAI (chaîne ou tableau de parts). */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .join("");
  }
  return "";
}

/** Script par défaut : appelle `tool` (s'il est offert) tant qu'aucun résultat d'outil n'est revenu,
 *  puis conclut par « FAIT : <résultat> ». Sans outils offerts : répond « pong ». */
export function defaultScript(tool: string, args: Record<string, unknown>): (body: ChatBody) => FakeReply {
  return (body) => {
    const messages = body.messages ?? [];
    const last = messages[messages.length - 1];
    const offered = (body.tools ?? []).some((t) => t.function?.name === tool);
    if (last?.role === "tool") return { text: `FAIT : ${contentText(last.content).trim().slice(0, 200)}` };
    if (offered) return { toolCalls: [{ name: tool, arguments: args }] };
    return { text: "pong" };
  };
}

const USAGE = { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 };

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function toolCallsPayload(calls: FakeToolCall[], n: number) {
  return calls.map((c, i) => ({
    index: i,
    id: `call_${n}_${i}`,
    type: "function",
    function: { name: c.name, arguments: JSON.stringify(c.arguments) },
  }));
}

export async function startFakeOpenAI(opts: FakeServerOptions = {}): Promise<FakeServer> {
  const models = opts.models ?? ["modele-fort", "modele-rapide"];
  const reply = opts.reply ?? defaultScript("bash", { command: "echo kindle-ok", description: "test de fumée" });
  const requests: FakeRequest[] = [];
  let counter = 0;

  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const raw = req.method === "POST" ? await readBody(req) : "";
    let body: Record<string, unknown> | null = null;
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    const authorization = req.headers.authorization ?? null;
    requests.push({ path, method: req.method ?? "GET", authorization, body });

    if (opts.apiKey && authorization !== `Bearer ${opts.apiKey}`) {
      return json(res, 401, { error: { message: "clé invalide", type: "invalid_api_key" } });
    }
    if (req.method === "GET" && /\/models$/.test(path)) {
      return json(res, 200, { object: "list", data: models.map((id) => ({ id, object: "model", owned_by: "fake" })) });
    }
    if (req.method !== "POST" || !/\/chat\/completions$/.test(path) || !body) {
      return json(res, 404, { error: { message: `inconnu : ${req.method} ${path}` } });
    }
    const chat = body as ChatBody;
    if (chat.model && !models.includes(chat.model)) {
      return json(res, 404, { error: { message: `modèle inconnu : ${chat.model}`, type: "model_not_found" } });
    }
    counter += 1;
    const id = `chatcmpl-fake-${counter}`;
    const r = reply(chat);
    const calls = r.toolCalls && r.toolCalls.length > 0 ? toolCallsPayload(r.toolCalls, counter) : null;
    const finish = calls ? "tool_calls" : "stop";
    const created = Math.floor(Date.now() / 1000);

    if (!chat.stream) {
      return json(res, 200, {
        id,
        object: "chat.completion",
        created,
        model: chat.model,
        choices: [
          {
            index: 0,
            message: calls ? { role: "assistant", content: null, tool_calls: calls.map(({ index: _i, ...c }) => c) } : { role: "assistant", content: r.text ?? "" },
            finish_reason: finish,
          },
        ],
        usage: USAGE,
      });
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const chunk = (delta: Record<string, unknown>, finishReason: string | null, extra: Record<string, unknown> = {}) =>
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: chat.model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra })}\n\n`,
      );
    chunk({ role: "assistant", content: "" }, null);
    if (calls) chunk({ tool_calls: calls }, null);
    else chunk({ content: r.text ?? "" }, null);
    chunk({}, finish);
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: chat.model, choices: [], usage: USAGE })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
