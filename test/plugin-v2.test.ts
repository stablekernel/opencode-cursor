import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep live model discovery offline for the whole file.
vi.mock("../src/model-discovery.js", () => ({
	discoverModels: vi.fn(async () => ({
		models: [
			{
				id: "test-model",
				displayName: "Test Model",
				parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }],
			},
			{
				id: "claude-haiku-4-5",
				displayName: "Claude Haiku 4.5",
				parameters: [],
			},
		],
		source: "fallback",
	})),
	toOpencodeModels: () => ({}),
	modelSupportsReasoning: () => false,
}));

import { defaultModelParams } from "../src/model-variants.js";
import { resolveCost } from "../src/model-limits.js";
import { discoverModels } from "../src/model-discovery.js";
import type {
	PluginContextV2,
	ToolContextV2,
	ToolResultV2,
} from "../src/plugin/v2.js";

// Dynamic import: vi.mock must hoist above these modules before
// src/plugin/v2.js evaluates, and vitest forbids static imports here.
const { cursorV2Setup, adaptToolResult } = await import("../src/plugin/v2.js");
const pluginModule = await import("../src/plugin/index.js");

type Registration = { dispose: Mock };

/** A mocked v2 registration-capturing function (transform/hook fake). */
type RegFn = (cb: unknown) => Registration;
type HookFn = (name: string, cb: unknown, options?: unknown) => Registration;


/**
 * Record every v2 ctx registration so tests can drive the captured
 * callbacks. The object-literal fake is cast `as never` like the v1 tests:
 * the real ctx is a large Effect service record no test can construct.
 */
function makeCtx(directory = "/work") {
	const registrations: Registration[] = [];
	const reg = (): Registration => {
		const r = { dispose: vi.fn() };
		registrations.push(r);
		return r;
	};
	const ctx = {
		registrations,
		location: { directory },
		options: {},
		integration: {
			transform: vi.fn((_cb: unknown) => reg()),
			connection: {
				active: vi.fn(async () => undefined),
				resolve: vi.fn(async () => undefined),
			},
		},
		provider: { transform: vi.fn((_cb: unknown) => reg()) },
		aisdk: { hook: vi.fn((_cb: unknown) => reg()) },
		session: { hook: vi.fn((_cb: unknown) => reg()) },
		tool: { transform: vi.fn((_cb: unknown) => reg()) },
		mcp: { transform: vi.fn((_cb: unknown) => reg()) },
	} as unknown as PluginContextV2 & {
		registrations: Registration[];
		integration: {
			transform: RegFn & Mock;
			connection: { active: Mock; resolve: Mock };
		};
		provider: { transform: RegFn & Mock };
		aisdk: { hook: HookFn & Mock };
		session: { hook: HookFn & Mock };
		tool: { transform: RegFn & Mock };
		mcp: { transform: RegFn & Mock };
	};
	return ctx;
}

// package.json version, for pin assertions (single source of truth).
const pkgVersion = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version as string;

let savedEnvKey: string | undefined;
let savedProviderNpm: string | undefined;

beforeEach(() => {
	savedEnvKey = process.env.CURSOR_API_KEY;
	delete process.env.CURSOR_API_KEY;
	savedProviderNpm = process.env.OPENCODE_CURSOR_PROVIDER_NPM;
	delete process.env.OPENCODE_CURSOR_PROVIDER_NPM;
});

afterEach(() => {
	if (savedEnvKey === undefined) delete process.env.CURSOR_API_KEY;
	else process.env.CURSOR_API_KEY = savedEnvKey;
	if (savedProviderNpm === undefined) delete process.env.OPENCODE_CURSOR_PROVIDER_NPM;
	else process.env.OPENCODE_CURSOR_PROVIDER_NPM = savedProviderNpm;
});

describe("dual default export", () => {
	it("exposes id, the v2 setup, and the v1 server entrypoint by identity", () => {
		const def = pluginModule.default as Record<string, unknown>;
		expect(def["id"]).toBe("opencode-cursor");
		expect(def["setup"]).toBe(cursorV2Setup);
		expect(def["server"]).toBe(pluginModule.CursorPlugin);
	});

	it("server still returns the full v1 hook set", async () => {
		const hooks = await pluginModule.CursorPlugin({
			directory: "/work",
		} as never);
		for (const key of [
			"auth",
			"config",
			"provider",
			"chat.params",
			"event",
			"tool",
			"dispose",
		]) {
			expect(hooks).toHaveProperty(key);
		}
		// v1 keeps all four tools.
		const tool = hooks.tool as Record<string, unknown>;
		expect(tool).toHaveProperty("cursor_refresh_models");
		expect(tool).toHaveProperty("cursor_update_plugin");
		expect(tool).toHaveProperty("cursor_delegate");
		expect(tool).toHaveProperty("cursor_cloud_agent");
	});
});

describe("cursorV2Setup", () => {
	it("registers integration auth methods (key + env fallback)", async () => {
		const ctx = makeCtx();
		await cursorV2Setup(ctx as never);
		const cb = ctx.integration.transform.mock.calls[0]![0] as (editor: {
			method: { update: (input: unknown) => void };
		}) => void;
		const methodUpdate = vi.fn();
		cb({ method: { update: methodUpdate } });
		expect(methodUpdate).toHaveBeenCalledTimes(2);
		const calls = methodUpdate.mock.calls.map((c) => c[0]);
		expect(calls).toEqual([
			{
				integrationID: "cursor",
				method: { type: "key", label: "Cursor API Key" },
			},
			{
				integrationID: "cursor",
				method: { type: "env", names: ["CURSOR_API_KEY"] },
			},
		]);
	});

	it("registers the cursor provider with aisdk-prefixed package, discovered models, and the session cwd as settings", async () => {
		const ctx = makeCtx();
		await cursorV2Setup(ctx as never);
		const cb = ctx.provider.transform.mock.calls[0]![0] as (editor: {
			add: (input: unknown) => void;
		}) => void;
		const add = vi.fn();
		cb({ add });
		expect(add).toHaveBeenCalledTimes(1);
		const { info, models } = add.mock.calls[0]![0] as {
			info: Record<string, unknown> & {
				settings?: Record<string, unknown>;
			};
			models: Array<Record<string, unknown> & { id: string; providerID: string }>;
		};
		expect(info["id"]).toBe("cursor");
		expect(info["name"]).toBe("Cursor");
		expect(String(info["package"])).toBe(
			`aisdk:@stablekernel/opencode-cursor@${pkgVersion}`,
		);
		expect(info["activation"]).toBe("auto");
		// The provider settings carry the session directory so the v2 runner
		// hands createCursor the right cwd (it may run from anywhere).
		expect(info.settings).toEqual({ cwd: "/work" });
		const model = models.find((m) => m.id === "test-model");
		expect(model).toBeDefined();
		expect(model?.providerID).toBe("cursor");
		// Every model carries the same pinned specifier (opencode loads the
		// provider package per model, so an unpinned one would resolve
		// `latest` and decouple the provider from this plugin's version).
		for (const m of models) {
			expect(m["package"]).toBe(
				`aisdk:@stablekernel/opencode-cursor@${pkgVersion}`,
			);
		}
	});

	it("honors OPENCODE_CURSOR_PROVIDER_NPM over the pinned spec", async () => {
		process.env.OPENCODE_CURSOR_PROVIDER_NPM =
			"file:///tmp/opencode-cursor-test-build";
		const ctx = makeCtx();
		await cursorV2Setup(ctx as never);
		const cb = ctx.provider.transform.mock.calls[0]![0] as (editor: {
			add: (input: unknown) => void;
		}) => void;
		const add = vi.fn();
		cb({ add });
		const { info, models } = add.mock.calls[0]![0] as {
			info: Record<string, unknown>;
			models: Array<Record<string, unknown>>;
		};
		expect(info["package"]).toBe("aisdk:file:///tmp/opencode-cursor-test-build");
		for (const m of models) {
			expect(m["package"]).toBe("aisdk:file:///tmp/opencode-cursor-test-build");
		}
	});

	it("emits defaultModelParams as the model's settings.params", async () => {
		const ctx = makeCtx();
		await cursorV2Setup(ctx as never);
		const cb = ctx.provider.transform.mock.calls[0]![0] as (editor: {
			add: (input: unknown) => void;
		}) => void;
		const add = vi.fn();
		cb({ add });
		const { models } = add.mock.calls[0]![0] as {
			models: Array<Record<string, unknown> & { id: string }>;
		};
		const model = models.find((m) => m.id === "test-model");
		expect(model).toBeDefined();
		// `fast` is a non-reasoning boolean param → pinned "false" by default.
		const settings = model?.["settings"] as { params?: Record<string, string> };
		expect(settings.params).toEqual(
			defaultModelParams({
				id: "test-model",
				displayName: "Test Model",
				parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }],
			}),
		);
		expect(settings.params).toEqual({ fast: "false" });
	});

	it("resolves real per-model cost through resolveCost (no $0 stub)", async () => {
		const ctx = makeCtx();
		await cursorV2Setup(ctx as never);
		const cb = ctx.provider.transform.mock.calls[0]![0] as (editor: {
			add: (input: unknown) => void;
		}) => void;
		const add = vi.fn();
		cb({ add });
		const { models } = add.mock.calls[0]![0] as {
			models: Array<Record<string, unknown> & { id: string; cost: unknown }>;
		};
		const haiku = models.find((m) => m.id === "claude-haiku-4-5");
		expect(haiku).toBeDefined();
		const c = resolveCost("claude-haiku-4-5");
		expect(haiku?.cost).toEqual([
			{ input: c.input, output: c.output, cache: { read: c.cacheRead, write: c.cacheWrite } },
		]);
		// A priced prefix must not report $0 (the old bug).
		expect((haiku?.cost as Array<{ input: number }>)[0]!.input).not.toBe(0);
	});

	it("seeds the catalog from the stored connection key, not env alone", async () => {
		const ctx = makeCtx();
		ctx.integration.connection.active.mockResolvedValue({
			type: "credential",
			id: "c1",
		});
		ctx.integration.connection.resolve.mockResolvedValue({
			type: "key",
			key: "stored-key",
		});
		await cursorV2Setup(ctx as never);
		expect(ctx.integration.connection.active).toHaveBeenCalledWith("cursor");
		expect(discoverModels).toHaveBeenCalledWith({ apiKey: "stored-key" });
	});

	it("falls back to env-only discovery when no stored connection resolves", async () => {
		const ctx = makeCtx();
		ctx.integration.connection.active.mockResolvedValue(undefined);
		await cursorV2Setup(ctx as never);
		expect(discoverModels).toHaveBeenCalledWith({ apiKey: undefined });
	});

	it("scopes the session context hook to providerID cursor and forwards sessionID/mode", async () => {
		const ctx = makeCtx();
		await cursorV2Setup(ctx as never);
		const session = ctx.session.hook;
		const contextCall = session.mock.calls.find((c) => c[0] === "context");
		expect(contextCall).toBeDefined();
		expect(contextCall![2]).toEqual({ providerID: "cursor" });
		const hook = contextCall![1] as (event: {
			sessionID: string;
			agent: string;
			options: Record<string, unknown>;
		}) => Promise<void>;

		const base = { sessionID: "s1", agent: "build", options: {} as Record<string, unknown> };
		await hook(base);
		expect(base.options.sessionID).toBe("s1");

		const plan = { sessionID: "s2", agent: "plan", options: {} as Record<string, unknown> };
		await hook(plan);
		expect(plan.options["mode"]).toBe("plan");

		const planPreset = {
			sessionID: "s3",
			agent: "plan",
			options: { mode: "agent" },
		};
		await hook(planPreset);
		expect(planPreset.options["mode"]).toBe("agent");
	});

	it("marks title requests ephemeral via the dedicated v2 title hook", async () => {
		const ctx = makeCtx();
		await cursorV2Setup(ctx as never);
		const session = ctx.session.hook;
		// v2 dispatches title generation through its own `title` hook
		// (SessionTitle extends SessionRequest and has no `agent` field), so
		// the context hook would never see a title request.
		const titleCall = session.mock.calls.find((c) => c[0] === "title");
		expect(titleCall).toBeDefined();
		expect(titleCall![2]).toEqual({ providerID: "cursor" });
		const titleHook = titleCall![1] as (event: {
			sessionID: string;
			options: Record<string, unknown>;
		}) => Promise<void>;
		const title = { sessionID: "s4", options: {} as Record<string, unknown> };
		await titleHook(title);
		expect(title.options["ephemeral"]).toBe(true);
		expect(title.options.sessionID).toBe("s4");
	});

	it("registers ONLY cursor_refresh_models (no update tool, no delegation tools)", async () => {
		const ctx = makeCtx();
		await cursorV2Setup(ctx as never);
		const cb = ctx.tool.transform.mock.calls[0]![0] as (editor: {
			add: (input: unknown) => void;
		}) => void;
		const add = vi.fn();
		cb({ add });
		const registered = add.mock.calls.map((c) => c[0]) as Array<{
			name: string;
			description: unknown;
			input: unknown;
			options?: { permission?: string };
			execute: unknown;
		}>;
		const names = registered.map((t) => t.name);
		expect(names).toEqual(["cursor_refresh_models"]);
		// Fail-closed delegation: absent on v2, not registered-and-ungated.
		expect(names).not.toContain("cursor_delegate");
		expect(names).not.toContain("cursor_cloud_agent");
		// v2 has `opencode plugin update`; the v1 cache-clearing tool is absent.
		expect(names).not.toContain("cursor_update_plugin");
		for (const t of registered) {
			expect(t.description).toBeTypeOf("string");
			// Tool.ValueSchema accepts StandardSchemaV1 (a zod v4 object carries
			// `~standard`); a raw zod *shape* (plain object) is not a schema.
			expect(t.input && typeof t.input === "object" && "~standard" in t.input).toBe(true);
			expect(typeof t.execute).toBe("function");
			// No fake permission gating on v2 (options.permission is not an
			// approval path in 2.0.19).
			expect(t.options).toBeUndefined();
		}
	});

	it("refresh tool description points at opencode plugin update, not the unregistered cursor_update_plugin", async () => {
		const ctx = makeCtx();
		await cursorV2Setup(ctx as never);
		const cb = ctx.tool.transform.mock.calls[0]![0] as (editor: {
			add: (input: unknown) => void;
		}) => void;
		const add = vi.fn();
		cb({ add });
		const { description } = add.mock.calls[0]![0] as {
			description: string;
		};
		// `cursor_update_plugin` is NOT registered on v2, so its description
		// must not send the model (or the user) there.
		expect(description).not.toContain("cursor_update_plugin");
		expect(description).toContain("opencode plugin update");
		// Same shared body as v1 otherwise.
		expect(description).toContain("Refresh the live Cursor model catalog");
	});

	it("refresh tool re-resolves the stored connection key on every call", async () => {
		const ctx = makeCtx();
		ctx.integration.connection.active.mockResolvedValue({
			type: "credential",
			id: "c1",
		});
		ctx.integration.connection.resolve.mockResolvedValue({
			type: "key",
			key: "stored-key",
		});
		await cursorV2Setup(ctx as never);
		const cb = ctx.tool.transform.mock.calls[0]![0] as (editor: {
			add: (input: unknown) => void;
		}) => void;
		const add = vi.fn();
		cb({ add });
		const refresh = add.mock.calls[0]![0] as {
			execute: (input: unknown, context: ToolContextV2) => Promise<ToolResultV2>;
		};

		await refresh.execute({}, { sessionID: "s1" });
		// The refresh ran discovery with the STORED key (the same path setup
		// uses), not keyless.
		expect(discoverModels).toHaveBeenCalledWith({
			apiKey: "stored-key",
			forceRefresh: true,
		});

		// A key saved mid-session is picked up without a restart: the
		// connection is re-read on every call.
		ctx.integration.connection.resolve.mockResolvedValue({
			type: "key",
			key: "rotated-key",
		});
		await refresh.execute({}, { sessionID: "s1" });
		expect(discoverModels).toHaveBeenLastCalledWith({
			apiKey: "rotated-key",
			forceRefresh: true,
		});
	});

	it("refresh tool executes from a v2 ToolContext and returns { content, metadata } (no output)", async () => {
		const ctx = makeCtx();
		await cursorV2Setup(ctx as never);
		const cb = ctx.tool.transform.mock.calls[0]![0] as (editor: {
			add: (input: unknown) => void;
		}) => void;
		const add = vi.fn();
		cb({ add });
		const refresh = add.mock.calls[0]![0] as {
			execute: (input: unknown, context: ToolContextV2) => Promise<ToolResultV2>;
		};
		// Exactly the v2 ToolContext surface: no ask, no abort/directory.
		const v2Context = {
			sessionID: "s1",
			signal: new AbortController().signal,
		};
		const result = await refresh.execute({}, v2Context);
		// The v2 Tool.Result for a tool without an output schema must use
		// `content`; `output` is rejected by the 2.0.19 runner.
		expect(result).toHaveProperty("content");
		expect(typeof result.content).toBe("string");
		expect(result.content).toContain("test-model — Test Model");
		expect(result.metadata).toEqual({ source: "fallback", count: 2 });
		expect("output" in (result as unknown as Record<string, unknown>)).toBe(false);
		// The refresh body ran the shared discovery helper (forceRefresh);
		// with no stored connection the key is undefined (keyless refresh).
		expect(discoverModels).toHaveBeenCalledWith({
			apiKey: undefined,
			forceRefresh: true,
		});
	});

	it("returned cleanup disposes every registration and removes the generated system rule", async () => {
		// Point the session directory at a temp dir with a generated rule, so
		// the cleanup's removeSystemRule call is observable.
		const dir = mkdtempSync(join(tmpdir(), "oc-v2-cleanup-"));
		const rulesDir = join(dir, ".cursor", "rules");
		const rulePath = join(rulesDir, "opencode.mdc");
		mkdirRecursive(rulesDir);
		writeGeneratedRule(rulePath);
		const ctx = makeCtx(dir);
		const cleanup = await cursorV2Setup(ctx as never);
		expect(typeof cleanup).toBe("function");
		// integration + provider + 2 session hooks (context, title) + tool.
		expect(ctx.registrations).toHaveLength(5);
		expect(existsSync(rulePath)).toBe(true);
		await cleanup?.();
		for (const r of ctx.registrations) {
			expect(r.dispose).toHaveBeenCalled();
		}
		expect(existsSync(rulePath)).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});

	it("leaves a user-owned opencode.mdc in place on cleanup", async () => {
		const dir = mkdtempSync(join(tmpdir(), "oc-v2-keep-"));
		const rulesDir = join(dir, ".cursor", "rules");
		const rulePath = join(rulesDir, "opencode.mdc");
		mkdirRecursive(rulesDir);
		writeFileSync(rulePath, "# my own rule\n", "utf8");
		const ctx = makeCtx(dir);
		const cleanup = await cursorV2Setup(ctx as never);
		await cleanup?.();
		expect(existsSync(rulePath)).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("adaptToolResult", () => {
	it("maps a plain string to content only", () => {
		expect(adaptToolResult("plain")).toEqual({ content: "plain" });
	});

	it("maps a v1 { output, metadata } object to { content, metadata }", () => {
		expect(
			adaptToolResult({ output: "done", metadata: { count: 1 } }),
		).toEqual({ content: "done", metadata: { count: 1 } });
	});

	it("drops the metadata key when absent", () => {
		expect(adaptToolResult({ output: "x" })).toEqual({ content: "x" });
		expect("metadata" in adaptToolResult({ output: "x" })).toBe(false);
	});
});

function mkdirRecursive(dir: string) {
	mkdirSync(dir, { recursive: true });
}

function writeGeneratedRule(path: string) {
	// Sentinel matching src/provider/system-rule.ts GENERATED_SENTINEL.
	writeFileSync(
		path,
		"---\ngenerated: opencode-cursor\ndescription: opencode session system prompt\nalwaysApply: true\n---\n\nprompt\n",
		"utf8",
	);
}
