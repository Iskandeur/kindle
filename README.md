# ⊙ Kindle

> Start your own **persistent AI companion**: an assistant that knows you, remembers, and grows from
> one session to the next. It comes with [Alvearium](https://github.com/Iskandeur/alvearium), a live
> ticket board, already wired in.

A regular Claude assistant forgets everything between two conversations. Here the assistant lives in
**this repository**: its identity, its memory and its protocols are versioned `.md` files. Each
session makes it a bit more *itself* and a bit more useful to **you**.

> The companion's own files (`CLAUDE.md`, `ONBOARDING.md`, `identite/`, `protocoles/`…) are written
> in French, since that is the language this starter grew up in. The onboarding asks which language
> you want to talk in and writes its own files in it from then on.

## Requirements

- [Claude Code](https://claude.com/claude-code), installed with `npm i -g @anthropic-ai/claude-code`,
  then run `claude` once to log in. **No Claude subscription?** Any OpenAI-compatible inference API
  works instead (vLLM, LiteLLM, OpenRouter, Ollama…), see *Any inference provider* below.
- Node.js 22.13 or later on the `PATH` (Alvearium stores its board with the built-in `node:sqlite`).
- A GitHub account, if you want the memory to persist in the cloud. You can start without.

## Quick start (2 minutes)

1. **Clone the repo** and rename it as you like:
   ```bash
   git clone https://github.com/Iskandeur/Kindle my-companion
   cd my-companion
   ```
2. **Start Claude Code** inside it:
   ```bash
   claude
   ```
   Claude Code asks you to trust the folder. Accept: that is what registers the Alvearium
   marketplace from `.claude/settings.json` (see *Alvearium, built in* below).
3. **Say hello.** It reads its `CLAUDE.md`, understands it was just born and **starts the onboarding
   by itself**: it asks a few questions to build an identity and learn who you are. Let it guide you.

At the end of the onboarding your companion has its first memory, and knows how to grow it every
time you work together.

## Alvearium, built in

[Alvearium](https://github.com/Iskandeur/alvearium) is one live board for all your Claude Code
sessions: what is **waiting on you**, what is **in progress**, what to do **next**. This starter
turns it on by default:

- `.claude/settings.json` declares the `session-board` marketplace (`Iskandeur/alvearium`, with
  auto-update on) and enables the `alvearium` plugin.
- The `CLAUDE.md` tells the companion when to open a ticket: something only you can do, or a long
  task split into steps.

Claude Code may still need the plugin installed once on this machine (it says so with a line like
`Plugin "alvearium" is enabled in project settings but isn't installed`, or `/alvearium:board` is
unknown). In that case:

```bash
claude plugin marketplace add Iskandeur/alvearium
claude plugin install alvearium@session-board
```

The install may print `2 userConfig options not yet set`: those are the server URL and token, only
needed for a shared board, so leave them empty. Then restart the session (a plugin loads when a
session starts). Check it with `/alvearium:board`,
which prints the board. In local mode, nothing leaves your machine: the tickets live in
`~/.claude/session-board/board.db`. To share one board between machines or with a team, see the
[Alvearium README](https://github.com/Iskandeur/alvearium#readme) (self-hosted server, OpenAI Codex
CLI support, cloud sessions).

Don't want it? Delete the `extraKnownMarketplaces` and `enabledPlugins` entries from
`.claude/settings.json` and the *Alvearium* section of `CLAUDE.md`.

## Any inference provider

Kindle is not tied to Claude. With an API that speaks the OpenAI protocol, three lines in `.env`
(copy `.env.example`) switch the engine:

```bash
KINDLE_BASE_URL=https://inference.example.com/v1
KINDLE_API_KEY=sk-replace-me
MODELE_FORT=model-name
```

Then `npm i -g opencode-ai` (the open-source agentic CLI that gives your companion its tools: bash,
file edits, MCP), `node harness/bin/kindle.ts doctor` to check, and
`node harness/bin/kindle.ts opencode-config --write && opencode` to talk to it. Models are named by
role (`MODELE_FORT`, `MODELE_RAPIDE`), budgets and quota degrade to an explicit "unlimited" mode, and
the limits (no Claude Code hooks or plugins) are listed in
[`harness/docs/bring-your-own-api.md`](harness/docs/bring-your-own-api.md)
([français](harness/docs/brancher-ton-api.md)).

**OpenCode as the engine, and T3 Code as the interface.** No endpoint of your own? Set
`KINDLE_ENGINE=opencode` and `MODELE_FORT=<provider/model>` (for example a free
[OpenCode Zen](https://opencode.ai/zen) model): OpenCode keeps its own providers and credentials.
[T3 Code](https://github.com/pingdotgg/t3code) is a desktop/web UI that drives Claude Code, Codex or
OpenCode: open this repo as a project and your companion runs in it, with its memory and rules.
Both are covered, with a smoke test each, in the same guide.

## What is in the repo

| Item | Role |
|---|---|
| `CLAUDE.md` | The "threshold": what your companion reads at every wake-up. |
| `ONBOARDING.md` | The welcome script it follows on the first session. |
| `.claude/settings.json` | Project settings: Alvearium marketplace and plugin. |
| `identite/` | Who it is (personality, values, mission). Blank at first, filled in together. |
| `memoire/` | What it **knows** (about you, about the world). Grows over time. |
| `competences/` | What it knows how to **do** (reusable procedures). Fills up with use. |
| `protocoles/` | Its operating rules: the **Ouroboros** (capitalize, then commit), the **wake-up**, **discretion**. |
| `journal/` | The dated story of its sessions. |
| `plugins/` | A catalog of external tools built by similar agents (`catalog.json`). |
| `harness/` | *(optional)* The body: modules to run your companion continuously. |
| `dashboard/` | *(optional)* A read-only operator dashboard for a running `harness/` daemon. |

## Going further

When you are comfortable, you can plug in **tools** (WhatsApp, calendar, GitHub…) through MCP
servers, or even give your companion a **body**: a small always-on daemon on a server that wakes it
on events (a message received, a scheduled time) instead of waiting for you to open a session. That
is how the agent this starter comes from lives. But start simple: one session, one conversation, a
memory that grows.

The day you take that step, [`harness/`](harness/README.md) gathers standalone, tested modules
carrying patterns proven on a companion in production: a monthly portrait ritual, restarts that
lose no message, merging bursts of messages, bounded continuity in a multi-agent group, wake-up on
mention, self-scheduled wake-ups, long jobs isolated in git worktrees, a model/effort router, an
anti-spam send guard. Take what serves you and ignore the rest. The modules are documented in
French; the code is plain TypeScript.

```bash
cd harness && npm test      # 263 tests at the time of writing
```

Once such a daemon runs, [`dashboard/`](dashboard/README.md) gives a live view of its state (jobs,
wake-ups, cost, sessions) without digging through logs: a native Node app with no dependencies,
started with `docker compose up` or `npm start`. It reads the harness's SQLite database and git
repository, so it only helps once `harness/` is running.

```bash
cd dashboard && npm test    # 21 tests at the time of writing
```

---
*A starting point. Make it yours.*
