import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureSqliteBinding,
  hasSqliteBinding,
  resetNativeBinding,
  resolveSqliteDir,
} from "../src/native-binding.js";

let dir: string;

beforeEach(() => {
  resetNativeBinding();
  dir = mkdtempSync(join(tmpdir(), "oc-cursor-sqlite-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Lay down a minimal fake sqlite3 package dir. */
function fakeSqliteDir(opts: { binding?: string } = {}): string {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "sqlite3", version: "5.1.7" }));
  if (opts.binding) {
    const bindingPath = join(dir, opts.binding);
    mkdirSync(join(bindingPath, ".."), { recursive: true });
    writeFileSync(bindingPath, "fake-native");
  }
  return dir;
}

describe("hasSqliteBinding", () => {
  it("finds a binding in build/Release", () => {
    fakeSqliteDir({ binding: "build/Release/node_sqlite3.node" });
    expect(hasSqliteBinding(dir)).toBe(true);
  });

  it("finds a binding in lib/binding/<abi>/", () => {
    fakeSqliteDir({ binding: "lib/binding/napi-v6-darwin-arm64/node_sqlite3.node" });
    expect(hasSqliteBinding(dir)).toBe(true);
  });

  it("returns false when no .node binary exists", () => {
    fakeSqliteDir();
    expect(hasSqliteBinding(dir)).toBe(false);
  });

  it("returns false for a missing directory", () => {
    expect(hasSqliteBinding(join(dir, "nope"))).toBe(false);
  });
});

describe("resolveSqliteDir", () => {
  it("resolves the real sqlite3 package dir from this repo", () => {
    // Integration: @cursor/sdk and sqlite3 are real deps of this repo.
    const resolved = resolveSqliteDir();
    expect(resolved).toBeDefined();
    expect(resolved).toMatch(/node_modules[/\\]sqlite3$/);
    expect(hasSqliteBinding(resolved!)).toBe(true);
  });
});

describe("ensureSqliteBinding", () => {
  it("reports present without running a repair when the binding exists", async () => {
    fakeSqliteDir({ binding: "build/Release/node_sqlite3.node" });
    const run = vi.fn();
    const result = await ensureSqliteBinding({ sqliteDir: dir, run });
    expect(result).toBe("present");
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the repair and reports repaired when it produces a binding", async () => {
    fakeSqliteDir();
    const run = vi.fn(async (cwd: string) => {
      mkdirSync(join(cwd, "build", "Release"), { recursive: true });
      writeFileSync(join(cwd, "build", "Release", "node_sqlite3.node"), "built");
      return true;
    });
    const result = await ensureSqliteBinding({ sqliteDir: dir, run });
    expect(result).toBe("repaired");
    expect(run).toHaveBeenCalledWith(dir);
  });

  it("reports failed (without throwing) when the repair does not produce a binding", async () => {
    fakeSqliteDir();
    const log = vi.fn();
    const run = vi.fn(async () => false);
    const result = await ensureSqliteBinding({ sqliteDir: dir, run, log });
    expect(result).toBe("failed");
    expect(log).toHaveBeenCalled();
  });

  it("reports not-found when sqlite3 cannot be located", async () => {
    const run = vi.fn();
    const result = await ensureSqliteBinding({ sqliteDir: join(dir, "missing"), run });
    expect(result).toBe("not-found");
    expect(run).not.toHaveBeenCalled();
  });

  it("caches the outcome (repair runs once across concurrent calls)", async () => {
    fakeSqliteDir();
    let calls = 0;
    const run = async (cwd: string) => {
      calls++;
      mkdirSync(join(cwd, "build", "Release"), { recursive: true });
      writeFileSync(join(cwd, "build", "Release", "node_sqlite3.node"), "built");
      return true;
    };
    const [a, b] = await Promise.all([
      ensureSqliteBinding({ sqliteDir: dir, run }),
      ensureSqliteBinding({ sqliteDir: dir, run }),
    ]);
    expect(a).toBe("repaired");
    expect(b).toBe("repaired");
    expect(calls).toBe(1);
  });
});
