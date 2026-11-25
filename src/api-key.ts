import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** Environment variable the Cursor SDK itself reads as a fallback. */
export const CURSOR_API_KEY_ENV_VAR = "CURSOR_API_KEY";

/**
 * Values that are *not* real keys but rather instructions to read the key from
 * the environment. opencode config commonly stores literal `{env:...}` style
 * placeholders, and users sometimes paste the variable name itself.
 */
const PLACEHOLDERS = new Set<string>([
  CURSOR_API_KEY_ENV_VAR,
  `$${CURSOR_API_KEY_ENV_VAR}`,
  `\${${CURSOR_API_KEY_ENV_VAR}}`,
]);

/**
 * Resolve a usable Cursor API key.
 *
 * Resolution order: an explicit, non-placeholder candidate (e.g. from opencode
 * auth storage or provider options) wins; otherwise fall back to the
 * `CURSOR_API_KEY` environment variable. Returns `undefined` when no key is
 * available so callers can present a clear "needs auth" path.
 *
 * The key is never logged or persisted by this module.
 */
export function resolveCursorApiKey(candidate?: string | null): string | undefined {
  const trimmed = candidate?.trim();
  if (trimmed && !PLACEHOLDERS.has(trimmed)) return trimmed;
  const fromEnv = process.env[CURSOR_API_KEY_ENV_VAR]?.trim();
  return fromEnv ? fromEnv : undefined;
}

/**
 * Produce a short, non-reversible fingerprint of an API key. Used purely to key
 * the on-disk model cache so the cache invalidates when the key changes. The
 * raw key is never written to disk.
 */
export function fingerprintApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

/**
 * The Cursor key saved by `opencode auth login`, read from opencode's
 * `auth.json` (`$XDG_DATA_HOME/opencode`, default `~/.local/share/opencode`).
 * v1 only hands the stored key to the auth `loader`, which runs after the
 * `config` hook seeds the model picker; reading the file lets discovery use
 * it on first launch. (v2 resolves it through `ctx.integration` instead.)
 * Returns `undefined` for a missing/corrupt file or a non-`api` entry.
 */
export function readStoredCursorKey(): string | undefined {
  const base = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  try {
    const auth = JSON.parse(readFileSync(join(base, "opencode", "auth.json"), "utf8")) as {
      cursor?: { type?: unknown; key?: unknown };
    };
    const entry = auth?.cursor;
    return entry?.type === "api" && typeof entry.key === "string" ? entry.key : undefined;
  } catch {
    return undefined;
  }
}
