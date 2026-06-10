# Contributing

Thanks for your interest in improving `@stablekernel/opencode-cursor`! Issues and pull
requests are welcome.

## Reporting issues

- **Bugs / features:** open an issue at
  <https://github.com/stablekernel/opencode-cursor/issues>.
- **Security vulnerabilities:** do **not** file a public issue — see
  [SECURITY.md](./SECURITY.md).

When reporting a runtime bug, please include:

- your runtime (Bun vs. Node) and version, and your opencode version,
- whether the Node sidecar is in use (Bun + `node` on `PATH`),
- output from running with `OPENCODE_CURSOR_DEBUG=1`.

## Development setup

Requires **Node.js 22+**.

```bash
npm install
npm run typecheck
npm test
npm run build

# End-to-end: install the real opencode CLI, load this plugin, and assert
# `opencode models` lists the Cursor provider (no API key required — uses the
# fallback snapshot; set CURSOR_API_KEY to also verify live discovery).
bash scripts/integration-test.sh
```

CI runs unit tests + build on Node 22 and 24 plus the end-to-end check on every
push. Built with `@cursor/sdk`, `@opencode-ai/plugin`, and `@ai-sdk/provider`.

## Pull requests

- Add or update tests for behavior changes (this repo uses
  [Vitest](https://vitest.dev); see `test/`).
- Keep `npm run typecheck`, `npm test`, and `npm run build` green.
- Update `CHANGELOG.md` under the appropriate version/`[Unreleased]` heading.

## Releasing (maintainers)

The `.github/workflows/release.yml` workflow publishes automatically when a
version tag is pushed:

```bash
# 1. Bump the version in package.json (patch / minor / major)
npm version patch          # or: minor, major, or e.g. --new-version 0.2.0

# 2. Push the commit and the generated tag together
git push origin main --follow-tags
```

The release job will:

1. Run `prepublishOnly` (typecheck → test → build) to gate the publish.
2. Run the integration smoke test (uses the `CURSOR_API_KEY` secret if set).
3. Publish to npm with [provenance attestation](https://docs.npmjs.com/generating-provenance-statements).
4. Create a GitHub Release with auto-generated release notes.

**Required repository secrets** (Settings → Secrets → Actions):

| Secret | Purpose |
| --- | --- |
| `NPM_TOKEN` | npm automation token with `publish` access |
| `CURSOR_API_KEY` | (optional) live-path integration test during release |

**Pre-publish checklist:** update `CHANGELOG.md`, confirm `version` in
`package.json` matches the tag, and ensure the branch is merged to `main`.
