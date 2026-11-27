# Give your agent a WhatsApp number

This guide takes you from "my companion lives in a terminal" to "I text it from my phone and it
answers". Three pieces: **a dedicated number**, **WAHA** (the bridge to WhatsApp), and **a send
guard** that stops the agent from getting that number banned. Allow an hour, most of it waiting for
a SIM.

> The detailed, tested reference is in French: [`gateways-waha-telegram.md`](gateways-waha-telegram.md)
> (setup), [`wa-guard-et-impersonation.md`](wa-guard-et-impersonation.md) (send guard) and
> [`../../competences/whatsapp-numero-sans-ban.md`](../../competences/whatsapp-numero-sans-ban.md)
> (how a number gets banned). This page is the English walkthrough that ties them together.

## 1. A number that belongs to the agent, not to you

Get a second number: an eSIM or a cheap prepaid SIM. Install WhatsApp on any phone with it once,
to register it. Never plug your own number in.

Why it matters:

- WAHA drives WhatsApp Web, which is outside WhatsApp's terms of service. Automated accounts get
  restricted, and a brand-new number gets almost no tolerance. If an account has to fall, let it be
  the agent's.
- With its own number, the agent speaks **as itself**. Your contacts never receive a message that
  looks like you but was written by a model.
- Let the number age: a few weeks of normal back-and-forth with you before it writes to anyone else.

If you also want the agent to *read* your personal chats, that is a second WAHA session on your own
number, and it must stay **read-only** (section 4).

## 2. Run WAHA

[WAHA](https://waha.devlike.pro) is an HTTP API around WhatsApp Web, shipped as a Docker container.
Put its `docker-compose.yml` **next to** your companion's repository, not inside it (it holds the
session keys):

```yaml
services:
  waha:
    image: devlikeapro/waha:latest
    restart: unless-stopped
    ports: ["127.0.0.1:3000:3000"]            # loopback only, never exposed
    environment:
      WHATSAPP_API_KEY: "change-me"            # = WAHA_API_KEY in your .env
      WHATSAPP_DEFAULT_ENGINE: "GOWS"
      WHATSAPP_HOOK_URL: "http://host.docker.internal:8787/waha"
      WHATSAPP_HOOK_EVENTS: "message"
      WHATSAPP_HOOK_HMAC_KEY: "another-key"    # = WAHA_WEBHOOK_HMAC_KEY in your .env
    extra_hosts: ["host.docker.internal:host-gateway"]
    volumes: ["./waha-sessions:/app/.sessions"]
```

`docker compose up -d`, open `http://localhost:3000/dashboard`, start the `default` session and scan
the QR code from the phone that holds the dedicated number.

## 3. Plug in the gateway

The gateway receives WAHA's webhook, wakes your companion for one turn in its repository (so with its
identity, memory and rules), and sends the reply back. In `.env` at the root of the repository:

```bash
WAHA_BASE_URL=http://localhost:3000
WAHA_API_KEY=change-me
WAHA_SESSION=default
WAHA_ALLOWED_CHATS=33612345678@c.us   # YOUR number, international format without "+"
WAHA_WEBHOOK_HMAC_KEY=another-key
WAHA_WEBHOOK_HOST=172.17.0.1          # Linux only, see below
KINDLE_HUMAN_NAME=Alex
KINDLE_TZ=Europe/Paris
```

Then:

```bash
node harness/bin/waha-gateway.ts --check   # session WORKING? who is allowed?
node harness/bin/waha-gateway.ts           # run it (systemd unit in gateways-waha-telegram.md)
```

Text the dedicated number from your phone. You should get an answer within a minute.

**On Linux, set `WAHA_WEBHOOK_HOST`.** From inside the container, `host.docker.internal` reaches the
host's Docker bridge address (usually `172.17.0.1`, check with `ip -4 addr show docker0`), not its
`127.0.0.1`, where the gateway listens by default. Without it, WAHA silently fails to deliver every
message. That address is only reachable from the machine and its containers. On Docker Desktop
(Mac, Windows) leave it out.

What the gateway already does for you:

- **Closed by default.** An empty `WAHA_ALLOWED_CHATS` means it listens to nobody. Strangers and spam
  never wake the agent. Add a group by its `…@g.us` id; if your own chat shows up as `…@lid`, add that
  id too (the `ignoré (hors liste)` log line gives it).
- **You versus others.** `WAHA_PRINCIPAL_CHATS` says which chat is you. Anyone else's message reaches
  the agent framed as data, never as orders.
- **Signed webhooks.** With `WAHA_WEBHOOK_HMAC_KEY`, an unsigned webhook is rejected.
- **No loops, no duplicates, no floods.** Its own echoes never wake it; a message seen twice is
  dropped; more than 20 sends a minute trips a circuit breaker.
- **Bursts.** Several quick messages become one turn. Send `att` alone to say "wait, I'm still
  typing".

In this relay mode the agent has **no send tool at all**: it writes a reply and the gateway posts it
to the chat it came from. That is the safest setup, and enough for most people.

## 4. The send guard, once the agent sends on its own

Sooner or later you will want more: the agent writing to a group, sending an image, pinging you
first when a job finishes. That means giving it WAHA's MCP server (send tools in its own hands).
From that moment, **its judgment is the only thing between a bad moment and a banned number**, unless
you add a mechanical guard.

`harness/bin/wa-guard.ts` is that guard: a Claude Code `PreToolUse` hook that sees every WhatsApp send
**before** it leaves and refuses it with a reason the agent can read. It does not rely on the agent
"being careful".

Wire it in `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__whatsapp_.*",
        "hooks": [{ "type": "command", "command": "node harness/bin/wa-guard.ts" }]
      }
    ]
  }
}
```

and name your MCP servers `whatsapp_own` (the agent's number) and `whatsapp_human` (yours, if you
connected it): the guard recognises send tools by the `mcp__whatsapp_<own|human>__send-…` pattern.
Set `WA_GUARD_OWNER` to your own chat id so that writing to you never counts as a fan-out.

What it refuses, by default (`DEFAULT_LIMITS` in `harness/src/wa-guard.ts`):

| Rule | Default |
|---|---|
| Minimum gap between two sends | 4 s |
| Messages per 5 minutes / per hour | 10 / 40 |
| Distinct people written to (you excluded) | 3 per hour, 8 per day |
| Groups | refused unless listed in `harness/config/wa-guard-groups-ok` (committed, so every unlock is a reviewed change) |
| Sending from **your** number | always refused |
| A hold file (`WA_GUARD_HOLD_FILE`) present | everything refused: your emergency stop |

`node harness/bin/wa-guard.ts --status` shows how much room is left.

The last two rows are the important ones. Reading your personal chats can be useful (staying
informed, transcribing your voice notes). Writing **as you** is a different act, so the guard makes
it structurally impossible rather than unlikely. If you ever want the agent to send something in your
name, build it as an explicit approval: the agent drafts, you approve that exact text, then a separate
script sends it (`wa-guard-et-impersonation.md` describes the pattern).

## 5. Habits that keep the number alive

From a companion that lost one (the full post-mortem is in
`competences/whatsapp-numero-sans-ban.md`):

- No broadcasts. Several people to inform: the agent drafts **one** message, you forward it.
- No first contact. The agent writes to someone only after they wrote first, or with your go-ahead.
- A temporary restriction is the warning. During one: total silence on that number, no restart
  loops. Keep a second channel (`harness/bin/telegram-gateway.ts`) for those days.
- `SCAN_QR_CODE` means the login is dead. Only a human with the phone can fix it; restarting the
  container will not.

## Checklist

- [ ] Dedicated number registered on a phone, never your own
- [ ] WAHA on `127.0.0.1:3000`, session `WORKING`
- [ ] `.env` with `WAHA_ALLOWED_CHATS` = your chat only, HMAC key set, `WAHA_WEBHOOK_HOST` on Linux
- [ ] `waha-gateway.ts --check` passes, and a test message gets an answer
- [ ] Before giving the agent send tools: `wa-guard` wired as a `PreToolUse` hook, `WA_GUARD_OWNER` set
