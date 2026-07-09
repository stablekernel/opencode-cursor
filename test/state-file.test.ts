import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filterStringParams,
  readSelection,
  readStates,
  writeSelection,
} from "../src/tui/state-file.js";

describe("cursor-states file bridge", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cursor-states-"));
    process.env.OPENCODE_CURSOR_STATE_FILE = join(dir, "cursor-states.json");
  });
  afterEach(() => {
    delete process.env.OPENCODE_CURSOR_STATE_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty map when no file exists", () => {
    expect(readStates()).toEqual({});
    expect(readSelection("s1")).toBeUndefined();
  });

  it("round-trips a selection for a session", () => {
    writeSelection("s1", { effort: "high", fast: "false" });
    expect(readSelection("s1")).toEqual({ effort: "high", fast: "false" });
  });

  it("keeps sessions independent and overwrites in place", () => {
    writeSelection("s1", { effort: "low" });
    writeSelection("s2", { effort: "max" });
    writeSelection("s1", { effort: "high" });
    expect(readSelection("s1")).toEqual({ effort: "high" });
    expect(readSelection("s2")).toEqual({ effort: "max" });
  });

  it("tolerates a corrupt file by treating it as empty", () => {
    writeSelection("s1", { effort: "high" });
    // corrupt it
    require("node:fs").writeFileSync(process.env.OPENCODE_CURSOR_STATE_FILE!, "{not json");
    expect(readStates()).toEqual({});
  });
});

describe("filterStringParams", () => {
  it("keeps string values and drops non-string values", () => {
    const input = {
      effort: "high",
      fast: "false",
      // Non-string values a corrupt/hand-edited file could carry:
      thinking: true as unknown as string,
      context: 42 as unknown as string,
      reasoning: null as unknown as string,
    };
    expect(filterStringParams(input)).toEqual({
      effort: "high",
      fast: "false",
    });
  });

  it("returns an empty object when no values are strings", () => {
    const input = { a: 1, b: false, c: null } as unknown as Record<
      string,
      unknown
    >;
    expect(filterStringParams(input)).toEqual({});
  });
});
