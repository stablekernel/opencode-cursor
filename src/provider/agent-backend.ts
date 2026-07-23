/**
 * Selects where Cursor agents run — three transports:
 *
 * - "http1": in-process via `@cursor/sdk` with
 *   `Cursor.configure({ local: { useHttp1ForAgent: true } })` — HTTP/1.1 + SSE,
 *   the Bun-safe path (Bun's `node:http2` bug kills Cursor's streaming RPC with
 *   NGHTTP2_FRAME_SIZE_ERROR; see oven-sh/bun#31499).
 * - "http2-direct": in-process via `@cursor/sdk` default HTTP/2 transport
 *   (Node — the normal path for tests, scripts, and any non-Bun host).
 * - "sidecar": a spawned Node child hosting the SDK (the historical Bun
 *   workaround; see src/sidecar/agent-host.mjs).
 *
 * Resolution order: provider option (`transport`) -> OPENCODE_CURSOR_TRANSPORT
 * -> legacy OPENCODE_CURSOR_SIDECAR (1=sidecar, 0=http2-direct) -> default
 * (Bun: DEFAULT_BUN_TRANSPORT, post-gate "http1"; Node: http2-direct).
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadCursorSdk } from "../cursor-runtime.js";
import { SidecarClient, type AgentLike } from "./sidecar-client.js";

export type { AgentLike, AgentRunLike, AgentSendOptions } from "./sidecar-client.js";

export type TransportKind = "http1" | "http2-direct" | "sidecar";
export type BackendKind = "in-process" | "sidecar";

/**
 * Bun default. Post-evidence-gate this is "http1" (Task 5/6 matrix green;
 * TTFT ≤ 1.5× sidecar). Sidecar remains via OPENCODE_CURSOR_TRANSPORT=sidecar.
 */
export const DEFAULT_BUN_TRANSPORT: TransportKind = "http1";

let preferredTransport: TransportKind | undefined;

/** Provider-option override (createCursor({transport})); beats env. Process-global. */
export function setPreferredTransport(t: TransportKind | undefined): void {
  preferredTransport = t;
}

function isTransportKind(v: string | undefined): v is TransportKind {
  return v === "http1" || v === "http2-direct" || v === "sidecar";
}

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

/**
 * Where Cursor agents run. Resolution: provider option -> OPENCODE_CURSOR_TRANSPORT
 * -> legacy OPENCODE_CURSOR_SIDECAR (1=sidecar, 0=http2-direct) -> default
 * (Bun: DEFAULT_BUN_TRANSPORT; Node: http2-direct, today's in-process path).
 */
export function resolveTransport(env: BackendEnvironment): TransportKind {
  const requested =
    preferredTransport ??
    (isTransportKind(process.env["OPENCODE_CURSOR_TRANSPORT"])
      ? (process.env["OPENCODE_CURSOR_TRANSPORT"] as TransportKind)
      : undefined);
  if (requested) {
    if (requested === "sidecar" && !env.nodePath) {
      return env.isBun ? "http1" : "http2-direct";
    }
    return requested;
  }
  const legacy = process.env["OPENCODE_CURSOR_SIDECAR"];
  if (legacy === "1" || legacy === "true") {
    return env.nodePath ? "sidecar" : env.isBun ? "http1" : "http2-direct";
  }
  if (legacy === "0" || legacy === "false") return "http2-direct";
  return env.isBun ? DEFAULT_BUN_TRANSPORT : "http2-direct";
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

let http1Configured = false;

/** Idempotent: enable the SDK's HTTP/1.1 agent transport (Bun-sanctioned path). */
async function ensureHttp1Configured(): Promise<void> {
  if (http1Configured) return;
  const { Cursor } = await loadCursorSdk();
  Cursor.configure({ local: { useHttp1ForAgent: true } });
  http1Configured = true;
}

function inProcessBackend(useHttp1: boolean): AgentBackend {
  return {
    kind: "in-process",
    createAgent: async (options) => {
      const { Agent } = await loadCursorSdk();
      if (useHttp1) await ensureHttp1Configured();
      return (await Agent.create(options as never)) as unknown as AgentLike;
    },
    resumeAgent: async (agentId, options) => {
      const { Agent } = await loadCursorSdk();
      if (useHttp1) await ensureHttp1Configured();
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
  return {
    kind: "sidecar",
    createAgent: (options) => client.createAgent(options),
    resumeAgent: (agentId, options) => client.resumeAgent(agentId, options),
  };
}

let cached: AgentBackend | undefined;

/** Resolve (and cache) the agent backend for this process. */
export function loadAgentBackend(): AgentBackend {
  if (!cached) {
    const env = detectEnvironment();
    const transport = resolveTransport(env);
    const scriptPath = transport === "sidecar" ? resolveSidecarScript() : undefined;
    if (transport === "sidecar" && (!env.nodePath || !scriptPath)) {
      // Explicit sidecar request we can't satisfy: fall back loudly.
      console.error(
        "[opencode-cursor] Node sidecar requested but unavailable " +
          `(node: ${env.nodePath ?? "not found"}, script: ${scriptPath ?? "not found"}); ` +
          "falling back to in-process HTTP/1.1 transport.",
      );
      cached = inProcessBackend(true);
      return cached;
    }
    if (transport === "http2-direct" && env.isBun) {
      console.error(
        "[opencode-cursor] http2-direct under Bun: Cursor streams may fail " +
          "(Bun node:http2 incompatibility, oven-sh/bun#31499). " +
          "Set OPENCODE_CURSOR_TRANSPORT=http1 (recommended) or sidecar.",
      );
    }
    cached =
      transport === "sidecar" && env.nodePath && scriptPath
        ? sidecarBackend(env.nodePath, scriptPath)
        : inProcessBackend(transport === "http1");
  }
  return cached;
}

/** Test hook. */
export function resetAgentBackend(): void {
  cached = undefined;
}
