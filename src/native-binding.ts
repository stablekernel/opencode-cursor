/**
 * Self-heal for sqlite3's native binding.
 *
 * `@cursor/sdk` depends on `sqlite3` (a native addon). opencode installs
 * plugin packages with Bun, which does not run sqlite3's `install` lifecycle
 * script (`prebuild-install -r napi || node-gyp rebuild`), so the installed
 * tree has **no** `node_sqlite3.node` binary and the SDK crashes at import
 * with "Could not locate the bindings file".
 *
 * Before loading the SDK (in-process or via the Node sidecar) we check for a
 * binding and, when it is missing, run sqlite3's own `prebuild-install -r napi`
 * to fetch the prebuilt NAPI binary (ABI-portable across Node versions, also
 * loadable by Bun). Failures degrade to a clear warning; the SDK import then
 * surfaces its own error.
 */
import { execSync, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export type EnsureResult = "present" | "repaired" | "failed" | "not-found";

export interface EnsureOptions {
  /** Override the sqlite3 package directory (tests). */
  sqliteDir?: string;
  /** Override the repair runner (tests). Returns true when the command succeeded. */
  run?: (sqliteDir: string) => Promise<boolean>;
  /** Override the warning sink (tests). */
  log?: (message: string) => void;
}

/** Directories (relative to the sqlite3 package root) that may hold the binding. */
const BINDING_ROOTS = ["build", "lib/binding", "compiled"];

function hasNodeFile(dir: string, depth: number): boolean {
  if (depth < 0) return false;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (entry.endsWith(".node")) {
      try {
        if (statSync(path).isFile()) return true;
      } catch {
        // ignore unreadable entries
      }
      continue;
    }
    try {
      if (statSync(path).isDirectory() && hasNodeFile(path, depth - 1)) return true;
    } catch {
      // ignore unreadable entries
    }
  }
  return false;
}

/** True when the sqlite3 package dir contains a compiled `.node` binding. */
export function hasSqliteBinding(sqliteDir: string): boolean {
  return BINDING_ROOTS.some((root) => hasNodeFile(join(sqliteDir, root), 3));
}

/**
 * Locate the sqlite3 package directory that `@cursor/sdk` will load, walking
 * the same resolution chain (our module -> @cursor/sdk -> sqlite3).
 */
export function resolveSqliteDir(): string | undefined {
  const req = createRequire(import.meta.url);
  try {
    const sdkPkg = req.resolve("@cursor/sdk/package.json");
    return dirname(createRequire(sdkPkg).resolve("sqlite3/package.json"));
  } catch {
    // fall through: try resolving sqlite3 directly (hoisted installs)
  }
  try {
    return dirname(req.resolve("sqlite3/package.json"));
  } catch {
    return undefined;
  }
}

function detectNodeExecutable(): string {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  if (!isBun) return process.execPath;
  // Under Bun prefer a real Node (matches the sidecar runtime); prebuild-install
  // itself is plain JS, so Bun works as a last resort.
  try {
    const out = execSync(process.platform === "win32" ? "where node" : "command -v node", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.split("\n")[0] || process.execPath;
  } catch {
    return process.execPath;
  }
}

/** Default repair: run sqlite3's own `prebuild-install -r napi` in its package dir. */
async function runPrebuildInstall(sqliteDir: string): Promise<boolean> {
  let bin: string;
  try {
    const req = createRequire(join(sqliteDir, "package.json"));
    const pkgPath = req.resolve("prebuild-install/package.json");
    const pkg = (await import(pkgPath, { with: { type: "json" } })) as {
      default: { bin?: string | Record<string, string> };
    };
    const binField = pkg.default.bin;
    const rel = typeof binField === "string" ? binField : binField?.["prebuild-install"];
    if (!rel) return false;
    bin = join(dirname(pkgPath), rel);
  } catch {
    return false;
  }
  if (!existsSync(bin)) return false;

  return new Promise<boolean>((resolve) => {
    const child = spawn(detectNodeExecutable(), [bin, "-r", "napi"], {
      cwd: sqliteDir,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => {
      if (code !== 0 && stderr && process.env["OPENCODE_CURSOR_DEBUG"]) {
        console.error(`[opencode-cursor] prebuild-install stderr: ${stderr.trim()}`);
      }
      resolve(code === 0);
    });
  });
}

let cached: Promise<EnsureResult> | undefined;

/**
 * Ensure the sqlite3 native binding exists, repairing it once per process if
 * needed. Never throws; "failed"/"not-found" outcomes warn and let the SDK
 * import surface its own error.
 */
export function ensureSqliteBinding(options: EnsureOptions = {}): Promise<EnsureResult> {
  cached ??= (async () => {
    const log = options.log ?? ((message: string) => console.error(message));
    const sqliteDir = options.sqliteDir ?? resolveSqliteDir();
    if (!sqliteDir || !existsSync(join(sqliteDir, "package.json"))) {
      return "not-found";
    }
    if (hasSqliteBinding(sqliteDir)) return "present";

    const run = options.run ?? runPrebuildInstall;
    const ok = await run(sqliteDir).catch(() => false);
    if (ok && hasSqliteBinding(sqliteDir)) return "repaired";

    log(
      `[opencode-cursor] sqlite3 native binding is missing in ${sqliteDir} and automatic ` +
        `repair failed. @cursor/sdk will not load. Fix manually with: ` +
        `cd ${sqliteDir} && npx prebuild-install -r napi (or: npm rebuild sqlite3)`,
    );
    return "failed";
  })();
  return cached;
}

/** Test hook. */
export function resetNativeBinding(): void {
  cached = undefined;
}
