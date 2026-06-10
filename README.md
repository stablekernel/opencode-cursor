# @stablekernel/opencode-cursor

[![npm version](https://img.shields.io/npm/v/@stablekernel/opencode-cursor.svg)](https://www.npmjs.com/package/@stablekernel/opencode-cursor)
[![CI](https://github.com/stablekernel/opencode-cursor/actions/workflows/ci.yml/badge.svg)](https://github.com/stablekernel/opencode-cursor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

An [opencode](https://opencode.ai) plugin that adds a **Cursor** provider backed by the
**official [Cursor SDK](https://cursor.com/docs/sdk/typescript)** (`@cursor/sdk`).

It uses your Cursor API key to:

- register a `cursor` provider in opencode,
- **list the models available to your account** (live, via `Cursor.models.list()`), and
- run chats through Cursor's local agent runtime (`Agent.create` / `agent.send`), streaming
  text and reasoning back into opencode (Cursor's own tool activity is surfaced as structured tool
  blocks by default; see [Tool display](#tool-display)).

This plugin registers Cursor as a **native opencode provider**: its models appear in
`opencode models` and the model picker, and you talk to a Cursor model *directly* — with live model
discovery, variants, MCP forwarding, and session reuse. For delegated or background workflows it
also ships two permission-gated tools (`cursor_delegate`, `cursor_cloud_agent`); see
[Provider vs. delegation tools](#provider-vs-delegation-tools).

> ⚠️ **Security.** When you chat with a `cursor/*` model, Cursor runs its own tools — including
> `shell`, `write`, `edit`, and `delete` — directly in your working directory, **outside opencode's
> permission system and unsandboxed by default**. Read [Security](#security) before you use it.

## Requirements

- **opencode 1.16+** — the provider targets AI SDK `LanguageModelV3`.
- **Node.js 22+ on your `PATH`** — opencode runs on [Bun](https://bun.sh); the plugin spawns a
  short-lived Node process to host the Cursor SDK (see
  [Runtime: Bun and the Node sidecar](#runtime-bun-and-the-node-sidecar)).
- A **Cursor account and API key** (from the Cursor dashboard).

## Security

> ⚠️ **The provider path is unsandboxed and not gated by opencode permissions.**
> When you chat with a `cursor/*` model, Cursor runs its **own** agent loop and executes its own
> tools — including `shell`, `write`, `edit`, and `delete` — directly in your working directory.
> These run **outside** opencode's `permission` system, and the sandbox is **off by default**, so
> your opencode `permission` rules (e.g. `edit: deny`, `bash: ask`) do **not** apply to them. If you
> need an approval boundary, either set `sandbox: true` in `provider.cursor.options` (runs Cursor's
> tools in Cursor's sandbox) or use the permission-gated **`cursor_delegate`** tool instead of the
> provider path. Only the `cursor_delegate` / `cursor_cloud_agent` tools are gated by opencode's
> `permission` config.

See [SECURITY.md](./SECURITY.md) for the full threat model and how to report a vulnerability.

## How it works

opencode loads two things from this one package:

| opencode concept | What it loads | Export |
| --- | --- | --- |
| Plugin (`plugin` config) | auth + provider registration + dynamic model listing + a refresh tool | `@stablekernel/opencode-cursor` (resolved via the package's `./server` export) |
| Provider (`provider.cursor.npm`) | a Vercel AI SDK `LanguageModelV3` that drives a local Cursor agent | `@stablekernel/opencode-cursor` (`createCursor`) |

The plugin's `config` hook registers `provider.cursor` (pointing `npm` at this package) and seeds
it with discovered/fallback models. The `auth` hook stores your API key and feeds it to the
provider factory; the key is validated on first use (model discovery / the first call), not at
login. The `provider.models()` hook refreshes the catalog live once you're authenticated.

## Install

```bash
npm install @stablekernel/opencode-cursor
```

Add the plugin to your `opencode.json` (project or global):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@stablekernel/opencode-cursor"]
}
```

You do **not** need to hand-write the `provider` block — the plugin injects it. If you prefer to
configure it explicitly, the equivalent is:

```json
{
  "provider": {
    "cursor": {
      "npm": "@stablekernel/opencode-cursor",
      "name": "Cursor",
      "options": { "apiKey": "{env:CURSOR_API_KEY}" }
    }
  }
}
```

## Authenticate

Either run the interactive login:

```bash
opencode auth login   # choose "Cursor", paste your key from the Cursor dashboard
```

…or set the environment variable the Cursor SDK reads:

```bash
export CURSOR_API_KEY="key_..."
```

The key is never logged or written to disk by this plugin. It is validated on first use (model
discovery and the first call surface an invalid key clearly), not at login time.

## Use

- `opencode models` (or the in-app model picker) lists your Cursor models as `cursor/<id>`.
- Pick a Cursor model and chat. The Cursor **local** agent runs in your project working directory.
- Run the `cursor_refresh_models` tool to force a live catalog refresh (bypasses the 24h cache).

This plugin also registers two **delegation tools** that complement the provider (see
[Delegation tools](#delegation-tools)):

- `cursor_delegate` — hand a discrete subtask to a local Cursor agent as a permission-gated,
  auditable opencode tool call (your primary model stays in control).
- `cursor_cloud_agent` — launch a Cursor **cloud** (background) agent on a remote repo that can run
  for minutes and optionally open a PR.

## Configuration

| Option (`provider.cursor.options`) | Default | Meaning |
| --- | --- | --- |
| `apiKey` | `CURSOR_API_KEY` | Cursor API key |
| `cwd` | `process.cwd()` | Directory the local agent operates in |
| `mode` | `"agent"` | Default Cursor conversation mode (`"agent"` or `"plan"`) |
| `params` | — | Default Cursor model params, `{ <id>: value }` (e.g. `{ thinking: "high" }`) |
| `settingSources` | — | Cursor settings layers to load from disk: `["project","user","all",...]` — pulls in your Cursor **skills**, rules, and `.cursor/mcp.json` |
| `sandbox` | — | Run the agent's tools inside Cursor's sandbox (`true`/`false`) |
| `agents` | — | Cursor subagent definitions (`{ <name>: { description, prompt, model?, mcpServers? } }`) |
| `session` | `false` | Reuse one Cursor agent per opencode session (resume across turns; see below) |
| `forwardMcp` | `true` | Forward opencode's configured MCP servers to the Cursor agent |
| `mcpServers` | — | Extra MCP servers (Cursor `McpServerConfig` shape); merged with forwarded ones |
| `toolDisplay` | `"blocks"` | How Cursor's internal tool activity is shown: `"blocks"` (structured provider-executed tool blocks; default, requires opencode 1.16+) or `"reasoning"` (compact lines, the fallback for older/non-V3 hosts). See [Tool display](#tool-display) |

### Session reuse (`session`)

By default each opencode turn spins up a **fresh** Cursor agent and re-sends the full conversation
transcript — robust, and correct even for opencode's non-chat calls (e.g. title generation). Set
`session: true` to instead keep **one Cursor agent per opencode session**: the provider names the
agent after the session, `Agent.resume()`s it on later turns, and sends only the new message so
Cursor uses its native conversation memory and checkpoints (the agent is visible in Cursor's
dashboard). The opencode session id reaches the provider via the plugin's `chat.params` hook
(`providerOptions.cursor.sessionID`); a failed resume falls back to a fresh turn automatically.

### Per-request controls (`mode`, thinking level)

opencode delivers per-request, provider-specific settings to the model under
`providerOptions.cursor`. This plugin reads:

- `mode` → `"agent"` | `"plan"`
- `params` → `{ <paramId>: value }` mapped to Cursor `ModelSelection.params`
- `thinking` → convenience, mapped to the `thinking` param

These are most naturally driven by opencode's **model variant picker**: the plugin auto-generates
one variant per reasoning/effort level a model advertises (`Cursor.models.list()` parameters). A
boolean parameter (e.g. `thinking: ["false","true"]`) collapses to a single variant named after the
parameter that switches it on (the off state is the default — no variant selected); enum parameters
(e.g. `effort`, `reasoning`) produce one variant per value. Selecting a variant sends its settings
through `providerOptions.cursor`.

> **Plan mode is not a variant.** opencode's **plan agent** (toggled with `Tab`) is mapped to
> Cursor's plan mode automatically by the plugin's `chat.params` hook, so switching opencode into
> plan mode puts the Cursor agent into plan mode too. An explicit `mode` from a selected variant or
> model option still wins.

You can also set controls statically per model:

```json
{ "provider": { "cursor": { "models": {
  "composer-2.5": { "options": { "params": { "thinking": "high" } } }
} } } }
```

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `CURSOR_API_KEY` | — | API key fallback |
| `OPENCODE_CURSOR_MODEL_CACHE_TTL_MS` | `86400000` | Model-list cache lifetime |

To disable MCP forwarding, set `provider.cursor.options.forwardMcp: false` in your opencode config.

## MCP servers

The Cursor agent can use the **same MCP servers you've configured in opencode**. The plugin's
`config` hook reads opencode's `config.mcp`, translates each entry into the Cursor SDK's
`McpServerConfig` shape, and hands them to the agent via `Agent.create({ mcpServers })`:

| opencode `config.mcp` | → Cursor |
| --- | --- |
| `{ type: "local", command: [cmd, ...args], environment }` | `{ type: "stdio", command: cmd, args, env }` |
| `{ type: "remote", url, headers }` | `{ type: "http", url, headers }` |

So if your `opencode.json` defines Serena, your Cursor agent connects to that same Serena — MCP
servers are independent processes, so opencode and the agent each connect to them directly.
Disabled entries (`enabled: false`) are skipped. Turn this off with `forwardMcp: false`.

> Scope note: this forwards **MCP servers**. opencode's *loop-internal* features — its own skills
> and subagents — are not exposed to the Cursor agent (they run inside opencode's agent loop, which
> this provider bypasses). The Cursor agent's *own* skills/rules can be loaded with the
> `settingSources` option (e.g. `["project","user"]`), which reads your local Cursor configuration.

## Delegation tools

Alongside the provider, the plugin registers two tools so it is a **superset** of both the
provider and delegated-tool designs. Both resolve the Cursor API key from your `opencode auth login`
session (or `CURSOR_API_KEY`) and are **permission-gated** via opencode's `permission` config — they
call `context.ask`, so a policy of `allow` runs silently, `ask` prompts, and `deny` blocks:

```json
{ "permission": { "cursor_delegate": "ask", "cursor_cloud_agent": "ask" } }
```

### `cursor_delegate` (local)

Run a single Cursor turn on a fresh (or explicitly resumed) **local** agent and return its result.
Use it when your primary opencode model should stay in control and hand off discrete work to Cursor
as an explicit, auditable tool call.

| Arg | Required | Meaning |
| --- | --- | --- |
| `prompt` | ✅ | The subtask to delegate |
| `model` | ✅ | Cursor model id to run on |
| `mode` | — | `"agent"` or `"plan"` |
| `thinking` | — | Thinking level (e.g. `"high"`) |
| `cwd` | — | Working directory (defaults to the session directory) |
| `sandbox` | — | Run the agent's tools in Cursor's sandbox |
| `agentId` | — | Resume a specific Cursor agent id instead of starting fresh |

### `cursor_cloud_agent` (cloud / background)

Launch a Cursor **cloud** agent against a remote repository. It runs autonomously (potentially for
minutes) and can open a pull request — work that maps poorly onto the synchronous provider path, so
it is exposed as a tool. Returns the cloud agent id, terminal status, result text, and PR url.

| Arg | Required | Meaning |
| --- | --- | --- |
| `prompt` | ✅ | The task for the background agent |
| `repoUrl` | ✅ | Target repository URL (e.g. `https://github.com/owner/repo`) |
| `startingRef` | — | Branch/ref to start from (defaults to the repo default) |
| `model` | — | Cursor model id (optional for cloud) |
| `mode` | — | `"agent"` or `"plan"` |
| `thinking` | — | Thinking level (e.g. `"high"`) |
| `autoCreatePR` | — | Open a PR automatically when finished |
| `workOnCurrentBranch` | — | Operate on the current branch instead of a new one |

## Provider vs. delegation tools

This package ships two complementary ways to use Cursor inside opencode:

- **Provider** (`cursor/*` models) — chat with a Cursor model directly, integrated into opencode's
  normal model/variant UX, with live model discovery, MCP forwarding, and session reuse. Cursor runs
  its own tools internally (surfaced per the [`toolDisplay`](#tool-display) option).
- **Delegation tools** — `cursor_delegate` hands a discrete subtask to a local Cursor agent as a
  permission-gated, auditable tool call (your primary opencode model stays in control); and
  `cursor_cloud_agent` launches a background agent on a remote repo that can run for minutes and
  optionally open a PR.

**When to use which.** Use the **provider** when you want Cursor to *be* a model you select and
converse with, integrated into opencode's normal model/variant UX. Use **`cursor_delegate`** when
you want your existing opencode model to stay in control and hand off discrete tasks as explicit,
permission-gated tool calls. Use **`cursor_cloud_agent`** when you need background work on a remote
repo with optional PR creation.

## Behavior & limitations

> The provider path runs Cursor's own unsandboxed tools outside opencode's permission system — see
> [Security](#security).

This plugin runs Cursor as a **local agent** (`Agent.create({ local: { cwd } })`), so:

- **Cursor executes its own tools** (read/write/edit/shell/grep/mcp/…) directly in your working
  directory. How that activity is shown is controlled by the [`toolDisplay`](#tool-display) option.
  Either way it is **not** routed through opencode's tool/permission system — Cursor runs the tools
  itself.
- By default each turn creates a fresh local agent and sends the full conversation transcript, so
  context is always complete. Enable `session: true` to reuse Cursor's native per-agent memory
  across turns (see [Session reuse](#session-reuse-session)).
- Token usage is reported from Cursor's `turn-ended` event; cost is shown as `0` because Cursor
  bills your account separately.
- **Provider path is local.** The `cursor/*` models you chat with run as a **local** agent. Cursor's
  **cloud** runtime (background agents on a remote repo with optional PR creation) maps awkwardly
  onto a synchronous provider call, so it is exposed as the `cursor_cloud_agent` **tool** instead of
  the provider path — see [Delegation tools](#delegation-tools).

### Runtime: Bun and the Node sidecar

opencode runs on [Bun](https://bun.sh). Bun's `node:http2` client is currently incompatible with the
Cursor SDK's long-lived streaming RPC (it aborts the stream with `NGHTTP2_FRAME_SIZE_ERROR`), which
makes Cursor's native tool calls execute but never report completion — they appear stuck or show
"Tool execution aborted".

To work around this transparently, when the plugin detects it is running under Bun and finds `node`
on your `PATH`, it hosts the Cursor SDK agent in a short-lived **Node child process** (a "sidecar")
and talks to it over stdio. Behavior is otherwise identical. Under Node the SDK runs in-process and
no sidecar is spawned.

- **Requirement:** a Node.js runtime on `PATH` when running under Bun — Node 22+ to match `engines`
  (the plugin checks that `node` is present, not its version). If Bun is detected but `node` is
  missing, the plugin logs a one-time warning and falls back to in-process (native Cursor tools will
  misbehave until Node is available).
- **Override** with the `OPENCODE_CURSOR_SIDECAR` environment variable:
  - `OPENCODE_CURSOR_SIDECAR=1` — always use the sidecar (requires `node`).
  - `OPENCODE_CURSOR_SIDECAR=0` — never use the sidecar / silence the Bun warning.

## Tool display

Cursor runs its own agent loop and executes its own tools. The `toolDisplay` option controls how
that activity appears in opencode:

- **`"blocks"` (default)** — tool activity is emitted as structured, **provider-executed**
  `tool-call`/`tool-result` parts so opencode renders proper, collapsible tool blocks with inputs
  and outputs. opencode skips execution for provider-executed calls (they're display-only), so
  Cursor's tools (`shell`, `mcp`, …) don't trigger an "unavailable tool" error. Requires a
  V3-native opencode host (1.16+).
- **`"reasoning"` (fallback)** — each tool call is shown as a compact reasoning line
  (`[tool] write {"path":…}`; failures as `[tool] x failed`). Robust on every host: no tool-call
  parts cross into opencode, so there's no dependency on how the host treats provider-executed
  tools. Use this on older/non-V3 opencode hosts.

The default needs no configuration. To force the reasoning fallback (e.g. on a pre-1.16 host):

```jsonc
{
  "provider": {
    "cursor": {
      "options": { "toolDisplay": "reasoning" }
    }
  }
}
```

> Why blocks by default: structured tool blocks are the nicer experience and have been verified
> against opencode 1.16+. `"blocks"` depends on V3-native, provider-executed dynamic tool parts; if
> your host predates that (or renders them poorly), set `"toolDisplay": "reasoning"` — it requires
> nothing from the host and works everywhere.

## Troubleshooting

- **Native Cursor tools hang or show "Tool execution aborted" (`NGHTTP2_FRAME_SIZE_ERROR`).** This
  is the Bun `node:http2` incompatibility. Make sure **Node.js is installed and on your `PATH`** so
  the plugin can use the Node sidecar (see [Runtime](#runtime-bun-and-the-node-sidecar)); force it
  with `OPENCODE_CURSOR_SIDECAR=1`.
- **"Running under Bun without a usable Node sidecar" warning.** Install Node.js 22+, or set
  `OPENCODE_CURSOR_SIDECAR=0` to accept in-process behavior and silence the warning.
- **"Could not locate the bindings file" / `node_sqlite3.node` not found.** `@cursor/sdk` depends on
  the native `sqlite3` addon, and opencode installs plugins with Bun, which skips sqlite3's install
  script — so the prebuilt binary may be missing. The plugin detects this and self-heals on first SDK
  load by running sqlite3's own `prebuild-install -r napi` under your system Node (requires Node on
  `PATH`). If it can't (no Node, offline), it logs a one-line manual fix: `cd` into the printed
  sqlite3 directory and run `npx prebuild-install -r napi` (or `npm rebuild sqlite3`). Set
  `OPENCODE_CURSOR_DEBUG=1` to see the repair output.
- **Plugin looks enabled but no `cursor` provider/models appear.** opencode caches a plugin by its
  install spec under `~/.cache/opencode/packages/`; a stale cache from an older version can persist.
  Pin an exact version (`@stablekernel/opencode-cursor@<version>`) or delete the cached dir and
  restart so opencode reinstalls.
- **Only the four fallback models appear in the picker.** The live catalog loads after the first
  authenticated use — restart opencode once after logging in, or run `cursor_refresh_models` to
  force a refresh.
- **Invalid or expired key.** The key is validated on first use (model discovery / first call), not
  at login, so that's where an error surfaces.
- **Need more detail?** Set `OPENCODE_CURSOR_DEBUG=1` for provider and sidecar trace logging on
  stderr.

## Contributing

Issues and pull requests are welcome. See **[CONTRIBUTING.md](./CONTRIBUTING.md)** for development
setup, the test/typecheck/build commands, and the release process. Please report bugs at the
[issue tracker](https://github.com/stablekernel/opencode-cursor/issues); for security reports
see **[SECURITY.md](./SECURITY.md)**.

## License

MIT
