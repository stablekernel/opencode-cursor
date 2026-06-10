/**
 * Selects where Cursor agents run:
 *
 * - "in-process": straight through `@cursor/sdk` in this process (Node — the
 *   normal path for tests, scripts, and any non-Bun host).
 * - "sidecar": a spawned Node child hosting the SDK (Bun — opencode's runtime —
 *   has a `node:http2` bug that kills Cursor's streaming RPC with
 *   NGHTTP2_FRAME_SIZE_ERROR, losing tool-completion updates; see
 *   src/sidecar/agent-host.mjs).
 *
 * Override with OPENCODE_CURSOR_SIDECAR=1/0 (force on/off).
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadCursorSdk } from "../cursor-runtime.js";
import { ensureSqliteBinding } from "../native-binding.js";
import { SidecarClient, type AgentLike } from "./sidecar-client.js";

export type { AgentLike, AgentRunLike, AgentSendOptions } from "./sidecar-client.js";

export type BackendKind = "in-process" | "sidecar";

export interface AgentBackend {
  kind: BackendKind;
  createAgent(options: unknown): Promise<AgentLike>;
  resumeAgent(agentId: string, options: unknown): Promise<AgentLike>;
}

export interface BackendEnvironment {
  isBun: boolean;
  /** Resolved node executable, or undefined when not on PATH. */
  nodePath: string | undefined;
}

/** Pure selection logic (unit-testable without spawning anything). */
export function resolveBackendKind(env: BackendEnvironment): BackendKind {
  const override = process.env["OPENCODE_CURSOR_SIDECAR"];
  if (override === "0" || override === "false") return "in-process";
  if (override === "1" || override === "true") return env.nodePath ? "sidecar" : "in-process";
  return env.isBun && env.nodePath ? "sidecar" : "in-process";
}

function detectNode(): string | undefined {
  try {
    const out = execSync(process.platform === "win32" ? "where node" : "command -v node", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.split("\n")[0] || undefined;
  } catch {
    return undefined;
  }
}

function detectEnvironment(): BackendEnvironment {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  // Only pay the PATH lookup when the answer can matter.
  const needsNode = isBun || process.env["OPENCODE_CURSOR_SIDECAR"] === "1";
  return { isBun, nodePath: needsNode ? detectNode() : process.execPath };
}

function inProcessBackend(): AgentBackend {
  return {
    kind: "in-process",
    createAgent: async (options) => {
      const { Agent } = await loadCursorSdk();
      return (await Agent.create(options as never)) as unknown as AgentLike;
    },
    resumeAgent: async (agentId, options) => {
      const { Agent } = await loadCursorSdk();
      return (await Agent.resume(agentId, options as never)) as unknown as AgentLike;
    },
  };
}

/**
 * Locate the sidecar script across layouts: tsup may place this module in
 * dist/provider/index.js or hoist it into a root-level dist/chunk-*.js, and in
 * dev/tests it runs straight from src/. Try each known relative position.
 */
export function resolveSidecarScript(): string | undefined {
  const candidates = [
    "./sidecar/agent-host.js", // importer is a chunk at dist root
    "../sidecar/agent-host.js", // importer is dist/provider/index.js
    "../sidecar/agent-host.mjs", // importer is src/provider/*.ts (dev/tests)
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  return undefined;
}

function sidecarBackend(nodePath: string, scriptPath: string): AgentBackend {
  const client = new SidecarClient({ scriptPath, nodePath });
  // The sidecar imports @cursor/sdk (which eagerly requires sqlite3's native
  // binding) in the child process; repair the binding before first use.
  return {
    kind: "sidecar",
    createAgent: async (options) => {
      await ensureSqliteBinding();
      return client.createAgent(options);
    },
    resumeAgent: async (agentId, options) => {
      await ensureSqliteBinding();
      return client.resumeAgent(agentId, options);
    },
  };
}

let cached: AgentBackend | undefined;

/** Resolve (and cache) the agent backend for this process. */
export function loadAgentBackend(): AgentBackend {
  if (!cached) {
    const env = detectEnvironment();
    const kind = resolveBackendKind(env);
    const scriptPath = kind === "sidecar" ? resolveSidecarScript() : undefined;
    // A user who explicitly opted out (OPENCODE_CURSOR_SIDECAR=0/false) has
    // accepted the in-process behavior and should not be warned.
    const override = process.env["OPENCODE_CURSOR_SIDECAR"];
    const optedOut = override === "0" || override === "false";
    if (env.isBun && !optedOut && (kind === "in-process" || !scriptPath)) {
      console.error(
        "[opencode-cursor] Running under Bun without a usable Node sidecar " +
          `(node: ${env.nodePath ?? "not found"}, script: ${scriptPath ?? "not found"}): ` +
          "Cursor native tool calls may fail (Bun node:http2 incompatibility). " +
          "Install Node.js to enable the sidecar, or set OPENCODE_CURSOR_SIDECAR=0 " +
          "to silence this warning.",
      );
    }
    cached =
      kind === "sidecar" && env.nodePath && scriptPath
        ? sidecarBackend(env.nodePath, scriptPath)
        : inProcessBackend();
  }
  return cached;
}

/** Test hook. */
export function resetAgentBackend(): void {
  cached = undefined;
}
