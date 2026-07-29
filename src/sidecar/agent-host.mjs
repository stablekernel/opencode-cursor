/**
 * Cursor agent sidecar — runs under Node and hosts all `@cursor/sdk` agent
 * traffic on behalf of the provider.
 *
 * Why this exists: opencode executes plugins under Bun, whose `node:http2`
 * client breaks Cursor's streaming connect RPC (NGHTTP2_FRAME_SIZE_ERROR);
 * tool-completion updates are lost and every native tool call dangles. Under
 * Node the same stream works, so when Bun is detected the provider spawns this
 * script with Node and proxies agent calls over a JSON-lines stdio protocol
 * (see sidecar-client.ts for the client side).
 *
 * Protocol (one JSON object per line):
 *   request:  {id, op: "ping"|"create"|"resume"|"send"|"cancel"|"close", ...}
 *   response: {id, ok: true, ...} | {id, ok: false, error: {name, message}}
 *   send stream: {id, ev: "update", update} ... then exactly one of
 *                {id, ev: "result", result} | {id, ev: "error", error}
 *
 * Kept as plain .mjs so tests can spawn it pre-build; tsup also bundles it to
 * dist/sidecar/agent-host.js for production.
 */
import { createInterface } from "node:readline";

/** Plain-data error shape that survives JSON; name + classification fields
 * preserved so the Bun side can discriminate (see error-classify.ts). */
function serializeError(err) {
  if (err instanceof Error) {
    const out = { name: err.name, message: err.message };
    for (const k of ["status", "code", "isRetryable", "helpUrl"]) {
      const v = err[k];
      if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") out[k] = v;
    }
    return out;
  }
  return { name: "Error", message: String(err) };
}

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

// `@cursor/sdk`'s bundled local-exec runtime writes its rules/skills
// load-completion diagnostics straight to `console.log` (no public logger
// hook exists to redirect it — see src/provider/cursor-log-intercept.ts,
// which applies the identical pattern for the in-process transport). This
// process's own JSONL protocol never uses console.log (only
// process.stdout.write via write() above), so console.log here is entirely
// free for the SDK's use: recognized lines are forwarded to the parent as a
// structured "log" event instead of being written as raw, unparseable text.
const RULE_LOAD_PATTERN =
  /^\d{2}:\d{2}:\d{2}\.\d{3}\s+INFO\s+(LocalCursorRulesService|AgentSkillsCursorRulesService|CursorPluginsAgentSkillsService) load completed(?:\s+ctx=\S+)?\s+meta=\{([^}]*)\}\s*$/;

function parseLogMeta(raw) {
  const out = {};
  for (const part of raw.split(",")) {
    const [key, value] = part.split(":").map((s) => s.trim());
    if (!key || value === undefined) continue;
    const num = Number(value);
    if (Number.isFinite(num)) out[key] = num;
  }
  return out;
}

const originalConsoleLog = console.log.bind(console);
console.log = (...args) => {
  if (args.length === 1 && typeof args[0] === "string") {
    const match = RULE_LOAD_PATTERN.exec(args[0].replace(ANSI_PATTERN, ""));
    if (match) {
      const [, service, meta] = match;
      write({
        ev: "log",
        level: "info",
        message: `${service} load completed`,
        meta: parseLogMeta(meta ?? ""),
      });
      return;
    }
  }
  originalConsoleLog(...args);
};

let sdkPromise;
function loadSdk() {
  // OPENCODE_CURSOR_SDK_PATH lets tests substitute a fake SDK module.
  sdkPromise ??= import(process.env.OPENCODE_CURSOR_SDK_PATH || "@cursor/sdk");
  return sdkPromise;
}

/** agentId -> SDKAgent */
const agents = new Map();
/** send request id -> Run (for cancel) */
const runs = new Map();

async function handleRequest(req) {
  const { id, op } = req;
  switch (op) {
    case "ping": {
      write({ id, ok: true, pid: process.pid });
      return;
    }
    case "create":
    case "resume": {
      const { Agent } = await loadSdk();
      const agent =
        op === "resume"
          ? await Agent.resume(req.agentId, req.options)
          : await Agent.create(req.options);
      agents.set(agent.agentId, agent);
      write({ id, ok: true, agentId: agent.agentId });
      return;
    }
    case "send": {
      const agent = agents.get(req.agentId);
      if (!agent) throw new Error(`unknown agent "${req.agentId}"`);
      const sendOptions = {
        ...(req.mode ? { mode: req.mode } : {}),
        ...(req.force ? { local: { force: true } } : {}),
        ...(req.idempotencyKey ? { idempotencyKey: req.idempotencyKey } : {}),
        onDelta: ({ update }) => write({ id, ev: "update", update }),
      };
      const run = await agent.send(req.message, sendOptions);
      runs.set(id, run);
      // Acknowledge so the client can hand back a cancellable run handle.
      write({ id, ok: true });
      try {
        const result = await run.wait();
        write({ id, ev: "result", result });
      } catch (err) {
        write({ id, ev: "error", error: serializeError(err) });
      } finally {
        runs.delete(id);
      }
      return;
    }
    case "cancel": {
      const run = runs.get(req.sendId);
      if (run) await run.cancel();
      write({ id, ok: true });
      return;
    }
    case "close": {
      const agent = agents.get(req.agentId);
      agents.delete(req.agentId);
      try {
        agent?.close();
      } catch {
        // best effort
      }
      write({ id, ok: true });
      return;
    }
    default:
      throw new Error(`unknown op "${op}"`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch (err) {
    write({ id: null, ok: false, error: serializeError(err) });
    return;
  }
  handleRequest(req).catch((err) => {
    write({ id: req.id, ok: false, error: serializeError(err) });
  });
});

// Parent gone (stdin closed) -> shut down; never outlive the plugin process.
rl.on("close", () => {
  process.exit(0);
});
