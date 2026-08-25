import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep live model discovery offline for the whole file.
vi.mock("../src/model-discovery.js", () => ({
	discoverModels: async () => ({ models: [], source: "fallback" }),
	toOpencodeModels: () => ({}),
}));

describe("CursorPlugin plugin-tools wiring", () => {
	const dirs: string[] = [];
	function tmp(): string {
		const d = mkdtempSync(join(tmpdir(), "pty-wire-"));
		dirs.push(d);
		return d;
	}
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	async function writeToolPlugin(cacheRoot: string): Promise<void> {
		const { mkdirSync, writeFileSync } = await import("node:fs");
		const pkgDir = join(
			cacheRoot,
			"wire-plugin@latest",
			"node_modules",
			"wire-plugin",
		);
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({
				name: "wire-plugin",
				version: "1.0.0",
				type: "module",
				main: "./index.js",
			}),
			"utf8",
		);
		writeFileSync(
			join(pkgDir, "index.js"),
			`export default async () => ({
	tool: {
		wire_tool: {
			description: "Wired tool.",
			args: {},
			execute: async (args, ctx) => {
				await ctx.ask({
					permission: "wire_tool",
					patterns: [args?.file ?? "*"],
					always: ["*"],
					metadata: {},
				});
				return "wired-ok";
			},
		},
	},
});
`,
			"utf8",
		);
	}

	it("adds opencode-plugin-tools to mcpServers and gates by permission", async () => {
		const { default: plugin } = await import("../src/plugin/index.js");
		// Lay the fake cache out exactly like opencodePackagesRoot expects:
		// $XDG_CACHE_HOME/opencode/packages/<spec>/node_modules/<pkg>/.
		const home = tmp();
		const cacheRoot = join(home, ".cache", "opencode", "packages");
		await writeToolPlugin(cacheRoot);
		const prevHome = process.env.HOME;
		const prevXdg = process.env.XDG_CONFIG_HOME;
		const prevCache = process.env.XDG_CACHE_HOME;
		process.env.HOME = home;
		process.env.XDG_CONFIG_HOME = join(home, ".config");
		delete process.env.XDG_CACHE_HOME;
		try {
			const cwd = tmp();
			const hooks = await plugin({
				directory: cwd,
				client: undefined,
				project: {},
				worktree: cwd,
				serverUrl: new URL("http://localhost:4096"),
				experimental_workspace: { register() {} },
			} as never);

			// Case A: no permission rule → bridge configured, calls fail closed.
			const config = {
				plugin: ["wire-plugin@latest"],
				provider: {},
				mcp: {},
			} as never;
			await hooks.config!(config);
			const options = (
				config as {
					provider: Record<string, { options?: Record<string, unknown> }>;
				}
			).provider["cursor"]!.options!;
			const servers = options["mcpServers"] as Record<
				string,
				{ command: string; args?: string[]; env: Record<string, string> }
			>;
			const bridgeServer = servers["opencode-plugin-tools"];
			expect(bridgeServer).toBeDefined();

			const port = Number(bridgeServer!.env["OPENCODE_PLUGIN_TOOLS_PORT"]);
			const token = bridgeServer!.env["OPENCODE_PLUGIN_TOOLS_TOKEN"];
			const denied = (await fetch(`http://127.0.0.1:${port}/call`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({ id: "wire_tool", args: {} }),
			}).then((r) => r.json())) as { ok: boolean; error?: string };
			expect(denied.ok).toBe(false);
			expect(denied.error).toMatch(/ask/);

			await hooks.dispose!();

			// Case B: permission allow → the same flow executes the tool.
			const hooks2 = await plugin({
				directory: cwd,
				client: undefined,
				project: {},
				worktree: cwd,
				serverUrl: new URL("http://localhost:4096"),
				experimental_workspace: { register() {} },
			} as never);
			const config2 = {
				plugin: ["wire-plugin@latest"],
				permission: { wire_tool: "allow" },
				provider: {},
				mcp: {},
			} as never;
			await hooks2.config!(config2);
			const servers2 = (
				config2 as {
					provider: Record<string, { options?: Record<string, unknown> }>;
				}
			).provider["cursor"]!.options!["mcpServers"] as Record<
				string,
				{ env: Record<string, string> }
			>;
			const bridgeServer2 = servers2["opencode-plugin-tools"];
			expect(bridgeServer2).toBeDefined();
			const port2 = Number(bridgeServer2!.env["OPENCODE_PLUGIN_TOOLS_PORT"]);
			const token2 = bridgeServer2!.env["OPENCODE_PLUGIN_TOOLS_TOKEN"];
			const okCall = (await fetch(`http://127.0.0.1:${port2}/call`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token2}`,
				},
				body: JSON.stringify({ id: "wire_tool", args: {} }),
			}).then((r) => r.json())) as { ok: boolean; output?: string };
			expect(okCall.ok).toBe(true);
			expect(okCall.output).toBe("wired-ok");
			await hooks2.dispose!();

			// Case C: wildcard permission (`wire_*`) also allows the call —
			// opencode matches permission keys as wildcards, not exact ids.
			const hooks3 = await plugin({
				directory: cwd,
				client: undefined,
				project: {},
				worktree: cwd,
				serverUrl: new URL("http://localhost:4096"),
				experimental_workspace: { register() {} },
			} as never);
			const config3 = {
				plugin: ["wire-plugin@latest"],
				permission: { "wire_*": "allow" },
				provider: {},
				mcp: {},
			} as never;
			await hooks3.config!(config3);
			const servers3 = (
				config3 as {
					provider: Record<string, { options?: Record<string, unknown> }>;
				}
			).provider["cursor"]!.options!["mcpServers"] as Record<
				string,
				{ env: Record<string, string> }
			>;
			const bridgeServer3 = servers3["opencode-plugin-tools"];
			expect(bridgeServer3).toBeDefined();
			const port3 = Number(bridgeServer3!.env["OPENCODE_PLUGIN_TOOLS_PORT"]);
			const token3 = bridgeServer3!.env["OPENCODE_PLUGIN_TOOLS_TOKEN"];
			const wildcardCall = (await fetch(`http://127.0.0.1:${port3}/call`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token3}`,
				},
				body: JSON.stringify({ id: "wire_tool", args: {} }),
			}).then((r) => r.json())) as { ok: boolean; output?: string };
			expect(wildcardCall.ok).toBe(true);
			expect(wildcardCall.output).toBe("wired-ok");
			await hooks3.dispose!();

			// Case D: pattern-scoped rule — allow for /tmp/*, ask otherwise.
			// The bridge must evaluate the REQUESTED patterns, not just the
			// permission key (opencode's Permission.ask semantics).
			const hooks4 = await plugin({
				directory: cwd,
				client: undefined,
				project: {},
				worktree: cwd,
				serverUrl: new URL("http://localhost:4096"),
				experimental_workspace: { register() {} },
			} as never);
			const config4 = {
				plugin: ["wire-plugin@latest"],
				permission: { wire_tool: { "*": "ask", "/tmp/*": "allow" } },
				provider: {},
				mcp: {},
			} as never;
			await hooks4.config!(config4);
			const servers4 = (
				config4 as {
					provider: Record<string, { options?: Record<string, unknown> }>;
				}
			).provider["cursor"]!.options!["mcpServers"] as Record<
				string,
				{ env: Record<string, string> }
			>;
			const bridgeServer4 = servers4["opencode-plugin-tools"];
			expect(bridgeServer4).toBeDefined();
			const port4 = Number(bridgeServer4!.env["OPENCODE_PLUGIN_TOOLS_PORT"]);
			const token4 = bridgeServer4!.env["OPENCODE_PLUGIN_TOOLS_TOKEN"];
			const call4 = (args: Record<string, unknown>) =>
				fetch(`http://127.0.0.1:${port4}/call`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${token4}`,
					},
					body: JSON.stringify({ id: "wire_tool", args }),
				}).then((r) => r.json()) as Promise<{
					ok: boolean;
					output?: string;
					error?: string;
				}>;
			// Matching pattern → allowed.
			const allowedCall = await call4({ file: "/tmp/ok.txt" });
			expect(allowedCall.ok).toBe(true);
			expect(allowedCall.output).toBe("wired-ok");
			// Non-matching pattern → ask → fail closed.
			const deniedCall = await call4({ file: "/etc/passwd" });
			expect(deniedCall.ok).toBe(false);
			expect(deniedCall.error).toMatch(/ask/);
			await hooks4.dispose!();
		} finally {
			process.env.HOME = prevHome;
			process.env.XDG_CONFIG_HOME = prevXdg;
			process.env.XDG_CACHE_HOME = prevCache;
		}
	});
});
