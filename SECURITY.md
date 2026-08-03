# Security Policy

## Supported versions

This project is pre-1.0. Security fixes are made against the latest published
version on npm and the `main` branch.

## Security model — read before use

This plugin integrates the Cursor agent runtime into opencode. **Two of its
surfaces have very different security properties:**

### Provider path (`cursor/*` models) — unsandboxed, not gated by opencode

When you chat with a `cursor/*` model, Cursor runs its **own** agent loop and
executes its **own** tools — including `shell`, `write`, `edit`, and `delete` —
**directly in your working directory**.

- These tool calls run **outside** opencode's `permission` system. Your opencode
  `permission` rules (e.g. `edit: deny`, `bash: ask`) **do not apply** to them.
- The Cursor sandbox is **off by default**.
- This is inherent to running Cursor as a native provider: the model you talk to
  *is* the Cursor agent, and it acts in your repo.

**If you need an approval boundary on the provider path:**

- set `sandbox: true` in `provider.cursor.options` to run Cursor's tools in
  Cursor's sandbox, **or**
- use the permission-gated **`cursor_delegate`** tool instead of chatting with a
  `cursor/*` model directly.

### Delegation tools (`cursor_delegate`, `cursor_cloud_agent`) — permission-gated

These are exposed as opencode tools and are gated through `ToolContext.ask`, so
your opencode `permission` config (`allow` / `ask` / `deny`) controls them. The
gate is **fail-closed**: if no permission mechanism is available, or approval is
rejected, the call is blocked rather than silently allowed.

### Skills mirror — instructions cross the permission boundary

When `forwardSkills` is enabled (default), opencode's resolved skills are
mirrored into `<cwd>/.cursor/skills/` so the Cursor agent can discover and load
them. This means **skill instructions now reach an agent running outside
opencode's permission system**. Key implications:

- Skill content is copied to disk and loaded by Cursor's own agent runtime —
  opencode cannot intervene, revoke, or gate access once the files are written.
- Skills are discovered from all standard locations (project `.opencode/skills/`,
  `.claude/skills/`, `.agents/skills/`, global `~/.config/opencode/skills/`,
  etc.) **and** from `config.skills.paths` — additional directories configured
  in `opencode.json`. If `skills.paths` points to directories outside the
  project, skills from those directories will also be mirrored.
- `deny`-permissioned skills are excluded from the mirror before writing, unless
  explicitly re-added via a manual `skills.include` list, which takes precedence
  over permission config by design.
- `ask`-permissioned skills are also excluded, because the ask prompt cannot be
  enforced across the Cursor boundary (there is no way for Cursor to relay the
  approval request back to opencode's permission system).
- The mirror is written at plugin init and re-synced each turn, so permission
  changes take effect on the next turn (not retroactively on already-loaded
  skills within a running Cursor agent).
- A user-owned `.cursor/skills/<id>/SKILL.md` (without the `generated:
  opencode-cursor` sentinel) is never overwritten or deleted — the plugin
  respects existing user content.
- `config.skills.urls` (HTTP skill catalogs) are not mirrored — only filesystem
  paths are scanned.

## Credentials

- Your `CURSOR_API_KEY` is read from opencode auth storage or the environment.
- The key is **never logged or written to disk** by this plugin. Provider debug
  tracing (`OPENCODE_CURSOR_DEBUG=1`) does not print the key.

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report privately via GitHub's **[private vulnerability reporting](https://github.com/stablekernel/opencode-cursor/security/advisories/new)**
(Security → Report a vulnerability on the repository). Include a description, a
reproduction if possible, and the impact you've identified.

We aim to acknowledge reports within a few business days and will coordinate a
fix and disclosure timeline with you.
