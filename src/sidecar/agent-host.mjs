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
