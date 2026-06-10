# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

- `0.1.0-rc.1` — first pre-release of the 0.1.0 surface below, published to the
  npm `next` dist-tag for validation ahead of the stable `0.1.0`.

## [0.1.0] — 2026-06-10

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
- **Model variants** auto-generated from `Cursor.models.list` parameters: a
  `plan` variant plus one per reasoning level a model advertises.
- **Session reuse** (`session: true`) — keeps one Cursor agent per opencode
  session via `Agent.resume()` across turns, with automatic fallback to a fresh
  agent. A run wedged by a crashed/duplicate process is recovered by retrying
  the send once with the SDK's `local.force` escape hatch.
- **`toolDisplay` provider option** (`"reasoning"` default | `"blocks"`):
  - `"reasoning"` renders Cursor's internal tool activity (including the real
    MCP tool name) as concise `[tool] …` reasoning lines. Always safe — tool
    calls never cross opencode's tool-execution boundary.
  - `"blocks"` emits structured, provider-executed **dynamic** `tool-call` /
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

- **opencode plugin** (`@stablekernel/opencode-cursor/plugin`): auth hook (API-key login;
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
