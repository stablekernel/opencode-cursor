import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "@opencode-ai/plugin";
import { CursorPlugin as plugin } from "../src/plugin/index.js";

// Issue #152: "most of the models I have access to are missing". A key set only
// in `provider.cursor.options.apiKey` (README-documented) reached the provider
// for chat but never reached model discovery, so the picker showed the 4-model
// static fallback with no explanation.

const { list, toast, loaderWaits } = vi.hoisted(() => {
	const live = Array.from({ length: 10 }, (_, i) => ({ id: `live-model-${i}`, displayName: `Live ${i}` }));
	return {
		list: vi.fn(async (_opts?: { apiKey?: string }) => live),
		toast: vi.fn(async (_req: { body: { title: string; message: string; variant: string } }) => ({})),
		loaderWaits: [] as Array<() => void>,
	};
});

vi.mock("../src/cursor-runtime.js", () => ({
	loadCursorSdk: async () => ({ Cursor: { models: { list } } }),
}));
// TUI-ready delay resolves at once; the 10s loader wait resolves only when a
// test calls `loaderTimeout()`. (Executor form: ES2023 lib has no withResolvers.)
vi.mock("node:timers/promises", () => ({
	setTimeout: (ms: number) =>
		ms >= 10_000 ? new Promise<void>((resolve) => loaderWaits.push(resolve)) : Promise.resolve(),
}));

function loaderTimeout(): void {
	for (const release of loaderWaits.splice(0)) release();
}

const FALLBACK = ["claude-opus-4-8", "claude-sonnet-4-6", "composer-2.5", "gpt-5.5"];
const client = { tui: { showToast: toast }, app: { log: vi.fn(async () => ({})) } };

let savedEnv: string | undefined;
beforeEach(() => {
	savedEnv = process.env["CURSOR_API_KEY"];
	process.env["NO_UPDATE_NOTIFIER"] = "1"; // no version-check toast or network
	delete process.env["CURSOR_API_KEY"];
	process.env["XDG_CACHE_HOME"] = mkdtempSync(join(tmpdir(), "oc-cursor-152-")); // empty cache
	list.mockClear();
	toast.mockClear();
	loaderWaits.length = 0;
});
afterEach(() => {
	if (savedEnv === undefined) delete process.env["CURSOR_API_KEY"];
	else process.env["CURSOR_API_KEY"] = savedEnv;
});

async function configModels(config: Config): Promise<string[]> {
	const hooks = await plugin({} as never);
	await hooks.config!(config);
	return Object.keys(config.provider!.cursor!.models ?? {});
}

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("issue #152: discovery uses every configured key source", () => {
	it("CURSOR_API_KEY env var -> live catalog", async () => {
		process.env["CURSOR_API_KEY"] = "key_from_env";
		const models = await configModels({});
		expect(list).toHaveBeenCalledWith({ apiKey: "key_from_env" });
		expect(models).toHaveLength(10);
	});

	it("provider.cursor.options.apiKey -> live catalog", async () => {
		const models = await configModels({ provider: { cursor: { options: { apiKey: "key_from_config" } } } });
		expect(list).toHaveBeenCalledWith({ apiKey: "key_from_config" });
		expect(models).toHaveLength(10);
	});

	it("a $CURSOR_API_KEY placeholder or empty value is not treated as a key", async () => {
		const models = await configModels({ provider: { cursor: { options: { apiKey: "$CURSOR_API_KEY" } } } });
		expect(await configModels({ provider: { cursor: { options: { apiKey: "" } } } })).toHaveLength(4);
		expect(list).not.toHaveBeenCalled();
		expect(models.sort()).toEqual(FALLBACK);
	});

	it("provider.models route uses provider.options.apiKey", async () => {
		const hooks = await plugin({} as never);
		const route = hooks.provider!.models!;
		const map = await route({ options: { apiKey: "key_from_config" } } as never, { auth: undefined } as never);
		expect(list).toHaveBeenCalledWith({ apiKey: "key_from_config" });
		expect(Object.keys(map)).toHaveLength(10);
	});

	it("provider.models route uses provider.key", async () => {
		const hooks = await plugin({} as never);
		const map = await hooks.provider!.models!({ key: "key_on_provider", options: {} } as never, { auth: undefined } as never);
		expect(list).toHaveBeenCalledWith({ apiKey: "key_on_provider" });
		expect(Object.keys(map)).toHaveLength(10);
	});
});

describe("issue #152: fallback is explained, once", () => {
	it("no key anywhere -> one warning toast naming the cause", async () => {
		const hooks = await plugin({ client } as never);
		await hooks.config!({});
		await hooks.config!({});
		await settle();
		expect(toast).not.toHaveBeenCalled(); // still waiting for the auth loader
		loaderTimeout();
		await settle();
		expect(toast).toHaveBeenCalledTimes(1);
		const body = toast.mock.calls[0]![0].body;
		expect(body.variant).toBe("warning");
		expect(body.message).toContain("No Cursor API key found");
		expect(body.message).toContain("cursor_refresh_models");
	});

	it("loader found a key and loaded models -> info toast to restart", async () => {
		const hooks = await plugin({ client } as never);
		await hooks.config!({});
		await hooks.auth!.loader!(async () => ({ type: "api", key: "key_from_auth" }) as never, {} as never);
		await settle();
		expect(toast).toHaveBeenCalledTimes(1);
		const body = toast.mock.calls[0]![0].body;
		expect(body.variant).toBe("info");
		expect(body.message).toContain("Loaded 10 Cursor models");
	});

	it("invalid key, loader runs without a stored key -> warning with the discovery error, no wait", async () => {
		list.mockRejectedValueOnce(new Error("Invalid User API Key"));
		const hooks = await plugin({ client } as never);
		await hooks.config!({ provider: { cursor: { options: { apiKey: "bad_key" } } } });
		await hooks.auth!.loader!(async () => undefined as never, {} as never);
		await settle();
		expect(toast).toHaveBeenCalledTimes(1);
		expect(toast.mock.calls[0]![0].body.message).toContain("Invalid User API Key");
	});

	it("live catalog -> no toast", async () => {
		const hooks = await plugin({ client } as never);
		await hooks.config!({ provider: { cursor: { options: { apiKey: "key_from_config" } } } });
		await settle();
		expect(toast).not.toHaveBeenCalled();
	});
});
