# Give the Cursor agent access to opencode plugins: bundled skills + custom tools

## Context

opencode installs typically have many plugins configured (`plugin: [...]` in
`opencode.jsonc`). Those plugins give the opencode agent two things the Cursor
agent currently cannot use:

1. **Bundled skills** — plugins can ship `skills/` directories inside their npm
   package. opencode loads them natively; this repo's skill mirror deliberately
   skips the opencode package cache (documented limitation, README "Skills →
   Limitations"). Verified real example on this machine: `context-mode@latest`
   ships ~8 skills (`ctx-search`, `ctx-index`, …) under
   `~/.cache/opencode/packages/context-mode@latest/node_modules/context-mode/skills/`
   — all invisible to the Cursor agent.

2. **Custom tools** — plugins register tools via the `tool: {}` hook
   (e.g. `opencode-pty`'s PTY tools). These are opencode-runtime JS functions;
   Cursor has no path to them.

Outcome: extend the existing skill mirror to cover plugin-bundled skills
(Phase 1), and bridge other plugins' registered tools to the Cursor agent via a
local stdio MCP server that proxies back into opencode's own tool execution
(Phase 2).

## Decisions (from user)

- Scope: **both** skills and custom tools.
- Sources: npm package cache **and** file plugins (`~/.config/opencode/plugins/`,
  `.opencode/plugin/`). Note: file plugins are single `.ts` files — they can't
  bundle a `skills/` dir, but scan their parent dirs anyway for correctness.
- Config: **fold into `forwardSkills`** (default on); existing
  `skills.include/exclude` applies identically. Tools get their own option
  (`forwardPluginTools`, default on) since the risk profile differs.
- Precedence: plugin-bundled skills **lowest priority** on duplicate ids —
  project/global/`skills.paths` always win.

## Existing code to reuse

| Piece | Location | Role |
| --- | --- | --- |
| `discoverSkills(cwd, extraPaths)` | [src/plugin/skill-discovery.ts](../../../src/plugin/skill-discovery.ts) | Ordered scan-roots pipeline; new cache scan slots in as lowest-priority roots |
| `scanSkillDir(dir)` / `entryKind` / `loadSkill` | same | Symlink-safe `SKILL.md` dir scan — reused as-is |
| `filterSkills()` | same | Permission `allow/deny/ask` + manual include/exclude — applies unchanged |
| `writeSkillMirror()` | [src/provider/skill-mirror.ts](../../../src/provider/skill-mirror.ts) | Sentinel-guarded `.cursor/skills/` mirror, 1 MB/10 MB caps |
| `buildSkillsCatalogue` / `skillSetHash` / `chat.params` live re-sync | [src/plugin/index.ts](../../../src/plugin/index.ts) | Catalogue + mid-session refresh — new sources ride along |
| `translateMcpServers()` | [src/plugin/mcp-config.ts](../../../src/plugin/mcp-config.ts) | Reference for how forwarded MCP servers reach the Cursor agent (`mcpServers` provider option); Phase 2 adds one more entry |
| `context.ask` approval gate | [src/plugin/cursor-tools.ts](../../../src/plugin/cursor-tools.ts) | Permission-gating pattern for the proxied tool execution |
| `PLUGIN_CACHE_PATH` win32/XDG pattern | [src/version-check.ts](../../../src/version-check.ts:27) | Cache-root resolution pattern (XDG_CACHE_HOME → ~/.cache; %LocalAppData%\opencode\cache on Windows) |
| `scripts/opencode-plugins-refresh` | [scripts/opencode-plugins-refresh](../../../scripts/opencode-plugins-refresh) | Documents real cache layouts: `<name>@latest`, `@scope/name@latest`, `@scope/name`, git specs (`superpowers@git+https:/...`) |

## Phase 1 — Mirror plugin-bundled skills

Cache-root layout (verified): `$XDG_CACHE_HOME/opencode/packages/` contains
entries per plugin: `<name>@latest/`, `<name>/`, scoped `@scope/<name>@latest/`,
and git specs. Each entry is a package root whose skills live at
`node_modules/<pkg-name>/skills/<id>/SKILL.md` (unscoped and scoped pkg names).
Note some cache entries are **not** plugins (`bash-language-server`,
`typescript-language-server`, `prettier`, `pyright`, `ls`) — they simply have no
`skills/` dir, so scanning them is a cheap no-op; no need to parse `plugin: []`
from opencode.json to filter.

### Steps

- [ ] Add `discoverPluginSkills()` (or extend `discoverSkills` with a new
  lowest-priority scan-roots group) in `src/plugin/skill-discovery.ts`:
  - Resolve cache root: `$XDG_CACHE_HOME/opencode/packages` (win32:
    `%LocalAppData%\opencode\cache\packages`) — factor a small shared helper,
    since `version-check.ts` duplicates this logic.
  - Enumerate entries: for each cache entry dir `E`, scan
    `E/node_modules/**/skills` (bounded: check `E/node_modules/<pkg>/skills`
    for each immediate child of `E/node_modules`, including `@scope/` nesting,
    plus git-spec layouts). Use `scanSkillDir` for each found `skills/` and
    `skills/` sibling `skill/`.
  - Also scan file-plugin parents: `~/.config/opencode/plugins/` and
    `<project>/.opencode/plugin/` — look for sibling `skills/` dirs.
- [ ] Precedence: append these roots **after** all existing roots (first-wins
  dedupe already gives lowest priority).
- [ ] No new config surface (folds into `forwardSkills`; existing
  `skills.include/exclude` and permission filtering apply).
- [ ] Tests in `test/skill-discovery.test.ts`: fixture cache roots covering
  unscoped `@latest`, scoped, no-suffix, git-spec layouts; non-plugin cache
  entries ignored; duplicate-id precedence (project skill beats plugin skill);
  permission `deny` drops a plugin-bundled skill; `include` list can select one.
- [ ] README: remove "Skills bundled inside opencode plugins are not mirrored"
  limitation; document the new source + precedence.

## Phase 2 — Bridge plugin custom tools via a proxy MCP server

Design: the plugin spawns a **local stdio MCP server** (bundled in this package)
that exposes every other plugin's registered custom tools as MCP tools. It is
handed to the Cursor agent through the existing `mcpServers` provider option —
the same channel `translateMcpServers` already feeds. When Cursor calls one,
the server proxies execution back into opencode's runtime (which owns the real
tool implementations, including other plugins' closures) via a local RPC loop
hosted by this plugin.

Why MCP proxy rather than re-implementing tools: opencode's `@opencode-ai/sdk`
exposes **no API to list or invoke registered tools** (verified: README itself
documents "no skills API"; the SDK surface is session/config/MCP-status only).
Plugin tools are in-process closures; the only in-process participant that can
see them is a plugin. So: a tiny in-process registry + a stdio MCP child is the
minimal bridge.

### Steps

- [ ] Registry module (e.g. `src/plugin/plugin-tool-registry.ts`): captures the
  `tool: {}` maps of *other* plugins. Mechanism: opencode calls each plugin's
  hook and merges the returned tools — investigate whether a later-registered
  plugin can observe earlier tools (wrap/intercept via the `config` hook's
  merged result, or the `tool.execute.before` event which receives tool names —
  see `~/.config/opencode/plugins/rtk.ts:19` for the event shape). Fallback if
  enumeration is impossible: forward only tools the user lists explicitly in
  `provider.cursor.options.pluginTools: ["pty_*", ...]` with descriptors.
  > [!WARNING]
  > Enumeration feasibility is the key risk. If opencode does not expose other
  > plugins' tool maps to a sibling plugin, Phase 2 becomes: document a
  > convention where interested plugin authors register tools with this
  > plugin's registry, plus the explicit-list fallback.
- [ ] MCP server entry (e.g. `src/sidecar/plugin-tools-mcp.mjs`): stdio MCP
  server using the MCP SDK (add `@modelcontextprotocol/sdk` dependency).
  `tools/list` serves the registry snapshot (name, description, JSON-schema
  args); `tools/call` forwards to the host plugin over a localhost socket or
  the stdin/stdout-adjacent control channel, which executes the real opencode
  tool through the same `context.ask` gating pattern as `cursor_delegate`
  (`src/plugin/cursor-tools.ts`) so the user's `permission` config applies.
- [ ] Wire-up in `src/plugin/index.ts` config hook: when
  `provider.cursor.options.forwardPluginTools !== false` and the registry is
  non-empty, add `opencode-plugin-tools` to the forwarded `mcpServers`
  (`type: "stdio"`, command = `node <path-to-mcp-entry>`, env carries the RPC
  port/auth token). Must NOT spawn when the registry is empty.
- [ ] Permission model: proxied calls gated by a new `permission` key
  (`cursor_plugin_tools`: ask default), plus per-tool patterns in metadata —
  matching the existing delegation-tool gating.
- [ ] Tests: registry capture, MCP server list/call round-trip against a fake
  tool, permission gate deny path, empty-registry no-spawn.
- [ ] README: new "Plugin tools" section: what is forwarded, the permission
  knob, the security note (Cursor invoking another plugin's tool runs that
  tool's code with the user's opencode permissions).

## Files to modify

- `src/plugin/skill-discovery.ts` — Phase 1 cache/file-plugin scan roots
- `src/plugin/index.ts` — wire-up for both phases
- `src/version-check.ts` — extract shared opencode cache-root helper (or new
  `src/plugin/opencode-cache.ts`)
- NEW `src/plugin/plugin-tool-registry.ts`, NEW `src/sidecar/plugin-tools-mcp.mjs` — Phase 2
- `test/skill-discovery.test.ts`, NEW `test/plugin-tools-mcp.test.ts` — coverage
- `README.md` — docs for both phases
- `package.json` — Phase 2 adds `@modelcontextprotocol/sdk` dependency (verify
  current version via `npm view` before pinning)

## Verification (executed)

- `npm run typecheck && npm test` — 41 files / 606 tests pass.
- `npm run build` — dist/sidecar/plugin-tools-mcp.js emitted; dist MCP round-trip
  smoke passes (initialize → tools/list → tools/call).
- Phase 1 smoke: discovery against the real cache finds 22 plugin-bundled
  skills (8 context-mode + 14 superpowers git-spec) alongside 22 config skills.
- Phase 2 smoke (Bun, matching opencode's runtime): `mirrorPluginTools` pulls
  16 real tools from `opencode-pty@latest` + `context-mode@latest`, `failed: {}`.
- Full-plugin smoke against `dist/plugin/index.js`: bridge lands in
  `mcpServers["opencode-plugin-tools"]`; a tool whose `execute` calls
  `ctx.ask` is rejected with a clear "set to allow" message when unconfigured
  and runs when `permission: { fake_tool: "allow" }`.
- Wiring test covers exact-id and wildcard (`wire_*`) permission allow paths.
- Remaining live check (needs a running opencode + Cursor session): confirm
  `.cursor/skills/` contains `ctx-search` etc. and the Cursor agent lists the
  `opencode-plugin-tools` MCP server in a real turn.
