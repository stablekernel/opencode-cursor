/**
 * stdio MCP server that exposes opencode plugins' custom tools to the Cursor
 * agent. Spawned by the plugin with `OPENCODE_PLUGIN_TOOLS_TOKEN` in env; it
 * talks to the host plugin over a localhost HTTP control channel (also
 * token-authenticated) that owns the real tool closures.
 *
 * Wire protocol (control channel):
 *   GET  /tools                 → { tools: [{id, description, parameters}] }
 *   POST /call {id, args}       → { ok, title?, output?, error? }
 *
 * Every `tools/call` from Cursor becomes one POST /call; the host executes
 * the mirrored tool with a permission-gated ToolContext and returns the
 * result. Plain JSON-lines stdio MCP on the other side (see run()).
 *
 * Kept as plain .mjs so tests can spawn it pre-build; tsup bundles it to
 * dist/sidecar/plugin-tools-mcp.js for production.
 */
import { createInterface } from "node:readline";

const CONTROL_PORT = Number(process.env.OPENCODE_PLUGIN_TOOLS_PORT ?? 0);
const TOKEN = process.env.OPENCODE_PLUGIN_TOOLS_TOKEN ?? "";
const SERVER_NAME = "opencode-plugin-tools";
const SERVER_VERSION = "1.0.0";
// The single protocol version this server implements. Never echo the
// client-proposed version — MCP servers must answer with a version they
// actually support.
const PROTOCOL_VERSION = "2025-06-18";

function logErr(message, extra) {
  try {
    process.stderr.write(
      `[plugin-tools-mcp] ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}\n`,
    );
  } catch {
    // never throw from logging
  }
}

async function controlRequest(path, body, timeoutMs) {
  const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
    // A stale/hung port must not hang Cursor's MCP discovery (tools/list) or
    // block a tool call forever. Loopback list is instant; calls get a
    // generous ceiling because plugin tools can legitimately run for minutes.
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const message = json?.error ?? `control channel ${res.status}`;
    throw new Error(message);
  }
  return json;
}

async function listTools() {
  try {
    const data = await controlRequest("/tools", undefined, 5_000);
    return data?.tools ?? [];
  } catch (err) {
    logErr("tools/list failed", { error: String(err) });
    return [];
  }
}

async function callTool(name, args) {
  try {
    const data = await controlRequest("/call", { id: name, args: args ?? {} }, 300_000);
    if (data?.ok === false) {
      return {
        isError: true,
        content: [{ type: "text", text: data.error ?? "tool call failed" }],
      };
    }
    const output = data?.output ?? "";
    const title = data?.title ? `${data.title}\n\n` : "";
    return { content: [{ type: "text", text: `${title}${output}` }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: String(err) }] };
  }
}

/** Handle one MCP request and return the response payload (or undefined for notifications). */
async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const error = (code, message) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Tools provided by opencode plugins, bridged into the Cursor agent. " +
          "Each call runs the plugin's real implementation inside opencode's runtime.",
      });
    case "notifications/initialized":
      return undefined;
    case "ping":
      return reply({});
    case "tools/list": {
      const tools = await listTools();
      return reply({
        tools: tools.map((t) => ({
          name: t.id,
          description: t.description,
          inputSchema: t.parameters ?? { type: "object", properties: {} },
        })),
      });
    }
    case "tools/call": {
      const result = await callTool(params?.name, params?.arguments);
      return reply(result);
    }
    default:
      if (id === undefined) return undefined; // unknown notification
      return error(-32601, `method not found: ${method}`);
  }
}

function run() {
  if (!CONTROL_PORT || !TOKEN) {
    logErr("missing OPENCODE_PLUGIN_TOOLS_PORT/TOKEN env; exiting");
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        }) + "\n",
      );
      return;
    }
    try {
      const response = await handle(msg);
      if (response !== undefined) {
        process.stdout.write(JSON.stringify(response) + "\n");
      }
    } catch (err) {
      if (msg.id !== undefined) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32603, message: String(err) },
          }) + "\n",
        );
      }
    }
  });
  rl.on("close", () => process.exit(0));
  // Keep the process alive until stdin closes (Cursor owns the lifecycle).
  process.stdin.resume();
}

// Start the stdio loop only when spawned as the entry script (Cursor owns
// the lifecycle). Tests import the handlers above without triggering it.
import { fileURLToPath } from "node:url";
const scriptFile = fileURLToPath(import.meta.url);
if (process.argv[1] === scriptFile) run();

export { handle, listTools, callTool };
