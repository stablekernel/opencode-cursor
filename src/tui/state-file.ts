import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AxisSelection } from "./axis-state.js";

/** Same base dir as model-cache.ts so both plugin halves agree. */
function baseDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
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

/** Persist one session's selection, preserving the others. Best-effort. */
export function writeSelection(sessionID: string, sel: AxisSelection): void {
  const states = readStates();
  states[sessionID] = { ...sel };
  const file = stateFilePath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(states), "utf8");
  } catch {
    // Non-fatal: the widget still reflects the selection in-memory.
  }
}
