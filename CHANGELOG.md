# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

- **Native diff viewer for Cursor edits (blocks mode).** A Cursor `edit` tool
  call is now surfaced under opencode's registered `edit` tool with its real
  unified diff in `metadata.diff`, so opencode renders its built-in diff viewer
  instead of a generic block. The required `oldString`/`newString` (which Cursor
  does not expose) are reconstructed from the diff; the call is provider-executed
  so they are never applied to disk. Any edit without a usable diff (errors,
  unexpected shapes, or a host without a registered `edit` tool) falls back to a
  safe `cursor_edit` block. Other Cursor tools (shell/read/mcp/…) remain
  prefixed `cursor_*` blocks.
- **`toolDisplay` now defaults to `"blocks"`.** Cursor's internal tool activity
  renders as structured, provider-executed tool blocks out of the box (was
  `"reasoning"`). `"reasoning"` remains available as the fallback for
  older/non-V3 opencode hosts via `provider.cursor.options.toolDisplay:
  "reasoning"`; `"blocks"` requires a V3-native host (opencode 1.16+).
- `0.1.0-rc.2` — pre-release on the npm `next` dist-tag. Fixes found while
  validating rc.1 against opencode 1.16.2:
  - **Plugin now loads when installed by package name.** Added the
    `exports["./server"]` entry opencode uses to resolve a plugin's entrypoint;
    rc.1 exposed the plugin only at `./plugin`, which opencode does not read, so
    the package installed but registered no hooks (no provider, no models).
  - **Self-heal the `sqlite3` native binding.** opencode installs plugins with
    Bun, which skips sqlite3's install script, so `@cursor/sdk`'s
    `require("sqlite3")` failed with "Could not locate the bindings file". The
    plugin now runs sqlite3's `prebuild-install -r napi` under the system Node
    before loading the SDK (once per process, never throws).
  - **Stream ordering.** The final answer no longer renders above the reasoning
    blocks that preceded it — the open text part is closed when reasoning
    resumes and each resume opens a fresh text part.
  - **Model variants reach the picker.** Variants are seeded on the
    config-injected models (opencode discards the `provider.models()` hook for
    providers outside its models.dev catalog). Variant naming reworked against
    the real catalog: boolean params (e.g. `thinking`) collapse to one
    param-named variant instead of literal `true`/`false`; enum params key by
    value. The synthetic `plan` variant was removed.
  - **Plan agent → Cursor plan mode.** opencode's plan agent (`Tab`) is mapped
    to Cursor's plan mode via the `chat.params` hook; an explicit variant/option
    mode still wins.
- `0.1.0-rc.1` — first pre-release of the 0.1.0 surface below, published to the
  npm `next` dist-tag for validation ahead of the stable `0.1.0`.

## [0.1.0] — unreleased

Initial public release. A complete opencode integration for Cursor built on the
official `@cursor/sdk`: a streaming chat provider, an auth/config/model plugin,
and a permission-gated delegation tool surface.

### Provider

- **Cursor provider** backed by the official `@cursor/sdk` — drives a local
  Cursor agent (`Agent.create` / `agent.send`) and translates its `onDelta`
  callbacks into AI SDK `LanguageModelV3` stream parts (text, reasoning,
  tool activity, usage). Implements both `doStream()` and `doGenerate()`.
- **Per-request controls** via `providerOptions.cursor` — `mode` (agent/plan),
  `params`, and `thinking` level; works with opencode's model variant picker.
- **Model variants** auto-generated from `Cursor.models.list` parameters: one
  per reasoning/effort level a model advertises (boolean params collapse to a
  single on-variant). opencode's plan agent maps to Cursor plan mode.
- **Session reuse** (`session: true`) — keeps one Cursor agent per opencode
  session via `Agent.resume()` across turns, with automatic fallback to a fresh
  agent. A run wedged by a crashed/duplicate process is recovered by retrying
  the send once with the SDK's `local.force` escape hatch.
- **`toolDisplay` provider option** (`"blocks"` default | `"reasoning"`):
  - `"reasoning"` renders Cursor's internal tool activity (including the real
    MCP tool name) as concise `[tool] …` reasoning lines. Always safe — tool
    calls never cross opencode's tool-execution boundary; the fallback for
    older/non-V3 hosts.
  - `"blocks"` (default) emits structured, provider-executed **dynamic** `tool-call` /
    `tool-result` parts so opencode renders native tool blocks. Names are
    `cursor_`-prefixed and sanitized (`shell` → `cursor_shell`,
    `serena/find_symbol` → `cursor_serena_find_symbol`) so they can't collide
    with opencode-registered tools, and carry `providerExecuted: true` +
    `dynamic: true` so ai v6's `parseToolCall` accepts them without
    registered-tool validation. Tool-results use the V3-spec `result` +
    `isError` fields. A tool call whose completion never arrives (run
    errored/cancelled mid-tool) is closed with a synthetic error result so the
    block never dangles as "Tool execution aborted", and a run that ends with
    status `error` surfaces the failure instead of finishing silently.

### Node sidecar (Bun compatibility)

- **Automatic Node sidecar** — opencode runs on Bun, whose `node:http2` client
  is incompatible with the Cursor SDK's long-lived streaming RPC
  (`NGHTTP2_FRAME_SIZE_ERROR`), causing native tool calls to execute but never
  report completion. When Bun is detected and `node` is on `PATH`, the SDK
  agent is hosted in a Node child process and driven over a JSON-lines stdio
  protocol; the provider is otherwise unchanged. Under Node the SDK runs
  in-process. Override with `OPENCODE_CURSOR_SIDECAR=1` (force on) or
  `OPENCODE_CURSOR_SIDECAR=0` (force in-process / silence the Bun warning).

### Plugin

- **opencode plugin** (`@stablekernel/opencode-cursor`, resolved via the package's
  `./server` export): auth hook (API-key login;
  the key is validated on first use rather than at login), config hook
  (auto-injects `provider.cursor`),
  `provider.models()` (live catalog via `Cursor.models.list`), and the
  `cursor_refresh_models` tool. The auth loader warms a key-independent catalog
  cache so the model picker is populated on first authed load (and restart)
  rather than showing only the fallback snapshot.
- **MCP server forwarding** — opencode's configured `config.mcp` entries are
  translated to Cursor `McpServerConfig` and passed to the local agent so it can
  use the same servers (e.g. Serena). Opt out with `provider.cursor.options.forwardMcp`.
- **Model discovery** with a 24-hour cache (keyed by key fingerprint) and a
  built-in fallback snapshot (composer-2.5, claude-opus-4-8, claude-sonnet-4-6,
  gpt-5.5) for use without an API key.

### Delegation tools

- **`cursor_cloud_agent`** — launch a Cursor cloud (background) agent on a
  remote repo via `Agent.create({ cloud: { repos, autoCreatePR } })`; returns
  the agent id, terminal status, result, and PR url. Progress is collected from
  `run.onDidChangeStatus`, `onStep`, and `onDelta`.
- **`cursor_delegate`** — run a single local Cursor turn as a permission-gated,
  auditable opencode tool call (reuses the provider's `acquireAgent` +
  `streamAgentTurn` plumbing). Both tools honor opencode's `permission` config
  via `ToolContext.ask` and are fail-closed when no permission gate is present.

### Tooling

- **Provider debug tracing** — opt-in via `OPENCODE_CURSOR_DEBUG=1`.
- End-to-end CI: unit tests on two Node versions plus a full integration test
  (opencode loads the plugin, lists models, optionally runs a live chat turn).
