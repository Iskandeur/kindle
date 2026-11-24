/**
 * gateway — le corps minimal qui écoute : WhatsApp (webhook WAHA) et Telegram (long polling), chaque message autorisé
 * devient un tour du moteur (`lib/engine.ts`, Claude, API compatible OpenAI ou OpenCode) et la réponse repart dans le
 * même fil. Lancé par `bin/gateway.ts` ; tout est injectable (`runTurn`, `fetchFn`) pour les tests.
 *
 * Ce qu'il NE fait pas (volontairement) : écrire en premier, parler dans un groupe non autorisé, envoyer ailleurs que dans
 * le fil d'où vient le message. Le reste du corps (réveils programmés, jobs de fond, garde-fous d'envoi) se branche ici :
 * voir `docs/gateways-whatsapp-telegram.md`.
 */
import http from "node:http";
import { annotateStaleWahaReplay } from "./lib/waha-stale-replay.ts";
import { buildTurnPrompt, ChatQueue, isAllowed, isSilence, type InboundMessage } from "./lib/gateway-core.ts";
import { parseWahaWebhook, verifyWahaHmac, wahaClient, type WahaClient } from "./lib/waha.ts";
import { parseTelegramUpdate, telegramClient, type TelegramClient } from "./lib/telegram.ts";

export interface GatewayOptions {
  /** Un tour de l'agent : le prompt entre, le texte de la réponse sort (ok=false : rien n'est envoyé). */
  runTurn: (prompt: string, m: InboundMessage) => Promise<{ ok: boolean; text: string; error?: string }>;
  host?: string;
  port?: number;
  waha?: { baseUrl: string; apiKey?: string; session?: string; hmacKey?: string; allow: Set<string> } | null;
  telegram?: { token: string; baseUrl?: string; allow: Set<string>; pollTimeoutSec?: number } | null;
  /** Fenêtre au-delà de laquelle un message WhatsApp est annoté « probable rejeu » (défaut 10 min). */
  staleWindowMs?: number;
  fetchFn?: typeof fetch;
  log?: (line: string) => void;
}

export interface Gateway {
  port: number;
  /** Traite un message comme s'il venait d'arriver (tests, réveils internes). */
  handle(m: InboundMessage): Promise<void>;
  close(): Promise<void>;
}

const MAX_BODY = 1024 * 1024;

export async function startGateway(o: GatewayOptions): Promise<Gateway> {
  const log = o.log ?? ((l: string) => console.log(`[gateway] ${l}`));
  const queue = new ChatQueue();
  const wa: WahaClient | null = o.waha ? wahaClient({ baseUrl: o.waha.baseUrl, apiKey: o.waha.apiKey, session: o.waha.session, fetchFn: o.fetchFn }) : null;
  const tg: TelegramClient | null = o.telegram ? telegramClient({ token: o.telegram.token, baseUrl: o.telegram.baseUrl, fetchFn: o.fetchFn }) : null;
  const seen = new Set<string>();

  async function handle(m: InboundMessage): Promise<void> {
    const allow = m.channel === "whatsapp" ? o.waha?.allow : o.telegram?.allow;
    if (!allow || !isAllowed(m, allow)) {
      // Le moyen de trouver l'id à mettre dans la liste blanche : écrire au compagnon, lire cette ligne.
      log(`ignoré (hors liste blanche) : ${m.channel} chat=${m.chatId} de=${m.senderId}`);
      return;
    }
    const dedup = `${m.channel}:${m.id}`;
    if (m.id) {
      if (seen.has(dedup)) return;
      seen.add(dedup);
      if (seen.size > 5000) seen.delete(seen.values().next().value as string);
    }
    await queue.run(`${m.channel}:${m.chatId}`, async () => {
      const ev = annotateStaleWahaReplay({ source: m.channel, msgTs: m.msgTs, ts: Date.now(), body: m.text }, o.staleWindowMs ?? 10 * 60_000);
      const prompt = buildTurnPrompt({ ...m, text: ev.body });
      if (m.channel === "whatsapp") {
        await wa?.sendSeen(m.chatId);
        await wa?.typing(m.chatId, true);
      } else await tg?.typing(m.chatId);
      let r: { ok: boolean; text: string; error?: string };
      try {
        r = await o.runTurn(prompt, m);
      } catch (e) {
        r = { ok: false, text: "", error: (e as Error).message };
      }
      if (m.channel === "whatsapp") await wa?.typing(m.chatId, false);
      if (!r.ok) {
        log(`tour en échec (${m.channel} ${m.chatId}) : ${String(r.error ?? "?").slice(0, 300)}`);
        return;
      }
      if (isSilence(r.text)) return;
      try {
        if (m.channel === "whatsapp") await wa!.sendText(m.chatId, r.text.trim());
        else await tg!.sendMessage(m.chatId, r.text.trim());
      } catch (e) {
        log(`envoi en échec (${m.channel} ${m.chatId}) : ${(e as Error).message}`);
      }
    });
  }

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, whatsapp: Boolean(wa), telegram: Boolean(tg), fils: queue.size }));
      return;
    }
    if (req.method !== "POST" || !req.url?.startsWith("/waha") || !o.waha) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (!verifyWahaHmac(raw, req.headers["x-webhook-hmac"] as string | undefined, o.waha?.hmacKey)) {
        log("webhook WAHA refusé : signature HMAC absente ou fausse");
        res.writeHead(401).end();
        return;
      }
      // On répond tout de suite : WAHA réessaie un webhook lent, et un tour d'agent prend des secondes.
      res.writeHead(200).end();
      let body: unknown;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      const m = parseWahaWebhook(body);
      if (m) void handle(m);
    });
  });
  await new Promise<void>((resolve) => server.listen(o.port ?? 8787, o.host ?? "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  // Telegram : long polling tant que le gateway vit. Une erreur (réseau, 409 d'un autre poller) attend puis reprend.
  const stop = new AbortController();
  let polling: Promise<void> = Promise.resolve();
  if (tg) {
    polling = (async () => {
      let offset = 0;
      let pause = 1000;
      while (!stop.signal.aborted) {
        try {
          const ups = await tg.getUpdates(offset, o.telegram?.pollTimeoutSec ?? 50, AbortSignal.any([stop.signal, AbortSignal.timeout(((o.telegram?.pollTimeoutSec ?? 50) + 15) * 1000)]));
          pause = 1000;
          for (const u of ups) {
            offset = Math.max(offset, u.update_id + 1);
            const m = parseTelegramUpdate(u);
            if (m) void handle(m);
          }
        } catch (e) {
          if (stop.signal.aborted) break;
          log(`Telegram : ${(e as Error).message} (nouvel essai dans ${pause / 1000} s)`);
          await new Promise((r) => setTimeout(r, pause));
          pause = Math.min(pause * 2, 60_000);
        }
      }
    })();
  }
  log(`à l'écoute sur ${o.host ?? "127.0.0.1"}:${port}${wa ? " · WhatsApp (POST /waha)" : ""}${tg ? " · Telegram (long polling)" : ""}`);

  return {
    port,
    handle,
    async close() {
      stop.abort();
      await polling;
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
