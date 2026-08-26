import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	parsePluginSpec,
	resolveCacheEntry,
	argsToJsonSchema,
	mirrorPluginTools,
} from "../src/plugin/plugin-tool-registry.js";
import {
	resolvePluginToolsNodeCommand,
	resolvePluginToolsScript,
	startPluginToolsBridge,
} from "../src/plugin/plugin-tools-bridge.js";
import type { Config } from "@opencode-ai/plugin";
import type { MirroredTool } from "../src/plugin/plugin-tool-registry.js";

// --- spec parsing / cache resolution ---

describe("parsePluginSpec", () => {
	it("parses bare npm names", () => {
		expect(parsePluginSpec("opencode-pty")).toEqual({
			kind: "npm",
			name: "opencode-pty",
		});
	});
	it("parses @latest specs", () => {
		expect(parsePluginSpec("opencode-pty@latest")).toEqual({
			kind: "npm",
			name: "opencode-pty",
			version: "latest",
		});
	});
	it("parses scoped specs", () => {
		expect(parsePluginSpec("@tarquinen/opencode-dcp@latest")).toEqual({
			kind: "npm",
			name: "@tarquinen/opencode-dcp",
			version: "latest",
		});
	});
	it("parses git specs", () => {
		const parsed = parsePluginSpec(
			"superpowers@git+https://github.com/obra/superpowers.git",
		);
		expect(parsed).toMatchObject({
			kind: "git",
			name: "superpowers",
		});
	});
	it("parses file paths", () => {
		expect(parsePluginSpec("./local-plugin.ts")).toMatchObject({
			kind: "path",
		});
		expect(parsePluginSpec("~/global-plugin.js")).toMatchObject({
			kind: "path",
		});
	});
	it("marks URL tarball specs unsupported (not git)", () => {
		expect(parsePluginSpec("pkg@https://registry.example.com/pkg.tgz")).toEqual({
			kind: "unsupported",
			raw: "pkg@https://registry.example.com/pkg.tgz",
		});
	});
});

describe("resolveCacheEntry", () => {
	const dirs: string[] = [];
	function tmp(): string {
		const d = mkdtempSync(join(tmpdir(), "pty-cache-"));
		dirs.push(d);
		return d;
	}
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("finds name@latest entries", async () => {
		const { mkdirSync } = await import("node:fs");
		const root = tmp();
		mkdirSync(join(root, "opencode-pty@latest"), { recursive: true });
		const entry = resolveCacheEntry(root, {
			kind: "npm",
			name: "opencode-pty",
			version: "latest",
		});
		expect(entry).toBe(join(root, "opencode-pty@latest"));
	});

	it("falls back to bare-name entries", async () => {
		const { mkdirSync } = await import("node:fs");
		const root = tmp();
		mkdirSync(join(root, "opencode-pty"), { recursive: true });
		const entry = resolveCacheEntry(root, {
			kind: "npm",
			name: "opencode-pty",
		});
		expect(entry).toBe(join(root, "opencode-pty"));
	});

	it("returns undefined when the entry is missing", () => {
		const root = tmp();
		expect(
			resolveCacheEntry(root, { kind: "npm", name: "nope" }),
		).toBeUndefined();
	});
});

// --- schema extraction ---

describe("argsToJsonSchema", () => {
	it("handles null/undefined args", () => {
		const schema = argsToJsonSchema(undefined);
		expect(schema).toMatchObject({ type: "object", properties: {} });
	});
	it("handles plain JSON-schema args (legacy path)", () => {
		const schema = argsToJsonSchema({
			command: { type: "string", description: "the command" },
		});
		expect(schema).toMatchObject({
			type: "object",
			properties: { command: { type: "string" } },
		});
	});
	it("converts zod v4 args (bundled with @opencode-ai/plugin)", async () => {
		const { tool } = await import("@opencode-ai/plugin");
		const def = tool({
			description: "t",
			args: { name: tool.schema.string() },
			execute: async () => "ok",
		});
		const schema = argsToJsonSchema(def.args);
		expect(schema.type).toBe("object");
		expect((schema.properties as Record<string, unknown>)["name"]).toBeDefined();
	});
});

// --- mirrorPluginTools end-to-end against a fake plugin ---

describe("mirrorPluginTools", () => {
	const dirs: string[] = [];
	function tmp(): string {
		const d = mkdtempSync(join(tmpdir(), "pty-mirror-"));
		dirs.push(d);
		return d;
	}
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	async function writeFakePlugin(cacheRoot: string): Promise<void> {
		const { mkdirSync, writeFileSync } = await import("node:fs");
		const pkgDir = join(
			cacheRoot,
			"fake-plugin@latest",
			"node_modules",
			"fake-plugin",
		);
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(
			join(pkgDir, "index.js"),
			`
const server = async () => ({
	tool: {
		fake_echo: {
			description: "Echoes input.",
			args: { text: { type: "string" } },
			execute: async (args) => ({ title: "echo", output: "echo:" + args.text }),
		},
	},
});
export default server;
`,
			"utf8",
		);
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({ name: "fake-plugin", version: "1.0.0", type: "module" }),
			"utf8",
		);
	}

	it("mirrors a plugin's tool map from the cache", async () => {
		const cacheRoot = tmp();
		await writeFakePlugin(cacheRoot);
		const config = { plugin: ["fake-plugin@latest"] } as unknown as Config;
		const result = await mirrorPluginTools(config, {}, { cacheRoot });
		expect(result.tools.map((t) => t.id)).toEqual(["fake_echo"]);
		expect(result.tools[0]!.sourcePlugin).toBe("fake-plugin@latest");
		expect(result.failed).toEqual({});
	});

	it("skips itself and records failures for missing plugins", async () => {
		const cacheRoot = tmp();
		await writeFakePlugin(cacheRoot);
		const config = {
			plugin: [
				"@stablekernel/opencode-cursor@latest",
				"missing-plugin@latest",
				"fake-plugin@latest",
			],
		} as unknown as Config;
		const result = await mirrorPluginTools(config, {}, { cacheRoot });
		expect(result.tools.map((t) => t.id)).toEqual(["fake_echo"]);
		expect(result.failed["@stablekernel/opencode-cursor@latest"]).toBeUndefined();
		expect(result.failed["missing-plugin@latest"]).toBeDefined();
	});

	it("applies include/exclude filters", async () => {
		const cacheRoot = tmp();
		await writeFakePlugin(cacheRoot);
		const config = { plugin: ["fake-plugin@latest"] } as unknown as Config;

		const excluded = await mirrorPluginTools(
			config,
			{},
			{
				cacheRoot,
				exclude: ["fake_*"],
			},
		);
		expect(excluded.tools).toHaveLength(0);

		const included = await mirrorPluginTools(
			config,
			{},
			{
				cacheRoot,
				include: ["fake_echo"],
			},
		);
		expect(included.tools).toHaveLength(1);
	});

	it("executes mirrored tools and propagates results", async () => {
		const cacheRoot = tmp();
		await writeFakePlugin(cacheRoot);
		const config = { plugin: ["fake-plugin@latest"] } as unknown as Config;
		const result = await mirrorPluginTools(config, {}, { cacheRoot });
		const toolDef = result.tools[0]!;
		// SAFETY: the fake tool ignores its context; cast avoids constructing
		// a full ToolContext for a unit test.
		const out = await toolDef.execute({ text: "hi" }, {} as never);
		expect(out).toMatchObject({ title: "echo", output: "echo:hi" });
	});
});

// --- bridge: control server + MCP child round-trip ---

describe("plugin-tools bridge", () => {
	const dirs: string[] = [];
	function tmp(): string {
		const d = mkdtempSync(join(tmpdir(), "pty-bridge-"));
		dirs.push(d);
		return d;
	}
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	function fakeTool(id: string, opts?: { ask?: boolean }): MirroredTool {
		return {
			id,
			description: `${id} description`,
			parameters: { type: "object", properties: { text: { type: "string" } } },
			execute: async (args, ctx) => {
				if (opts?.ask) {
					// SAFETY: the bridge only ever invokes `ask` with the four fields
					// opencode's AskInput defines; the cast keeps the test free of a
					// full ToolContext without loosening the module under test.
					const ask = ctx.ask as (input: {
						permission: string;
						patterns: string[];
						always: string[];
						metadata: Record<string, unknown>;
					}) => Promise<void>;
					await ask({
						permission: id,
						patterns: ["*"],
						always: ["*"],
						metadata: {},
					});
				}
				return {
					title: `${id} ran`,
					output: `out:${(args as { text?: string }).text ?? ""}`,
				};
			},
			sourcePlugin: "fake@latest",
		};
	}

	it("resolves the MCP script in the src layout", () => {
		expect(resolvePluginToolsScript()).toMatch(/plugin-tools-mcp\.mjs$/);
	});

	it("uses execPath when it is node or bun", () => {
		expect(resolvePluginToolsNodeCommand("/opt/homebrew/bin/node")).toBe(
			"/opt/homebrew/bin/node",
		);
		expect(resolvePluginToolsNodeCommand("/Users/me/.bun/bin/bun")).toBe(
			"/Users/me/.bun/bin/bun",
		);
		expect(
			resolvePluginToolsNodeCommand("C:\\Program Files\\nodejs\\node.exe"),
		).toBe("C:\\Program Files\\nodejs\\node.exe");
	});

	it("looks up node when execPath is a compiled host binary", () => {
		expect(
			resolvePluginToolsNodeCommand(
				"/opt/homebrew/bin/opencode",
				() => "/usr/local/bin/node",
			),
		).toBe("/usr/local/bin/node");
		expect(
			resolvePluginToolsNodeCommand("/opt/homebrew/bin/opencode", () => undefined),
		).toBeUndefined();
	});

	it("serves tools/list and tools/call through the MCP child", async () => {
		const bridge = await startPluginToolsBridge({
			tools: [fakeTool("fake_echo")],
			directory: tmp(),
		});
		try {
			expect(bridge.mcpServer).toBeDefined();
			const { command, args, env } = bridge.mcpServer!;
			const child = spawn(command, args ?? [], {
				env: { ...process.env, ...env },
				stdio: ["pipe", "pipe", "pipe"],
			});

			const responses = new Map<number | string, unknown>();
			let buf = "";
			child.stdout!.on("data", (chunk: Buffer) => {
				buf += chunk.toString();
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					const msg = JSON.parse(line) as { id?: number };
					if (msg.id !== undefined) responses.set(msg.id, msg);
				}
			});

			const send = (msg: unknown) =>
				child.stdin!.write(JSON.stringify(msg) + "\n");
			const waitFor = async (id: number) => {
				for (let i = 0; i < 100; i++) {
					if (responses.has(id)) return responses.get(id);
					await new Promise((r) => setTimeout(r, 20));
				}
				throw new Error(`no response for id ${id}`);
			};

			send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
			const init = (await waitFor(1)) as {
				result: { serverInfo: { name: string } };
			};
			expect(init.result.serverInfo.name).toBe("opencode-plugin-tools");

			send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
			const list = (await waitFor(2)) as {
				result: { tools: Array<{ name: string; inputSchema: unknown }> };
			};
			expect(list.result.tools.map((t) => t.name)).toEqual(["fake_echo"]);
			expect(list.result.tools[0]!.inputSchema).toMatchObject({
				type: "object",
			});

			send({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "fake_echo", arguments: { text: "abc" } },
			});
			const call = (await waitFor(3)) as {
				result: { content: Array<{ text: string }>; isError?: boolean };
			};
			expect(call.result.isError).toBeFalsy();
			expect(call.result.content[0]!.text).toContain("out:abc");

			// Unknown tool → error result, not a crash.
			send({
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: { name: "nope", arguments: {} },
			});
			const unknown = (await waitFor(4)) as {
				result: { isError: boolean; content: Array<{ text: string }> };
			};
			expect(unknown.result.isError).toBe(true);
			expect(unknown.result.content[0]!.text).toMatch(/unknown tool/);

			child.kill();
		} finally {
			await bridge.close();
		}
	});

	it("rejects control-channel requests without the token", async () => {
		const bridge = await startPluginToolsBridge({
			tools: [fakeTool("fake_echo")],
			directory: tmp(),
		});
		try {
			const port = Number(bridge.mcpServer!.env["OPENCODE_PLUGIN_TOOLS_PORT"]);
			const res = await fetch(`http://127.0.0.1:${port}/tools`);
			expect(res.status).toBe(401);
		} finally {
			await bridge.close();
		}
	});

	it("propagates permission failures as call errors", async () => {
		const bridge = await startPluginToolsBridge({
			tools: [fakeTool("gated", { ask: true })],
			directory: tmp(),
			// No askGate → fail closed.
		});
		try {
			const port = Number(bridge.mcpServer!.env["OPENCODE_PLUGIN_TOOLS_PORT"]);
			const res = await fetch(`http://127.0.0.1:${port}/call`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${bridge.mcpServer!.env["OPENCODE_PLUGIN_TOOLS_TOKEN"]}`,
				},
				body: JSON.stringify({ id: "gated", args: { text: "x" } }),
			});
			const body = (await res.json()) as { ok: boolean; error?: string };
			expect(body.ok).toBe(false);
			expect(body.error).toMatch(/permission gate unavailable/);
		} finally {
			await bridge.close();
		}
	});

	it("runs ask-gated tools when the gate approves", async () => {
		const asked: Array<{ permission: string }> = [];
		const bridge = await startPluginToolsBridge({
			tools: [fakeTool("gated", { ask: true })],
			directory: tmp(),
			askGate: async (req) => {
				asked.push({ permission: req.permission });
			},
		});
		try {
			const port = Number(bridge.mcpServer!.env["OPENCODE_PLUGIN_TOOLS_PORT"]);
			const res = await fetch(`http://127.0.0.1:${port}/call`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${bridge.mcpServer!.env["OPENCODE_PLUGIN_TOOLS_TOKEN"]}`,
				},
				body: JSON.stringify({ id: "gated", args: { text: "ok" } }),
			});
			const body = (await res.json()) as { ok: boolean; output?: string };
			expect(body.ok).toBe(true);
			expect(body.output).toBe("out:ok");
			expect(asked).toEqual([{ permission: "gated" }]);
		} finally {
			await bridge.close();
		}
	});

	it("tools/list fails fast against a hung control port", {
		timeout: 20_000,
	}, async () => {
		// A control port that accepts connections but never responds (stale
		// server) must not hang Cursor's MCP discovery — listTools aborts after
		// its 5s budget and degrades to an empty tool list.
		const { createServer } = await import("node:http");
		const hung = createServer(() => {
			// never respond
		});
		await new Promise<void>((resolve) =>
			hung.listen(0, "127.0.0.1", () => resolve()),
		);
		const address = hung.address();
		const port = typeof address === "object" && address ? address.port : 0;
		try {
			const child = spawn(process.execPath, ["src/sidecar/plugin-tools-mcp.mjs"], {
				env: {
					...process.env,
					OPENCODE_PLUGIN_TOOLS_PORT: String(port),
					OPENCODE_PLUGIN_TOOLS_TOKEN: "t",
				},
				stdio: ["pipe", "pipe", "pipe"],
			});
			const started = Date.now();
			const reply = await new Promise<string>((resolve, reject) => {
				let buf = "";
				child.stdout!.on("data", (chunk: Buffer) => {
					buf += chunk.toString();
					const line = buf.split("\n").find((l) => l.trim());
					if (line) resolve(line);
				});
				child.once("error", reject);
				child.once("exit", () => reject(new Error("child exited")));
				child.stdin!.write(
					JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
				);
			});
			const elapsed = Date.now() - started;
			const parsed = JSON.parse(reply) as { result?: { tools?: unknown[] } };
			expect(parsed.result?.tools).toEqual([]);
			// 5s budget + slack — anything under 10s proves we did not hang.
			expect(elapsed).toBeLessThan(10_000);
			child.kill();
		} finally {
			await new Promise<void>((resolve) => hung.close(() => resolve()));
			hung.closeAllConnections?.();
		}
	});
});

// --- full plugin wiring: config hook merges the bridge into mcpServers ---
