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
