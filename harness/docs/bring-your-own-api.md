# Bring your own inference API in 3 lines

*Français : [`brancher-ton-api.md`](brancher-ton-api.md).*

Kindle runs on Claude Code and a Claude subscription by default. If you have another inference API
that speaks the OpenAI protocol (`/v1/chat/completions`), your companion can run on it: vLLM, LiteLLM,
OpenRouter, Together, Groq, Ollama, your company's server…

## 1. Three lines

At the repo root, copy `.env.example` to `.env` (never committed) and fill in:

```bash
KINDLE_BASE_URL=https://inference.example.com/v1
KINDLE_API_KEY=sk-replace-me
MODELE_FORT=model-name
```

That's it. The `openai-compatible` engine is inferred from `KINDLE_BASE_URL`. Models are named by
**role**: `MODELE_FORT` (strong) for the real work, `MODELE_RAPIDE` (fast, optional, defaults to the
strong one) for light tasks such as the pre-flight router. English aliases work too: `MODEL_STRONG`,
`MODEL_FAST`. A local server without a key (Ollama, vLLM): leave `KINDLE_API_KEY` empty.

## 2. Tools (bash, file edits, MCP): OpenCode

A companion has to act: read and write its memory files, run `git commit`, talk to MCP servers. For
those turns kindle goes through [OpenCode](https://opencode.ai), an open-source agentic CLI (MIT) that
accepts any OpenAI-compatible provider:

```bash
npm i -g opencode-ai
```

Calls without tools (classifying a message, summarizing) go straight over HTTP and don't need it.

## 3. Smoke test

```bash
node harness/bin/kindle.ts doctor          # config (key masked), /models, OpenCode, one real turn
node harness/bin/kindle.ts doctor --fake   # the whole chain against a local fake server, no account
node harness/bin/kindle.ts ask "Introduce yourself in one sentence."
node harness/bin/kindle.ts ask --outils "List the files in memoire/."
```

Exit code 0 means ready.

## 4. Living with your companion in a session (without Claude Code)

```bash
node harness/bin/kindle.ts opencode-config --write   # writes opencode.json (no key in it)
opencode                                             # opens the session in the repo
```

`opencode.json` makes OpenCode read `CLAUDE.md` on every turn, declares your provider and both models,
and carries over the MCP servers of your `.mcp.json`. The key is not in it: OpenCode reads
`KINDLE_API_KEY` from the environment. The file is gitignored, and it overrides the config kindle
generates for background turns (fine-grained permissions such as `"bash": {"git *": "allow", "*": "ask"}`).

## 5. Budgets and quota

| | `claude` | `openai-compatible` |
|---|---|---|
| Per-turn dollar cap (`KINDLE_BUDGET_USD`) | enforced (`--max-budget-usd`) | ignored, with a warning |
| Cost of a turn | reported | `null` (unknown), never a made-up 0 |
| Quota | the subscription's | `non-mesure` (not measured), or `illimite` if you set `KINDLE_QUOTA=illimite` |
| May a quota policy defer work? | yes | no: nothing is throttled on a measure that doesn't exist |

`limitsOf(config)` (`src/lib/engine-config.ts`) gives your daemon those four answers, so a quota module
switches to unlimited mode instead of crashing.

## 6. Known limits

What is specific to Claude Code and has no equivalent here:

- **Hooks from `.claude/settings.json` do not run under OpenCode.** A guard set as a `PreToolUse` hook
  (for instance `wa-guard`, which filters WhatsApp sends) is NOT active. Call its `decide` function from
  your own send code, or write an OpenCode plugin (`tool.execute.before`), before you plug in messaging.
- **Claude Code plugins** (Alvearium, `/alvearium:board`) don't load. Alvearium's MCP server is a plain
  stdio server, so declaring it in `.mcp.json` should give the `ticket_*` tools, but that is not verified
  under OpenCode; the automatic session ticket (made by hooks) will be missing either way.
- **Per-turn dollar cap, subscription quota, thinking effort** (`/effort`): no cap, no measure, and the
  effort picked by the router is not passed on.
- **Tool-calling quality depends on the model.** Small open models often break the tool format; pick a
  model sold for function calling as `MODELE_FORT`.
- **OpenCode needs a provider that streams (`stream: true`).** vLLM, LiteLLM, Ollama and OpenRouter do.
  Direct HTTP mode doesn't need it.
- **Permissions**: `KINDLE_CLAUDE_PERMISSION_MODE=acceptEdits` (default) allows edits and sets bash and
  webfetch to "ask"; with no human there, OpenCode rejects on its own and the turn stops, like
  `claude -p`. `bypassPermissions` allows everything (free bash, no hooks): it is refused unless you also set `KINDLE_ALLOW_BYPASS=1`, and then only in a throwaway directory. Whatever your project `opencode.json` allows also
  applies to background turns (it takes precedence): don't put `"bash": "allow"` there just for your session.
- **Environment secrets**: the OpenCode child gets your environment minus `ANTHROPIC_API_KEY`. A model
  with bash can read the other variables (GitHub tokens…). Run your daemon with a trimmed environment
  if you don't trust your provider.
- **Third-party code**: OpenCode loads the `@ai-sdk/openai-compatible` package to talk to your API.
  Version 1.19.4 bundles it (checked offline); another version may download it from npm on first use.

## 7. No-code variant: keep Claude Code, swap the provider

Claude Code can talk to an Anthropic-compatible gateway. A [LiteLLM](https://docs.litellm.ai) proxy
translates to your OpenAI API, and you keep hooks, plugins and subagents:

```bash
litellm --model openai/model-name --api_base https://inference.example.com/v1   # listens on :4000
export ANTHROPIC_BASE_URL=http://127.0.0.1:4000
export ANTHROPIC_AUTH_TOKEN=sk-replace-me
claude --model model-name
```

Not tested in this repo (only the `openai-compatible` engine is). Keep `KINDLE_ENGINE=claude` then: the
`claude` engine removes `ANTHROPIC_API_KEY` from its children's environment, but not
`ANTHROPIC_BASE_URL` or `ANTHROPIC_AUTH_TOKEN`.

## 8. OpenCode as the engine (its providers, its credentials)

Sections 1 to 7 assume an API of your own (URL + key). Without one, or if you prefer the providers OpenCode
manages itself (OpenCode Zen, a subscription, `opencode auth login`), the `opencode` engine leaves the
provider entirely to OpenCode: kindle declares nothing, reads no key, and sends every turn (text-only
included) through `opencode run`.

```bash
npm i -g opencode-ai
opencode models                      # lists the "provider/model" ids
```

```bash
# .env
KINDLE_ENGINE=opencode
MODELE_FORT=opencode/deepseek-v4.1-flash-free
# MODELE_RAPIDE=opencode/glm-5.3-flash-free   # unset = MODELE_FORT
```

- **Roles.** `MODELE_FORT` and `MODELE_RAPIDE` are OpenCode ids in the `provider/model` format, as
  `opencode models` prints them (an id without `/` is refused at startup). They become `model` and
  `small_model` in the generated config, and `-m <id>` on `opencode run`.
- **Free.** An `opencode/…-free` id is an OpenCode Zen model at no charge, "for a limited time" according to
  the provider: the example above existed on 2026-10-23, check `opencode models`. Read what the provider does
  with your prompts before sending it what your companion knows about you: this repo does not verify that.
- **Tools and MCP.** Declare your MCP servers once in `.mcp.json` (Claude Code format); `mcpFromClaude`
  translates them to the `mcp` section of the OpenCode config (`{command, args, env}` → `local`,
  `{url, headers}` → `remote`). Tool turns (`kindle ask --outils`, or `tools: true`) get them; a text-only
  turn has no tools and no MCP (edit, bash and web are denied).
- **Permissions.** As in § 6: `acceptEdits` (default) = edits allowed, bash and web on "ask" (refused on
  their own without a human); `KINDLE_CLAUDE_PERMISSION_MODE=bypassPermissions` = everything allowed.
- **Cost and tokens.** `kindle ask` prints tokens and cost when OpenCode reports them. A free Zen model
  shows `0.0000 $` (true); another model whose price OpenCode doesn't know stays "cost not priced", never an
  invented 0. No dollar cap (`KINDLE_BUDGET_USD` is ignored, with a warning), quota `non-mesure`: nothing is
  deferred.
- **Session config.** `node harness/bin/kindle.ts opencode-config --write` writes `opencode.json`
  (`CLAUDE.md` instructions, models, permissions, MCP, no provider and no key).

**Smoke test:**

```bash
node harness/bin/kindle.ts doctor
node harness/bin/kindle.ts ask --outils "List memoire/ and tell me how many files."
```

`doctor` checks OpenCode, that your two ids appear in `opencode models`, then plays a real turn. With no
network or account, the contract is tested against a fake binary:
`cd harness && node --test src/lib/engine.test.ts` (test "opencode (moteur) : runTurn contre un faux binaire").
The "OpenCode réel" test in the same file does need the real binary (skipped otherwise).

## 9. T3 Code: the interface, not an engine

[T3 Code](https://github.com/pingdotgg/t3code) (repo `pingdotgg/t3code`) is an interface (desktop, web,
mobile app) that drives agents already installed on your machine: Claude Code, Codex, OpenCode, Cursor…
It does not replace kindle's engine: it opens your repo and runs the agent on it. Your companion lives
there as long as the agent reads its files, which this repo prepares.

1. **Install T3 Code**: `npx t3@latest` to try it, or your platform's package (see the project README),
   then run `t3` (server + local web app).
2. **Set up at least one agent** and sign in: `claude auth login`, or `opencode auth login` (or, for a
   provider of your own, the `.env` from § 1, then `opencode-config --write` below).
3. **Prepare the repo** (once): `node harness/bin/kindle.ts opencode-config --write` if you want OpenCode
   (it writes `opencode.json`, which sets models, permissions, MCP and reads `CLAUDE.md`). Nothing to do for
   Claude Code: `CLAUDE.md`, `.claude/settings.json` and `.mcp.json` are already there. `AGENTS.md` (at the
   root) tells any other agent, Codex included, to read `CLAUDE.md` first.
4. **Add the repo as a project** in T3 Code ("Add project": the repo path or the folder picker) and pick the
   session's agent: OpenCode or Claude.
5. **Open a thread** and say "hello": the first time, the agent runs `ONBOARDING.md` (the repo is blank,
   this is its birth); afterwards it resumes from the journal and memory. Memory commits are its own, in
   your repo.

**Smoke test:** in T3 Code, ask "Read CLAUDE.md and tell me the first onboarding step": an answer that
cites `ONBOARDING.md` proves the agent sees the repo's rules. From the command line,
`opencode run "Read CLAUDE.md and name the first onboarding step"` inside the repo gives the same result
without the UI.

**NOT verified here:** T3 Code's graphical interface (no test was played inside it); what it does with
`AGENTS.md`; its per-thread agent choice. Steps 1, 2 and 4 come from the project's documentation; 3 and 5 are
what kindle controls. The § 6 limits still hold: Claude Code hooks and plugins don't run under OpenCode,
even when opened from T3 Code.
