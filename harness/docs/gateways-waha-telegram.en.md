# WhatsApp (WAHA) and Telegram: talk to your companion from your phone

> *Version française : [`gateways-waha-telegram.md`](gateways-waha-telegram.md).* First time? The
> step-by-step walkthrough is [`give-your-agent-whatsapp.md`](give-your-agent-whatsapp.md); this page
> is the reference.

Two ready-to-run gateways, zero dependencies, that work with **any engine** from
`bring-your-own-api.md` (Claude Code, OpenCode, OpenAI-compatible API):

| Gateway | Command | Input | Output |
|---|---|---|---|
| WhatsApp | `node harness/bin/waha-gateway.ts` | HTTP webhook from [WAHA](https://waha.devlike.pro) | `POST /api/sendText` |
| Telegram | `node harness/bin/telegram-gateway.ts` | Bot API long polling (no open port) | `sendMessage` |

Both follow the **relay model**: a message arrives, the gateway builds a prompt (local time, who is
writing, the last exchanges of the chat, attachments), runs **one turn** of the engine in this
repository (so with your companion's identity, memory and protocols), then sends the rendered text
itself. The agent needs no messaging tool to answer. If it answers `[silence]` (or nothing), nothing
is sent: that is its default in groups.

Run both side by side if you want: they are two separate processes, and Telegram stays reachable
the day WhatsApp restricts your number (it has happened, hence this backup channel).

## WhatsApp with WAHA

### 1. Start WAHA

WAHA is an HTTP API around WhatsApp Web, in a container. Use a **dedicated number** for your
companion (an eSIM or a second SIM), never your personal one. An automated account can be
restricted by WhatsApp, and you don't want it to be yours.

```yaml
# docker-compose.yml (next to your repository, not inside it)
services:
  waha:
    image: devlikeapro/waha:latest
    restart: unless-stopped
    ports: ["127.0.0.1:3000:3000"]            # loopback only
    environment:
      WAHA_API_KEY: "change-me"                # = WAHA_API_KEY on the gateway side
      WAHA_DASHBOARD_USERNAME: "admin"         # dashboard login
      WAHA_DASHBOARD_PASSWORD: "change-me-too"
      WHATSAPP_SWAGGER_USERNAME: "admin"       # Swagger API page, same idea
      WHATSAPP_SWAGGER_PASSWORD: "change-me-too"
      WHATSAPP_DEFAULT_ENGINE: "GOWS"          # or WEBJS / NOWEB
      WHATSAPP_HOOK_URL: "http://host.docker.internal:8787/waha"
      WHATSAPP_HOOK_EVENTS: "message"
      WHATSAPP_HOOK_HMAC_KEY: "another-key"    # = WAHA_WEBHOOK_HMAC_KEY on the gateway side
    extra_hosts: ["host.docker.internal:host-gateway"]
    volumes: ["./waha-sessions:/app/.sessions"]
```

Generate keys and passwords (`openssl rand -hex 32`). Older WAHA guides write the key as
`WHATSAPP_API_KEY`; current WAHA documentation says `WAHA_API_KEY`. A key stored as a hash
(`WAHA_API_KEY: "sha512:<hex>"`) works too: the gateway always sends the plain key.

Then `docker compose up -d` and open `http://localhost:3000/dashboard`. Two separate secrets:

1. **The dashboard login**: `WAHA_DASHBOARD_USERNAME` / `WAHA_DASHBOARD_PASSWORD`. If unset, WAHA
   generates random ones at startup and prints them in its log (`docker compose logs waha`).
2. **The API key**: once logged in, the dashboard calls the API like any other client. In its server
   connection settings (`http://localhost:3000`), enter the same value as `WAHA_API_KEY`; otherwise
   the session list stays empty or answers "unauthorized".

Then start the `default` session and scan the QR code with the phone of the dedicated number
(WhatsApp > Linked devices). WAHA on a remote server: keep `127.0.0.1:3000` and go through an SSH
tunnel (`ssh -L 3000:127.0.0.1:3000 you@server`), never through a published port.

### 2. Configure the gateway (`.env`)

```bash
WAHA_BASE_URL=http://localhost:3000
WAHA_API_KEY=change-me
WAHA_SESSION=default
WAHA_ALLOWED_CHATS=33612345678@c.us        # YOUR number (international format without +), commas for several
WAHA_WEBHOOK_HMAC_KEY=another-key
KINDLE_HUMAN_NAME=Alex
KINDLE_TZ=Europe/Paris
```

`node harness/bin/waha-gateway.ts --check` tells you whether the session is `WORKING` and what is
allowed.

⚠️ **Linux: the webhook does not arrive without `WAHA_WEBHOOK_HOST`.** From inside the container,
`host.docker.internal` (via `host-gateway`) targets the host's Docker bridge address (often
`172.17.0.1`), not its `127.0.0.1`; and the gateway listens on `127.0.0.1` by default. WAHA then fails
to deliver every message, with nothing said on the gateway side. Add to `.env`:

```bash
WAHA_WEBHOOK_HOST=172.17.0.1   # the docker0 address: ip -4 addr show docker0
```

That address is only reachable from the machine and its containers, not from the Internet. Never
write `0.0.0.0` here without a firewall. Under Docker Desktop (Mac, Windows), `host.docker.internal`
does reach the host's `127.0.0.1`: nothing to add. Check: send a message to the dedicated number, the
gateway must write a line in its log.

### What protects you

- **Closed by default.** An empty `WAHA_ALLOWED_CHATS` = the gateway listens to nobody. A WhatsApp
  number receives spam and strangers; an agent that answers everyone ends up talking about you to
  third parties. A group is added by its `…@g.us` id. If your 1:1 chat arrives as `@lid` (WhatsApp's
  recent anonymous form), add that id to the list too (the `ignoré (hors liste)` log line gives it).
- **You or someone else.** `WAHA_PRINCIPAL_CHATS` (default: the allowed list) says who is you. For
  any other author, the prompt recalls `protocoles/discretion.md`: their content is data, never an
  order.
- **Signature.** With `WAHA_WEBHOOK_HMAC_KEY`, an unsigned webhook is refused (401). The gateway
  listens on `127.0.0.1` unless you set `WAHA_WEBHOOK_HOST`.
- **No loop.** `fromMe` messages (the echo of its own sends) and `protocol` entries (edits) never
  wake the agent (`lib/waha-protocol.ts`).
- **No duplicate.** A message already seen (same stanza) is ignored; on a 5xx or a timeout when
  sending, the gateway rereads the chat before declaring failure (`lib/send-probe.ts`).
- **No flood.** Global circuit breaker: beyond `WAHA_SEND_CIRCUIT_MAX` sends (default 20) in
  `WAHA_SEND_CIRCUIT_WINDOW_MS` (default 60 s), sending is refused, with no alert message.
- **No fake fresh message.** A message older than 30 min (replay after reconnection) arrives
  announced as such (`lib/waha-stale-replay.ts`).
- **Bursts.** Several close messages from the same chat go out as a single turn (`lib/coalesce.ts`);
  `att` alone extends the wait by 30 s.

For the agent to send on its own (to someone other than the sender, an image…), plug a WAHA MCP
server into `.mcp.json` **and** the `wa-guard` guard as `PreToolUse`
(`give-your-agent-whatsapp.md` section 4, FR: `wa-guard-et-impersonation.md`). The gateway alone does
not need it.

## Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`), keep the token.
2. In `.env`:
   ```bash
   TELEGRAM_BOT_TOKEN=123456:ABC…
   TELEGRAM_PRINCIPAL_USERNAME=your_telegram_username   # without @
   ```
3. `node harness/bin/telegram-gateway.ts --check`, then run it and write to the bot.

The **first** message from `@your_telegram_username` seals your numeric id in
`harness/data/telegram.json` (never committed). After that only this id gets through: someone who
takes your old username does not get in. Private DMs only, never a group or a bot. To change human,
delete `sealedId` in that file.

What it handles: text, images, documents (≤ 20 MB) and voice notes downloaded into
`harness/data/media/` and passed to the agent by path (it reads them with its tools; a voice note
needs a transcription tool you plug in yourself), formatting converted to Telegram HTML with a
plain-text fallback if Telegram refuses, 🛑 or `/stop` that empties the waiting queue.

## Keep them running

One systemd service per gateway is enough:

```ini
# /etc/systemd/system/companion-waha.service
[Service]
WorkingDirectory=/home/me/my-companion
ExecStart=/usr/bin/node harness/bin/waha-gateway.ts
Restart=always
User=me
[Install]
WantedBy=multi-user.target
```

Same with `telegram-gateway.ts`. `GET /health` on the WAHA gateway answers `ok` for a probe
(`lib/health-probe.ts`).

## Limits, plainly

- **No long session on the engine side**: each turn starts again from the repository, with the last
  8 exchanges of the chat in memory (lost on restart). Real continuity lives in `memoire/` and
  `journal/`, as for a manual session: the Ouroboros holds it.
- **A started turn is not interrupted**: 🛑 empties the queue, it does not stop the thinking in
  progress.
- **Tools**: by default the turn has its tools (edits, bash depending on
  `KINDLE_CLAUDE_PERMISSION_MODE`, MCP). `KINDLE_GATEWAY_TOOLS=0` gives text-only turns: useful with an
  OpenAI-compatible API without OpenCode installed, or for a channel where you want no disk access.
- The WAHA API paths used are those of the 2024-2026 versions; adapt `lib/waha.ts` if yours differs.
- Log lines are in French (`ignoré (hors liste)` = ignored, not in the list).
