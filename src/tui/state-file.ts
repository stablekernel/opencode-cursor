import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AxisSelection } from "./axis-state.js";

/** Same base dir as model-cache.ts so both plugin halves agree. */
function baseDir(): string {
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  const home = homedir();
  const root = xdg ? xdg : home ? join(home, ".cache") : tmpdir();
  return join(root, "opencode-cursor");
}

/** Shared bridge file path. Env override lets tests isolate it. */
export function stateFilePath(): string {
  const override = process.env.OPENCODE_CURSOR_STATE_FILE;
  return override && override.length > 0 ? override : join(baseDir(), "cursor-states.json");
}

/** All persisted per-session selections. Corrupt/missing file => {}. */
export function readStates(): Record<string, AxisSelection> {
  try {
    const raw = readFileSync(stateFilePath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, AxisSelection>;
    }
    return {};
  } catch {
    return {};
  }
}

export function readSelection(sessionID: string): AxisSelection | undefined {
  const states = readStates();
  return states[sessionID];
}

/**
 * Keep only string-valued entries. `readStates` shallowly validates the file
 * (confirms it's an object) but does NOT check that each session's values are
 * strings, so a hand-edited or corrupt file could carry non-string values.
 * Cursor params MUST be strings, so the server half filters through this before
 * merging the persisted selection into the request.
 */
export function filterStringParams(
  input: Record<string, unknown>,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string") safe[k] = v;
  }
  return safe;
}

/** Persist one session's selection, preserving the others. Best-effort. */
export function writeSelection(sessionID: string, sel: AxisSelection): void {
  const states = readStates();
  states[sessionID] = { ...sel };
  const file = stateFilePath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Atomic write: a concurrent server-side read must never observe a torn
    // file, so write to a temp path and rename (atomic on the same fs).
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(states), "utf8");
    renameSync(tmp, file);
  } catch {
    // Non-fatal: the widget still reflects the selection in-memory.
  }
}
