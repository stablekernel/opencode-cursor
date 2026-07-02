# @stablekernel/opencode-cursor

[![npm version](https://img.shields.io/npm/v/@stablekernel/opencode-cursor.svg)](https://www.npmjs.com/package/@stablekernel/opencode-cursor)
[![CI](https://github.com/stablekernel/opencode-cursor/actions/workflows/ci.yml/badge.svg)](https://github.com/stablekernel/opencode-cursor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

An [opencode](https://opencode.ai) plugin that adds **Cursor** as a native provider. Your Cursor models appear in the model picker; you chat with them the same way you use any other provider.

It uses the [official Cursor SDK](https://cursor.com/docs/sdk/typescript) (`@cursor/sdk`) to list your account's models live and run chats through Cursor's local agent runtime. For delegated or background workflows it also ships two permission-gated tools (`cursor_delegate`, `cursor_cloud_agent`) — see [Delegation tools](#delegation-tools).

> ⚠️ **Security.** When you chat with a `cursor/*` model, Cursor runs its own tools — including
> `shell`, `write`, `edit`, and `delete` — directly in your working directory, **outside opencode's
> permission system**. Read [Security](#security) before you use it.

## Requirements

- **opencode 1.17+**
- **Node.js 22+ on your `PATH`** — opencode runs on [Bun](https://bun.sh); the plugin needs a
  Node sidecar to host the Cursor SDK (see [Runtime](#runtime-bun-and-the-node-sidecar)).
- A **Cursor account and API key** (from the Cursor dashboard).

## Install

### One line

```bash
curl -fsSL https://raw.githubusercontent.com/stablekernel/opencode-cursor/main/install.sh | bash
```

Registers the plugin in your global `opencode.json` (`~/.config/opencode/opencode.json`), checks
for Node.js 22+, and offers to set `CURSOR_API_KEY`. Flags:

- `--project` — write `./opencode.json` in the current directory instead.
- `--yes` / `-y` — non-interactive.

[Review the script first.](./install.sh)

### Manual

```bash
npm install @stablekernel/opencode-cursor
```

Add to your `opencode.json` (or `opencode.jsonc` — both are supported):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@stablekernel/opencode-cursor@latest"]
}
```

The `@latest` suffix makes opencode re-resolve to the newest release on each
startup. In practice opencode caches the `@latest` plugin install and does **not**
auto-update it. If you see a stale-version warning from the plugin, or a version
mismatch, exit opencode and clear the cached package:

```bash
# macOS / Linux
rm -rf ~/.cache/opencode/packages/@stablekernel/opencode-cursor@latest
# Windows
rmdir /s /q "%LocalAppData%\opencode\cache\packages\@stablekernel\opencode-cursor@latest"
```

Then restart opencode.

Drop `@latest` (`"@stablekernel/opencode-cursor"`) or pin a version
(`"@stablekernel/opencode-cursor@1.2.3"`) if you prefer deterministic installs.

The stale-version check is skipped when the `CI` or `NO_UPDATE_NOTIFIER`
environment variable is set.

The plugin injects the `provider` block automatically. If you need explicit control:

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

```bash
opencode auth login   # choose "Cursor", paste your key from the Cursor dashboard
```

Or set the environment variable:

```bash
export CURSOR_API_KEY="key_..."
```

The key is validated on first use (model discovery / first call), not at login time.

## Use

- `opencode models` (or the model picker) lists your Cursor models as `cursor/<id>`.
- Pick a model and chat — the Cursor local agent runs in your project directory.
- Run the `cursor_refresh_models` tool to force a live catalog refresh.

The plugin also registers two **delegation tools**:

- `cursor_delegate` — hand a discrete subtask to a local Cursor agent as a permission-gated tool
  call (your primary model stays in control).
- `cursor_cloud_agent` — launch a Cursor cloud agent on a remote repo that can run for minutes and
  optionally open a PR.

## Security

> ⚠️ **The provider path is unsandboxed and not gated by opencode permissions.**
> When you chat with a `cursor/*` model, Cursor runs its own tools — including `shell`, `write`,
> `edit`, and `delete` — directly in your working directory. opencode's `permission` rules (e.g.
> `edit: deny`, `bash: ask`) do **not** apply to them.
>
> Options if you need a permission boundary:
> - Set `sandbox: true` in `provider.cursor.options` to run Cursor's tools in Cursor's sandbox.
> - Use `cursor_delegate` instead of the provider path — it is gated by opencode's `permission`
>   config.
> - By default opencode's system prompt is delivered via a git-ignored Cursor
>   rule (`systemPrompt: "rules"`), not inlined into the message stream. See
>   [System prompt](#system-prompt).

See [SECURITY.md](./SECURITY.md) for the full threat model.

## Configuration

| Option (`provider.cursor.options`) | Default | Meaning |
| --- | --- | --- |
| `apiKey` | `CURSOR_API_KEY` | Cursor API key |
| `cwd` | `process.cwd()` | Directory the local agent operates in |
| `mode` | `"agent"` | Default conversation mode (`"agent"` or `"plan"`) |
| `params` | — | Default model params, e.g. `{ thinking: "high" }` |
| `settingSources` | — | Cursor settings layers to load: `["project","user","all",...]` — pulls in your Cursor skills, rules, and `.cursor/mcp.json` |
| `sandbox` | — | Run the agent's tools in Cursor's sandbox |
| `agents` | — | Cursor subagent definitions |
| `session` | `"auto"` | Session reuse strategy — see [Session reuse](#session-reuse-session) |
| `forwardMcp` | `true` | Forward opencode's configured MCP servers to the Cursor agent |
| `mcpServers` | — | Extra MCP servers (Cursor `McpServerConfig` shape); merged with forwarded ones |
| `toolDisplay` | `"blocks"` | How Cursor's internal tool activity is shown — see [Tool display](#tool-display) |
| `systemPrompt` | `"rules"` | How opencode's system prompt reaches the agent — see [System prompt](#system-prompt) |

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `CURSOR_API_KEY` | — | API key fallback |
| `OPENCODE_CURSOR_MODEL_CACHE_TTL_MS` | `86400000` | Model-list cache lifetime (ms) |
| `OPENCODE_CURSOR_DEBUG` | — | Set to `1` for trace logging on stderr |
| `OPENCODE_CURSOR_SIDECAR` | — | `1` = always use Node sidecar; `0` = never |

### Session reuse (`session`)

opencode re-sends the full conversation transcript on every turn. `session: "auto"` (the default)
fingerprints the conversation and resumes the same Cursor agent when nothing has changed, so you
only pay for the new message. It falls back to a fresh agent + full transcript on edits, reverts,
or compaction.

| Situation | What happens |
| --- | --- |
| First turn | Fresh agent, full transcript, pool it |
| System prompt differs (title gen, other side calls) | Ephemeral fresh agent; pooled agent untouched |
| Clean continuation (one new user message) | `Agent.resume` — sends only the new message |
| Forwarded MCP server set changed | Fresh agent + full transcript, re-pooled |
| Message edited/reverted or conversation compacted | Fresh agent + full transcript, re-pooled |

`session: true` is an alias for `"auto"`. `session: false` disables reuse (always fresh agent,
full transcript every turn).

Fingerprint records persist to `~/.cache/opencode-cursor/session-pool.json`, so session reuse
survives opencode restarts.

### Per-request controls (`mode`, thinking level)

The plugin auto-generates model variants for each reasoning/effort level a model advertises,
plus a `fast` toggle for models that expose Cursor's fast tier. Selecting a variant in the
model picker sends its settings through `providerOptions.cursor`.

`fast` defaults **off** (even though Cursor's own default is `fast: true` for some models, e.g.
Composer and the codex line) so opencode never silently runs the fast tier — pick the `fast`
variant to opt in, or set it per model under `options.params.fast` below.

opencode's **plan agent** (`Tab`) maps to Cursor's plan mode automatically — no manual config
needed.

To set controls statically per model:

```json
{ "provider": { "cursor": { "models": {
  "composer-2.5": { "options": { "params": { "thinking": "high" } } }
} } } }
```

## System prompt

opencode drives the Cursor agent the way it drives any provider — through its
**system prompt**. But the Cursor SDK has no system-prompt input (an agent, not a
raw model), and flattening opencode's system prompt into the message stream makes
injection-hardened Cursor models reject it as a prompt-injection attempt.

So by default (`systemPrompt: "rules"`) the plugin writes opencode's system prompt
to `<cwd>/.cursor/rules/opencode.mdc` (`alwaysApply: true`, git-ignored) and loads
the `project` settings layer, delivering it through Cursor's **authoritative rules
channel**. Cursor treats rules as system-level instructions, so opencode stays in
control and nothing is flagged.

Tradeoffs to know:

- A project rule also applies to **your own Cursor IDE** open on this repo. The
  plugin removes the file when the session disposes (best-effort).
- Enabling the `project` layer also loads other `.cursor/` config (`.cursor/mcp.json`,
  `.cursor/agents`, hooks).

Alternatives:

- `systemPrompt: "message"` — legacy inline delivery (may be rejected as injection).
- `systemPrompt: "omit"` — don't forward the system prompt at all.

## MCP servers

With `forwardMcp: true` (default), the Cursor agent uses the same MCP servers configured in
opencode. The server list is updated live per turn, so enabling or disabling an MCP server takes
effect on the next message.

| opencode `config.mcp` | → Cursor |
| --- | --- |
| `{ type: "local", command: [cmd, ...args], environment }` | `{ type: "stdio", command, args, env }` |
| `{ type: "remote", url, headers }` | `{ type: "http", url, headers }` |
| Remote with registered OAuth `clientId` | `{ type: "http", url, auth: { CLIENT_ID, … } }` |

Disabled entries (`enabled: false`) are skipped. Remote servers requiring OAuth without a
shareable `clientId` are also skipped (a one-time toast says which). Disable forwarding with
`forwardMcp: false`.

> **Note:** This forwards MCP **servers**. opencode's own skills and subagents are not exposed to
> the Cursor agent. To load your local Cursor skills/rules, use
> `settingSources: ["project","user"]`.

## Delegation tools

Both tools resolve the API key from your `opencode auth login` session (or `CURSOR_API_KEY`) and
are gated by opencode's `permission` config:

```json
{ "permission": { "cursor_delegate": "ask", "cursor_cloud_agent": "ask" } }
```

### `cursor_delegate` (local)

Runs one Cursor turn as a permission-gated tool call. Your primary opencode model hands off a
discrete subtask and gets the result back.

| Arg | Required | Meaning |
| --- | --- | --- |
| `prompt` | ✅ | The subtask to delegate |
| `model` | ✅ | Cursor model id |
| `mode` | — | `"agent"` or `"plan"` |
| `thinking` | — | Thinking level (e.g. `"high"`) |
| `cwd` | — | Working directory |
| `sandbox` | — | Run in Cursor's sandbox |
| `agentId` | — | Resume a specific Cursor agent |

### `cursor_cloud_agent` (cloud)

Launches a background Cursor cloud agent on a remote repo. Can run for minutes and optionally
open a PR.

| Arg | Required | Meaning |
| --- | --- | --- |
| `prompt` | ✅ | The task |
| `repoUrl` | ✅ | Target repository URL (e.g. `https://github.com/owner/repo`) |
| `startingRef` | — | Branch/ref to start from |
| `model` | — | Cursor model id |
| `mode` | — | `"agent"` or `"plan"` |
| `thinking` | — | Thinking level |
| `autoCreatePR` | — | Open a PR when finished |
| `workOnCurrentBranch` | — | Operate on the current branch instead of a new one |

## Tool display

`toolDisplay` controls how Cursor's internal tool activity appears in opencode:

- **`"blocks"` (default)** — structured, collapsible tool blocks with inputs and outputs. Common
  Cursor tools are mapped to their opencode equivalents (`edit` → diff viewer, `shell` → bash
  console, etc.). Requires opencode 1.17+.
- **`"reasoning"`** — compact inline lines (`[tool] write {"path":…}`). Works on any host; use
  this on older opencode versions.

To force the fallback:

```json
{ "provider": { "cursor": { "options": { "toolDisplay": "reasoning" } } } }
```

## Runtime: Bun and the Node sidecar

opencode runs on [Bun](https://bun.sh), which has an `node:http2` incompatibility with the Cursor
SDK's streaming RPC. The plugin transparently hosts the Cursor SDK in a short-lived **Node child
process** when running under Bun. Under Node it runs in-process.

This is why **Node.js 22+ on your `PATH`** is required. If Node isn't found, the plugin warns once
and falls back to in-process (native Cursor tools will misbehave until Node is available).

Override with `OPENCODE_CURSOR_SIDECAR=1` (always sidecar) or `OPENCODE_CURSOR_SIDECAR=0` (never).

## Troubleshooting

- **Native Cursor tools hang / "Tool execution aborted" (`NGHTTP2_FRAME_SIZE_ERROR`).** Node isn't
  on your `PATH`. Install Node.js 22+, or force the sidecar with `OPENCODE_CURSOR_SIDECAR=1`.
- **"Running under Bun without a usable Node sidecar" warning.** Install Node.js 22+, or set
  `OPENCODE_CURSOR_SIDECAR=0` to accept in-process behavior and silence the warning.
- **Plugin enabled but no `cursor` provider/models appear, or you see a stale-version warning.**
  opencode caches the `@latest` plugin install on first use and never refreshes it.
  Exit opencode, delete `~/.cache/opencode/packages/@stablekernel/opencode-cursor@latest`
  (or the pinned version directory), and restart.
- **Only the four fallback models appear.** The live catalog loads after the first authenticated
  use. Restart opencode once after login, or run `cursor_refresh_models`.
- **Invalid or expired key.** Validated on first use — that's where the error surfaces.
- **Need more detail?** Set `OPENCODE_CURSOR_DEBUG=1`.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup,
test/typecheck/build commands, and the release process. Report bugs at the
[issue tracker](https://github.com/stablekernel/opencode-cursor/issues); for security reports
see [SECURITY.md](./SECURITY.md).

## License

MIT
