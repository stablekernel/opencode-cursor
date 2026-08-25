# Phase 2 findings: bridging plugin tools to the Cursor agent

Verified against opencode v1.18.18 source (sparse clone at `/tmp/opencode-src`)
and the installed `@opencode-ai/sdk@1.18.18` typings.

## What was learned

1. **Plugin tools are in-process closures.** opencode's tool registry calls each
   plugin's `hooks.tool` map and wraps `execute` with an Effect bridge
   (`packages/opencode/src/tool/registry.ts:125-198`). There is no public API to
   *invoke* another plugin's tool from outside that closure.
2. **But a sibling plugin CAN call them.** Plugin load order is config order
   (`plugin/index.ts:297` — `Plugin.list()` returns loaded hooks; the registry
   iterates `plugin.list()` at registry state init). A plugin registered AFTER
   another one can `import()` that plugin's module, call its `server(input)`
   with the same `PluginInput` it received, and read `hooks.tool` — the exact
   same functions opencode itself will later execute. Same module instance →
   same closures.
3. **opencode resolves plugin specs itself.** `Config.plugin` entries may be
   bare names, `@latest` specs, file paths, or git URLs; opencode installs them
   into the package cache (`~/.cache/opencode/packages/`). A mirror plugin can
   reuse the cache resolution the skill mirror already does
   (`opencodePackagesRoot`, cache-entry layouts: `name@latest`,
   `@scope/name@latest`, `name@git+https:...`).
4. **Execution with permission gating already exists.** opencode's
   `ToolContext.ask` (bridged to Effect at `registry.ts:143-146`) honours the
   user's live permission config. Calling the mirror's tool map the same way
   opencode does (`fromPlugin` shape) preserves that gate for free.
5. **JSON schema extraction is reliable.** opencode converts plugin Zod args via
   `z.toJSONSchema(schema, { io: "input" })` (`registry.ts:370`), with a legacy
   fallback that treats non-Zod entries as raw JSON Schema
   (`registry.ts:358-367`). The registry does the same.

## Chosen design (vs the plan's session-loopback alternative)

The plan's WARNING flagged that enumeration may be impossible. It is possible —
via import + re-invoke of sibling plugin modules. That is strictly better than
session-loopback execution:

| | import + re-invoke (chosen) | session loopback |
| --- | --- | --- |
| Executes the real tool fn | yes — same closure opencode uses | yes — opencode executes it |
| Permission `ask` gate | yes (host bridges `context.ask`) | yes |
| LLM turn cost | none | one full model turn per call |
| Model dependency | none | session's configured model |
| Failure modes | import failures only | prompt/event races, model errors |

Session loopback remains the documented fallback for tools whose modules cannot
be re-imported (stateful singletons that break on double-init are the known
risk; `opencode-pty` verified importable and its `tool` map is a plain object
of closures over a module-scoped session manager — re-invoking `server()`
creates a second manager, harmless for read-only bridging but noted in README).

## Verified real targets on this machine

- `opencode-pty@latest` → `dist/src/plugin.js` exports `PTYPlugin` (also as
  `server`); `hooks.tool` = `pty_spawn`, `pty_write`, `pty_read`, `pty_list`,
  `pty_kill`.
- `context-mode@latest` → MCP-backed tools (its skills are handled by Phase 1;
  its tools are not re-exported as a `tool` map — excluded from mirror, correct).

## SDK surface used

- `client.tool.ids()` → `/experimental/tool/ids` (list registered tool ids)
- `client.session.create/update` with `permission` + `metadata` (not needed in
  chosen design; kept as fallback notes)
- `client.session.prompt` with `noReply` + `tools` (fallback only)

## Follow-ups (from review)

- **M1**: bridge token/port ride the per-turn `mcpServers` config through
  opencode's session plumbing; consider a process-lifetime bridge or a 0600
  temp-file handoff. Bridge restart also changes the transcript fingerprint,
  re-creating the pooled Cursor agent (intentional but worth a doc note).
- **M3**: `mirrorPluginTools` re-invokes every plugin's `server()` factory
  each turn — memoize on plugin-list + permission-config hash; add an
  import/init timeout.
- **M6**: `src/version-check.ts` hardcodes `~/.cache` (pre-existing XDG bug,
  now duplicated by `opencodePackagesRoot`) — factor a shared helper.
- **N3**: git-spec cache walk admits symlinked components; a realpath
  containment check is cheap hardening (low impact: user-controlled cache).
