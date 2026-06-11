import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptRecord } from "./transcript-fingerprint.js";

/**
 * Best-effort disk persistence for the session pool's fingerprint records, so
 * `session: "auto"` survives opencode restarts: the pool can re-resume a
 * session's Cursor agent (whose conversation lives in Cursor's own checkpoint
 * store) instead of paying a cache-cold full-transcript replay.
 *
 * Follows the model-cache pattern: JSON under `~/.cache/opencode-cursor/`,
 * never throws, treats the file as an optimization only. Multiple opencode
 * processes write last-wins on the whole file — a lost record costs exactly
 * one self-healing full replay, which is the same as not having the store.
 */

/** A record persists this long after its last turn before being pruned. */
const ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Cap stored sessions (most recently used win) to bound file growth. */
const MAX_ENTRIES = 200;

export interface StoredSessionRecord extends TranscriptRecord {
  updatedAt: number;
}

interface StoreEnvelope {
  sessions: Record<string, StoredSessionRecord>;
}

function storeDir(): string {
  const base =
    process.env.XDG_CACHE_HOME?.trim() ||
    (homedir() ? join(homedir(), ".cache") : tmpdir());
  return join(base, "opencode-cursor");
}

function storeFile(): string {
  return join(storeDir(), "session-pool.json");
}

function isStoredRecord(value: unknown): value is StoredSessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["agentId"] === "string" &&
    typeof v["systemHash"] === "string" &&
    Array.isArray(v["userHashes"]) &&
    (v["userHashes"] as unknown[]).every((h) => typeof h === "string") &&
    typeof v["updatedAt"] === "number"
  );
}

/** Load persisted records, dropping expired/corrupt entries. Never throws. */
export function loadSessionRecords(now = Date.now()): Map<string, StoredSessionRecord> {
  const out = new Map<string, StoredSessionRecord>();
  try {
    const parsed = JSON.parse(readFileSync(storeFile(), "utf8")) as StoreEnvelope;
    if (typeof parsed?.sessions !== "object" || parsed.sessions === null) return out;
    for (const [key, value] of Object.entries(parsed.sessions)) {
      if (!isStoredRecord(value)) continue;
      if (now - value.updatedAt > ENTRY_TTL_MS) continue;
      out.set(key, value);
    }
  } catch {
    // Missing/corrupt store: start empty.
  }
  return out;
}

/** Persist records (pruned to TTL + entry cap). Best-effort; never throws. */
export function saveSessionRecords(
  records: ReadonlyMap<string, StoredSessionRecord>,
  now = Date.now(),
): void {
  try {
    const live = [...records.entries()]
      .filter(([, r]) => now - r.updatedAt <= ENTRY_TTL_MS)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_ENTRIES);
    mkdirSync(storeDir(), { recursive: true });
    const envelope: StoreEnvelope = { sessions: Object.fromEntries(live) };
    writeFileSync(storeFile(), JSON.stringify(envelope), "utf8");
  } catch {
    // Persistence is an optimization; ignore write failures.
  }
}

/** Delete the store file (test/diagnostic helper). Never throws. */
export function deleteSessionStore(): void {
  try {
    rmSync(storeFile(), { force: true });
  } catch {
    // best effort
  }
}
