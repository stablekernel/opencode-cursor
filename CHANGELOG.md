# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

_No unreleased changes._

## [0.4.4] — 2026-06-24

- **Fixed: installer fails on `opencode.jsonc` files with trailing commas.**
  The installer's naive JSON parse broke on JSONC's trailing-comma syntax
  (common in hand-edited configs). A dedicated JSONC parser (`src/jsonc.ts`)
  now strips trailing commas before parsing, so existing JSONC configs are
  detected and reused instead of clobbering or skipping them (#49).
- **Fixed: variant enum keys normalized and `'none'` dropped for provider
  parity.** Cursor's model params can advertise enum values like `'none'` for
  reasoning/effort levels that don't make sense as a model variant. Enum keys
  are now normalized (lowercased, trimmed) and `'none'` is excluded so the
  variant picker doesn't show a no-op variant. This aligns the Cursor provider's
  variant surface with other opencode providers (#48).
- **Fixed: redundant thinking variant dropped when an effort enum is present.**
  When a model advertises both a boolean `thinking` param and an `effort`
  enum (e.g. `low`/`medium`/`high`), the variant builder previously emitted a
  standalone `thinking` variant that duplicated one of the effort levels. The
  standalone thinking variant is now suppressed in favor of the effort enum
  so the picker isn't cluttered with duplicates (#43).
- **Dependency consolidation.** npm deps bumped in one pass: `@connectrpc/connect-node`
  1.7.0→2.1.2, `@cursor/sdk` 1.0.19→1.0.20, `@opencode-ai/plugin` 1.17.7→1.17.9,
  `@opencode-ai/sdk` 1.17.7→1.17.9, `@types/node` 25.9.3→26.0.0 (#44). GitHub
  Actions updates consolidated into a single dependabot group (#45), and
  `@opencode-ai/*` packages are now grouped together (#46).

## [0.4.3] — 2026-06-18

- **`createPlan` mapping emits markdown as plain text.** Cursor's plan-mode
  tool returned markdown that opencode rendered as a raw code block. The
  `createPlan` tool output is now mapped to a plain-text part so the plan reads
  as formatted prose in the opencode transcript.

## [0.4.2] — 2026-06-17

- **Fixed: missing `@connectrpc/connect-node` dependency.** `@cursor/sdk`
  requires `@connectrpc/connect-node` at runtime but didn't declare it as a
  direct dependency, so installs that hoisted differently could fail with a
  module-not-found error. It's now an explicit dependency (#31).

## [0.4.1] — 2026-06-17

- **`read` transcript label surfaces lines-read / total.** The Read tool's
  transcript label now shows how many lines were read out of the total (e.g.
  `read src/foo.ts (50/200)`), so partial reads are visible in the conversation.
- **Removed obsolete sqlite3 native-binding self-heal.** The workaround for a
  Bun/sqlite3 native-binding crash is no longer needed and has been removed.
- **Dependency bumps.** `@cursor/sdk` 1.0.18→1.0.19, `@opencode-ai/plugin`
  1.17.3→1.17.7, dev-dependencies group bumped.

## [0.4.0] — 2026-06-16

- **Fixed: Cursor's `fast` tier is no longer silently forced on.** The variant
  builder only mapped reasoning/effort params and dropped Cursor's `fast` toggle
  entirely, so it never reached `providerOptions.cursor`. Because Cursor marks
  the **default** variant of several models as `fast: true` (composer-2.5,
  composer-2, and the gpt-*-codex line), omitting the param meant opencode
  silently ran the fast tier with no way to opt out. Now `fast` defaults OFF —
  fast-capable models seed `options.params.fast = "false"` (sent every turn, and
  pinned into each reasoning variant so picking a reasoning level can't re-enable
  it) — and a `fast` picker variant lets you opt back in. Override per model via
  `provider.cursor.models.<id>.options.params.fast`.
- **Installer detects and reuses `opencode.jsonc`.** The installer now
  recognizes both `opencode.json` and `opencode.jsonc` and reuses whichever
  exists instead of always writing `opencode.json`. The plugin is also pinned
  to `@latest` so opencode re-resolves to the newest release on each startup
  (#24).
- **Grep and glob tool blocks get a distinguishing title.** Cursor's `grep` and
  `glob` tools both render as search-result blocks; they now carry distinct
  titles so you can tell them apart in the opencode transcript (#22).

## [0.3.0] — 2026-06-11

- **Fingerprint-guarded session reuse, now the default (`session: "auto"`).**
  Previously the provider created a fresh Cursor agent every turn and re-sent
  the whole transcript (robust but cache-hostile and increasingly costly as a
  conversation grows), while opt-in `session: true` resumed one agent per
  session but could drift from opencode's history (edits/reverts/compaction) and
  was disturbed by non-chat side calls. `session: "auto"` (the new default)
  hashes only the parts opencode replays verbatim — the system prompt and the
  user-message sequence — and classifies each turn: a clean **continuation**
  resumes the pooled agent and sends only the new message (maximizing prefix
  cache hits); a **side-call** (system prompt differs, e.g. title generation)
  runs a fresh ephemeral agent without touching the pool; a **divergence**
  (edit/revert/compaction/queued messages) or a failed resume falls back to a
  fresh agent + full transcript and re-pools. Worst case is one self-healing
  full replay — never worse than the old default. `session: true` is now an
  alias for `"auto"`; `session: false` keeps the always-fresh behavior.
  Set `OPENCODE_CURSOR_DEBUG=1` to log per-turn classification and cache usage.
- **Session reuse survives opencode restarts.** The pool's fingerprint records
  persist (best-effort) to `~/.cache/opencode-cursor/session-pool.json` (7-day
  TTL, 200-entry LRU cap), so the first turn after a restart resumes the
  session's Cursor agent — whose conversation lives in Cursor's own checkpoint
  store — instead of paying a cache-cold full-transcript replay.
- **MCP servers are re-forwarded live, per turn, with OAuth mapping.** The
  `config` hook's startup snapshot meant mid-session MCP enable/disable never
  reached the Cursor agent. The `chat.params` hook now forwards the live set
  each turn (`client.mcp.status()` for runtime truth, `client.config.get()` for
  launch specs). Because a resumed agent keeps its original servers, a changed
  set forces a fresh agent (full-transcript replay, re-pooled) so the new
  servers take effect — the session fingerprint carries an `mcpHash` for this.
  Remote servers with a registered OAuth client are forwarded with a Cursor
  `auth` block so the agent runs its own OAuth flow; servers needing OAuth
  without a shareable `clientId` (dynamic registration) are skipped with a
  one-time toast instead of forwarding a spec that would 401.
- **Fixed: text/reasoning streamed after a tool call rendered above the tool
  block.** The earlier ordering fix closed parts on text↔reasoning transitions,
  but blocks-mode tool parts were emitted while the narration part stayed open
  — and hosts position a part where it started. Open text/reasoning parts are
  now closed before tool parts are emitted (except for buffered edit calls,
  which emit nothing until their result arrives, so narration isn't split
  needlessly).
- **Tool outputs are included (truncated) in flattened transcripts.** The
  fresh/divergence/`session: false` replay paths previously dropped Cursor tool
  results to bare `[result of X]` placeholders, so a fresh agent re-read a
  transcript with prior tool outputs missing. Outputs are now inlined and capped
  (2,000 chars per result, 500 per tool-call args) so context stays faithful
  without unbounded bloat.
- **Patched transitive dependabot vulnerabilities via overrides.** `undici`,
  `tar`, and `node-gyp` pinned via npm `overrides` to clear advisories in
  transitive dependencies (#16).

## [0.2.0] — 2026-06-11

- **More Cursor tools map onto opencode's native tool renderers (blocks mode).**
  Following the `edit` → diff-viewer mapping, Cursor's `shell`, `read`, `write`,
  `glob`, `grep`, `ls`, `updateTodos`, and `task` tool activity is now surfaced
  under opencode's registered `bash`, `read`, `write`, `glob`, `grep`, `list`,
  `todowrite`, and `task` tools, and Cursor's web search (which runs as an MCP
  tool) maps onto opencode's `websearch` renderer — so opencode renders its
  native UI (shell console, file viewer, todo checklist, subagent card, search
  results, …) instead of generic `cursor_*` blocks. Cursor's arg shape is
  translated to opencode's (e.g. `path` → `filePath`, `globPattern` → `pattern`,
  `fileText` → `content`); calls stay provider-executed (display-only, never
  re-run on disk).
- **Cleaner fallback blocks for tools without an opencode counterpart.**
  `readLints` and `delete` now render as formatted `cursor_*` blocks (a
  diagnostics list / a one-line confirmation) instead of raw JSON, and every MCP
  tool's `content` array is flattened to readable text. Anything else — or a
  result with an unexpected shape — still falls back to a safe `cursor_*` block
  with the raw payload.

## [0.1.0] — 2026-06-10

> Pre-releases: `0.1.0-rc.1` and `0.1.0-rc.2` were published to the npm `next`
> dist-tag for validation ahead of this stable release.

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
  the send once with the SDK's `local.force` escape hatch. (Superseded by the
  fingerprint-guarded `session: "auto"` default; see Unreleased.)
- **Native diff viewer for Cursor edits (blocks mode).** A Cursor `edit` tool
  call is now surfaced under opencode's registered `edit` tool with its real
  unified diff in `metadata.diff`, so opencode renders its built-in diff viewer
  instead of a generic block. The required `oldString`/`newString` (which Cursor
  does not expose) are reconstructed from the diff; the call is provider-executed
  so they are never applied to disk. Any edit without a usable diff (errors,
  unexpected shapes, or a host without a registered `edit` tool) falls back to a
  safe `cursor_edit` block. Other Cursor tools (shell/read/mcp/…) remain
  prefixed `cursor_*` blocks.
- **`toolDisplay` provider option** (`"blocks"` default | `"reasoning"`):
  - `"blocks"` (default) emits structured, provider-executed **dynamic** `tool-call` /
    `tool-result` parts so opencode renders native tool blocks. Names are
    `cursor_`-prefixed and sanitized (`shell` → `cursor_shell`,
    `myserver/find_symbol` → `cursor_myserver_find_symbol`) so they can't collide
    with opencode-registered tools, and carry `providerExecuted: true` +
    `dynamic: true` so ai v6's `parseToolCall` accepts them without
    registered-tool validation. Tool-results use the V3-spec `result` +
    `isError` fields. A tool call whose completion never arrives (run
    errored/cancelled mid-tool) is closed with a synthetic error result so the
    block never dangles as "Tool execution aborted", and a run that ends with
    status `error` surfaces the failure instead of finishing silently.
  - `"reasoning"` renders Cursor's internal tool activity (including the real
    MCP tool name) as concise `[tool] …` reasoning lines. Always safe — tool
    calls never cross opencode's tool-execution boundary; the fallback for
    older/non-V3 hosts (`provider.cursor.options.toolDisplay: "reasoning"`).

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
  use the same servers. Opt out with `provider.cursor.options.forwardMcp`.
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
