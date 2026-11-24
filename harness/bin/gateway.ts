#!/usr/bin/env node
/**
 * gateway — ton compagnon répond sur WhatsApp (WAHA) et/ou Telegram.
 *
 *   node harness/bin/gateway.ts          # écoute (Ctrl-C pour arrêter)
 *   node harness/bin/gateway.ts check    # dit ce qui est configuré, sonde WAHA et Telegram, sans rien envoyer
 *
 * Config dans `.env` à la racine (voir `.env.example`, section « Messageries ») ; le moteur est celui de `kindle doctor`.
 * Doc : harness/docs/gateways-whatsapp-telegram.md
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readEngineConfig } from "../src/lib/engine-config.ts";
import { runTurn } from "../src/lib/engine.ts";
import { parseAllowlist } from "../src/lib/gateway-core.ts";
import { startGateway } from "../src/gateway.ts";

const repo = join(import.meta.dirname, "..", "..");
const envFile = join(repo, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const env = process.env;

const waha = env.WAHA_URL ? { baseUrl: env.WAHA_URL, apiKey: env.WAHA_API_KEY, session: env.WAHA_SESSION || "default", hmacKey: env.WAHA_HMAC_KEY, allow: parseAllowlist(env.WHATSAPP_ALLOW) } : null;
const telegram = env.TELEGRAM_BOT_TOKEN ? { token: env.TELEGRAM_BOT_TOKEN, allow: parseAllowlist(env.TELEGRAM_ALLOW) } : null;

const { config, errors, warnings } = readEngineConfig(env);
for (const w of warnings) console.log(`  · ${w}`);
if (!config) {
  for (const e of errors) console.log(`  ✗ ${e}`);
  process.exit(1);
}

if (process.argv[2] === "check") {
  let bon = true;
  if (!waha && !telegram) {
    console.log("  ✗ aucun canal : pose WAHA_URL (WhatsApp) et/ou TELEGRAM_BOT_TOKEN (Telegram) dans .env");
    process.exit(1);
  }
  if (waha) {
    try {
      const r = await fetch(`${waha.baseUrl.replace(/\/+$/, "")}/api/sessions/${encodeURIComponent(waha.session)}`, { headers: waha.apiKey ? { "X-Api-Key": waha.apiKey } : {}, signal: AbortSignal.timeout(10_000) });
      const j = (await r.json().catch(() => ({}))) as { status?: string };
      console.log(`  ${r.ok && j.status === "WORKING" ? "✓" : "✗"} WAHA session « ${waha.session} » : ${r.ok ? (j.status ?? "?") : `HTTP ${r.status}`}`);
      bon &&= r.ok && j.status === "WORKING";
    } catch (e) {
      console.log(`  ✗ WAHA injoignable (${waha.baseUrl}) : ${(e as Error).message}`);
      bon = false;
    }
    console.log(`  ${waha.allow.size ? "✓" : "·"} WhatsApp, liste blanche : ${waha.allow.size ? [...waha.allow].join(", ") : "vide (personne ne passe ; les ids refusés s'affichent dans le journal)"}`);
    console.log(`  ${waha.hmacKey ? "✓" : "·"} signature HMAC du webhook : ${waha.hmacKey ? "vérifiée" : "non configurée (WAHA_HMAC_KEY recommandé)"}`);
  }
  if (telegram) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${telegram.token}/getMe`, { signal: AbortSignal.timeout(10_000) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: { username?: string } };
      console.log(`  ${j.ok ? "✓" : "✗"} Telegram : ${j.ok ? `@${j.result?.username}` : `HTTP ${r.status} (jeton refusé ?)`}`);
      bon &&= Boolean(j.ok);
    } catch (e) {
      console.log(`  ✗ Telegram injoignable : ${(e as Error).message}`);
      bon = false;
    }
    console.log(`  ${telegram.allow.size ? "✓" : "·"} Telegram, liste blanche : ${telegram.allow.size ? [...telegram.allow].join(", ") : "vide (écris au bot puis lis l'id dans le journal)"}`);
  }
  process.exit(bon ? 0 : 1);
}

const tools = env.GATEWAY_TOOLS === "1";
// Sans outils, un moteur autre que `claude` ne lit pas le dépôt : son identité lui arrive en prompt système (CLAUDE.md).
const ame = join(repo, "CLAUDE.md");
const systemPrompt = config.kind !== "claude" && !tools && existsSync(ame) ? readFileSync(ame, "utf8").slice(0, 40_000) : undefined;
const gw = await startGateway({
  host: env.GATEWAY_HOST || "127.0.0.1",
  port: Number(env.GATEWAY_PORT || 8787),
  waha,
  telegram,
  runTurn: (prompt) => runTurn(config, { prompt, tools, cwd: repo, systemPrompt, timeoutMs: Number(env.GATEWAY_TURN_TIMEOUT_MS || 600_000) }),
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void gw.close().then(() => process.exit(0)));
