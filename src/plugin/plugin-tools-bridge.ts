/**
 * Localhost control channel + MCP wiring for the plugin-tools bridge.
 *
 * The host plugin owns the mirrored tool closures (see
 * `plugin-tool-registry.ts`). The stdio MCP child
 * (`sidecar/plugin-tools-mcp.mjs`) can't hold those closures, so it talks to
 * this HTTP server on 127.0.0.1 for `tools/list` and `tools/call`. The server
 * binds to loopback only and requires a bearer token (generated per session,
 * passed to the child via env) so nothing else on the machine can invoke the
 * user's plugin tools through it.
 *
 * Execution happens through the mirrored `execute` closures with a synthetic
 * `ToolContext` whose `ask` delegates to the user's opencode permission gate
 * (same `context.ask` pattern the delegation tools use), so a `permission`
 * config entry for a tool id applies to Cursor-originated calls too.
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import type { ToolContext } from "@opencode-ai/plugin";
import type { MirroredTool } from "./plugin-tool-registry.js";
import { pluginLog } from "../provider/log-bridge.js";

export interface PluginToolsBridge {
	/** The MCP server config to hand to the Cursor agent, or undefined. */
	mcpServer?: {
		type: "stdio";
		command: string;
		args: string[];
		env: Record<string, string>;
	};
	/** Stop the control server (called on dispose). */
	close: () => Promise<void>;
}

/**
 * Build the `ToolContext` handed to a mirrored tool's `execute`. `ask`
 * delegates to the supplied gate so the user's opencode permission config
 * applies; when no gate exists the call fails closed (matches the
 * delegation-tool behaviour — never silently allow a sensitive action).
 */
function buildToolContext(
	args: { sessionID: string; agent: string; directory: string },
	askGate?: ToolContext["ask"],
): ToolContext {
	const controller = new AbortController();
	return {
		sessionID: args.sessionID,
		messageID: "cursor-plugin-tools",
		agent: args.agent,
		directory: args.directory,
		worktree: args.directory,
		abort: controller.signal,
		metadata: () => {},
		ask: async (input) => {
			if (!askGate) {
				throw new Error(
					"permission gate unavailable — refusing to run plugin tool without approval",
				);
			}
			await askGate(input);
		},
	};
}

/**
 * Locate the stdio MCP server script across dist/dev layouts (same pattern
 * as `resolveSidecarScript` in provider/agent-backend.ts).
 */
export function resolvePluginToolsScript(): string | undefined {
	const candidates = [
		"./plugin-tools-mcp.js", // importer is a chunk at dist root
		"../sidecar/plugin-tools-mcp.js", // importer is dist/plugin/index.js
		"../sidecar/plugin-tools-mcp.mjs", // importer is src/plugin/*.ts (dev/tests)
	];
	for (const candidate of candidates) {
		const path = fileURLToPath(new URL(candidate, import.meta.url));
		if (existsSync(path)) return path;
	}
	return undefined;
}

function execBasename(execPath: string): string {
	const base = execPath.split(/[/\\]/).pop() ?? "";
	return base.replace(/\.exe$/i, "").toLowerCase();
}

export function resolvePluginToolsNodeCommand(
	execPath = process.execPath,
	lookupNode?: () => string | undefined,
): string | undefined {
	const name = execBasename(execPath);
	if (name === "node" || name === "bun") return execPath;
	if (lookupNode) return lookupNode() || undefined;
	try {
		const out = execSync(
			process.platform === "win32" ? "where node" : "command -v node",
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			},
		).trim();
		return out.split("\n")[0] || undefined;
	} catch {
		return undefined;
	}
}

export interface StartBridgeOptions {
	tools: MirroredTool[];
	/** Directory the mirrored tools should see as `context.directory`. */
	directory: string;
	/**
	 * Permission gate for `context.ask`. When omitted, tools whose execution
	 * calls `ask` fail closed.
	 */
	askGate?: ToolContext["ask"];
	/** Session id stamped into the synthetic ToolContext. */
	sessionID?: string;
	/** Agent name stamped into the synthetic ToolContext. */
	agent?: string;
}

/**
 * Start the localhost control server and build the MCP server config for the
 * Cursor agent. Returns `{ close }` with no `mcpServer` when the script or a
 * usable Node binary can't be found — the bridge degrades to "not offered"
 * rather than failing plugin init.
 */
export async function startPluginToolsBridge(
	options: StartBridgeOptions,
): Promise<PluginToolsBridge> {
	const scriptPath = resolvePluginToolsScript();
	if (!scriptPath) {
		pluginLog("warn", "plugin-tools MCP script not found; bridge disabled");
		return { close: async () => {} };
	}
	const nodePath = resolvePluginToolsNodeCommand();
	if (!nodePath) {
		pluginLog("warn", "plugin-tools MCP needs node on PATH; bridge disabled");
		return { close: async () => {} };
	}

	const token = randomBytes(24).toString("hex");
	const toolById = new Map(options.tools.map((t) => [t.id, t]));

	const server: Server = createServer((req, res) => {
		const send = (status: number, body: unknown) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		const auth = req.headers["authorization"];
		if (auth !== `Bearer ${token}`) {
			send(401, { error: "unauthorized" });
			return;
		}
		if (req.method === "GET" && req.url === "/tools") {
			send(200, {
				tools: options.tools.map((t) => ({
					id: t.id,
					description: t.description,
					parameters: t.parameters,
				})),
			});
			return;
		}
		if (req.method === "POST" && req.url === "/call") {
			// Cap request bodies: loopback + token limits the blast radius, but
			// an unbounded accumulator would still let a caller exhaust memory.
			const MAX_BODY = 10 * 1024 * 1024;
			let raw = "";
			let size = 0;
			req.on("data", (chunk) => {
				size += chunk.length;
				if (size > MAX_BODY) {
					req.destroy();
					return;
				}
				raw += chunk;
			});
			req.on("end", async () => {
				if (size > MAX_BODY) return; // destroyed above
				let body: { id?: string; args?: Record<string, unknown> };
				try {
					body = JSON.parse(raw);
				} catch {
					send(400, { ok: false, error: "invalid JSON body" });
					return;
				}
				const tool = body.id ? toolById.get(body.id) : undefined;
				if (!tool) {
					send(404, { ok: false, error: `unknown tool: ${body.id}` });
					return;
				}
				try {
					const ctx = buildToolContext(
						{
							sessionID: options.sessionID ?? "cursor-plugin-tools",
							agent: options.agent ?? "cursor",
							directory: options.directory,
						},
						options.askGate,
					);
					const result = await tool.execute((body.args ?? {}) as never, ctx);
					if (typeof result === "string") {
						send(200, { ok: true, output: result });
					} else {
						send(200, {
							ok: true,
							title: result.title,
							output: result.output,
							metadata: result.metadata,
						});
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					send(200, { ok: false, error: message });
				}
			});
			return;
		}
		send(404, { error: "not found" });
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : undefined;
	if (!port) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		pluginLog(
			"warn",
			"plugin-tools control server failed to bind; bridge disabled",
		);
		return { close: async () => {} };
	}

	return {
		mcpServer: {
			type: "stdio",
			command: nodePath,
			args: [scriptPath],
			env: {
				OPENCODE_PLUGIN_TOOLS_PORT: String(port),
				OPENCODE_PLUGIN_TOOLS_TOKEN: token,
			},
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				// Force-close lingering keep-alive sockets so dispose doesn't hang.
				server.closeAllConnections?.();
			}),
	};
}
