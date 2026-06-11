import { describe, expect, it } from "vitest";
import type { Config } from "@opencode-ai/plugin";
import {
	findUnshareableOAuthServers,
	translateMcpServers,
} from "../src/plugin/mcp-config.js";
import plugin from "../src/plugin/index.js";

describe("translateMcpServers", () => {
	it("maps a local (stdio) server, splitting command/args and keeping env", () => {
		const mcp: Config["mcp"] = {
			myserver: {
				type: "local",
				command: [
					"uvx",
					"--from",
					"git+https://example.com/org/myserver",
					"myserver",
					"start-mcp-server",
				],
				environment: { FOO: "bar" },
			},
		};
		expect(translateMcpServers(mcp)).toEqual({
			myserver: {
				type: "stdio",
				command: "uvx",
				args: [
					"--from",
					"git+https://example.com/org/myserver",
					"myserver",
					"start-mcp-server",
				],
				env: { FOO: "bar" },
			},
		});
	});

	it("maps a remote server to http with headers", () => {
		const mcp: Config["mcp"] = {
			ctx: {
				type: "remote",
				url: "https://mcp.example.com",
				headers: { Authorization: "Bearer x" },
			},
		};
		expect(translateMcpServers(mcp)).toEqual({
			ctx: {
				type: "http",
				url: "https://mcp.example.com",
				headers: { Authorization: "Bearer x" },
			},
		});
	});

	it("skips disabled servers and ones missing a command/url", () => {
		const mcp: Config["mcp"] = {
			off: { type: "local", command: ["x"], enabled: false },
			empty: { type: "local", command: [] },
			noUrl: { type: "remote", url: "" },
			ok: { type: "local", command: ["node", "server.js"] },
		};
		expect(translateMcpServers(mcp)).toEqual({
			ok: { type: "stdio", command: "node", args: ["server.js"] },
		});
	});

	it("returns an empty map for undefined", () => {
		expect(translateMcpServers(undefined)).toEqual({});
	});
});

describe("findUnshareableOAuthServers", () => {
	it("flags OAuth remotes with no clientId, not ones with a clientId", () => {
		const mcp: Config["mcp"] = {
			dynamic: { type: "remote", url: "https://dyn", oauth: {} },
			configured: {
				type: "remote",
				url: "https://cfg",
				oauth: { clientId: "cid" },
			},
			plain: { type: "remote", url: "https://plain" },
			local: { type: "local", command: ["node"] },
		};
		expect(findUnshareableOAuthServers(mcp)).toEqual(["dynamic"]);
	});

	it("flags needs_auth servers with no usable clientId from the live status", () => {
		const mcp: Config["mcp"] = {
			needsauth: { type: "remote", url: "https://na" },
			connected: { type: "remote", url: "https://ok" },
		};
		const status = {
			needsauth: { status: "needs_auth" },
			connected: { status: "connected" },
		};
		expect(findUnshareableOAuthServers(mcp, status)).toEqual(["needsauth"]);
	});

	it("maps a remote server's OAuth clientId to Cursor's auth block", () => {
		const mcp: Config["mcp"] = {
			notion: {
				type: "remote",
				url: "https://notion",
				oauth: { clientId: "cid", clientSecret: "sec", scope: "read write" },
			},
		};
		expect(translateMcpServers(mcp)).toEqual({
			notion: {
				type: "http",
				url: "https://notion",
				auth: {
					CLIENT_ID: "cid",
					CLIENT_SECRET: "sec",
					scopes: ["read", "write"],
				},
			},
		});
	});

	it("skips a remote OAuth server with no shareable clientId (dynamic registration)", () => {
		const mcp: Config["mcp"] = {
			notion: { type: "remote", url: "https://notion", oauth: {} },
			plain: { type: "remote", url: "https://plain" },
		};
		expect(translateMcpServers(mcp)).toEqual({
			plain: { type: "http", url: "https://plain" },
		});
	});

	it("treats oauth:false as a plain http server", () => {
		const mcp: Config["mcp"] = {
			plain: { type: "remote", url: "https://plain", oauth: false },
		};
		expect(translateMcpServers(mcp)).toEqual({
			plain: { type: "http", url: "https://plain" },
		});
	});

	it("with a live status map, forwards only connected servers (ignoring `enabled`)", () => {
		const mcp: Config["mcp"] = {
			// enabled:false in config, but opencode connected it mid-session
			live: { type: "local", command: ["node", "s.js"], enabled: false },
			// enabled in config, but disconnected mid-session
			gone: { type: "local", command: ["node", "g.js"] },
			// failed to connect -> not forwarded
			broken: { type: "remote", url: "https://broken" },
		};
		const status = {
			live: { status: "connected" },
			gone: { status: "disabled" },
			broken: { status: "failed" },
		};
		expect(translateMcpServers(mcp, status)).toEqual({
			live: { type: "stdio", command: "node", args: ["s.js"] },
		});
	});
});

describe("plugin config hook MCP forwarding", () => {
	it("forwards opencode's configured MCP servers into provider.cursor.options", async () => {
		const hooks = await plugin({} as never);
		const config: Config = {
			mcp: { myserver: { type: "local", command: ["uvx", "myserver"] } },
		};
		await hooks.config!(config);
		const opts = config.provider!.cursor!.options as Record<string, unknown>;
		expect(opts.mcpServers).toEqual({
			myserver: { type: "stdio", command: "uvx", args: ["myserver"] },
		});
	});

	it("respects forwardMcp:false opt-out", async () => {
		const hooks = await plugin({} as never);
		const config: Config = {
			mcp: { myserver: { type: "local", command: ["uvx", "myserver"] } },
			provider: { cursor: { options: { forwardMcp: false } } },
		};
		await hooks.config!(config);
		const opts = config.provider!.cursor!.options as Record<string, unknown>;
		expect(opts.mcpServers).toBeUndefined();
	});
});

describe("chat.params dynamic MCP re-forwarding", () => {
	// A mock opencode client returning live config + MCP status.
	function fakeClient(
		mcp: Config["mcp"],
		status: Record<string, { status: string }>,
	) {
		const toasts: Array<{ message: string; variant: string }> = [];
		return {
			toasts,
			config: { get: async () => ({ data: { mcp } }) },
			mcp: { status: async () => ({ data: status }) },
			tui: {
				showToast: async (opts: {
					body: { message: string; variant: string };
				}) => {
					toasts.push(opts.body);
					return { data: true };
				},
			},
		};
	}

	const chatInput = (over: Record<string, unknown> = {}) => ({
		sessionID: "s1",
		agent: "build",
		model: { providerID: "cursor", modelID: "m" },
		...over,
	});

	it("injects the live (connected-only) MCP set into output.options", async () => {
		const client = fakeClient(
			{
				serena: { type: "local", command: ["serena", "start"] },
				notion: { type: "remote", url: "https://notion", enabled: false },
			},
			{ serena: { status: "connected" }, notion: { status: "connected" } },
		);
		const hooks = await plugin({ client } as never);
		// config hook must run first to capture forwardMcp/userMcp + provider opts.
		await hooks.config!({ mcp: {} } as Config);

		const output: Record<string, unknown> = { options: {} };
		await hooks["chat.params"]!(chatInput() as never, output as never);
		const opts = output.options as Record<string, unknown>;
		expect(opts.sessionID).toBe("s1");
		expect(opts.mcpServers).toEqual({
			serena: { type: "stdio", command: "serena", args: ["start"] },
			notion: { type: "http", url: "https://notion" },
		});
	});

	it("drops servers opencode disconnected mid-session", async () => {
		const client = fakeClient(
			{
				serena: { type: "local", command: ["serena"] },
				notion: { type: "remote", url: "https://notion" },
			},
			{ serena: { status: "connected" }, notion: { status: "disabled" } },
		);
		const hooks = await plugin({ client } as never);
		await hooks.config!({ mcp: {} } as Config);

		const output: Record<string, unknown> = { options: {} };
		await hooks["chat.params"]!(chatInput() as never, output as never);
		const opts = output.options as Record<string, unknown>;
		expect(opts.mcpServers).toEqual({
			serena: { type: "stdio", command: "serena" },
		});
	});

	it("does not re-forward for non-cursor models", async () => {
		const client = fakeClient(
			{ serena: { type: "local", command: ["serena"] } },
			{ serena: { status: "connected" } },
		);
		const hooks = await plugin({ client } as never);
		await hooks.config!({ mcp: {} } as Config);

		const output: Record<string, unknown> = { options: {} };
		await hooks["chat.params"]!(
			chatInput({ model: { providerID: "anthropic", modelID: "x" } }) as never,
			output as never,
		);
		expect(
			(output.options as Record<string, unknown>).mcpServers,
		).toBeUndefined();
	});

	it("skips re-forwarding when forwardMcp is false", async () => {
		const client = fakeClient(
			{ serena: { type: "local", command: ["serena"] } },
			{ serena: { status: "connected" } },
		);
		const hooks = await plugin({ client } as never);
		await hooks.config!({
			mcp: {},
			provider: { cursor: { options: { forwardMcp: false } } },
		} as Config);

		const output: Record<string, unknown> = { options: {} };
		await hooks["chat.params"]!(chatInput() as never, output as never);
		expect(
			(output.options as Record<string, unknown>).mcpServers,
		).toBeUndefined();
	});

	it("forwards an OAuth server with a clientId (as auth) and skips one without", async () => {
		const client = fakeClient(
			{
				configured: {
					type: "remote",
					url: "https://cfg",
					oauth: { clientId: "cid" },
				},
				dynamic: { type: "remote", url: "https://dyn", oauth: {} },
			},
			{ configured: { status: "connected" }, dynamic: { status: "connected" } },
		);
		const hooks = await plugin({ client } as never);
		await hooks.config!({ mcp: {} } as Config);

		const output: Record<string, unknown> = { options: {} };
		await hooks["chat.params"]!(chatInput() as never, output as never);
		expect((output.options as Record<string, unknown>).mcpServers).toEqual({
			configured: {
				type: "http",
				url: "https://cfg",
				auth: { CLIENT_ID: "cid" },
			},
		});
		expect(client.toasts).toHaveLength(1);
		expect(client.toasts[0]!.variant).toBe("warning");
		expect(client.toasts[0]!.message).toContain("dynamic");
	});

	it("warns about an OAuth server only once across turns", async () => {
		const client = fakeClient(
			{ dynamic: { type: "remote", url: "https://dyn", oauth: {} } },
			{ dynamic: { status: "connected" } },
		);
		const hooks = await plugin({ client } as never);
		await hooks.config!({ mcp: {} } as Config);

		const output: Record<string, unknown> = { options: {} };
		await hooks["chat.params"]!(chatInput() as never, output as never);
		await hooks["chat.params"]!(chatInput() as never, output as never);
		expect(client.toasts).toHaveLength(1);
	});
});
