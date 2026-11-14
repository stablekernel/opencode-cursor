import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// G-013: after a keyless/fallback setup, a key stored later (opencode auth
// login against a running v2 service) must refresh the Cursor model list
// without an `opencode reload`.
vi.mock("../src/model-discovery.js", () => ({
	discoverModels: vi.fn(),
	toOpencodeModels: () => ({}),
	modelSupportsReasoning: () => false,
}));

import { discoverModels } from "../src/model-discovery.js";
import type { PluginContextV2 } from "../src/plugin/v2.js";

const { cursorV2Setup, FALLBACK_NAME_HINT } = await import("../src/plugin/v2.js");

const discover = discoverModels as unknown as Mock;

const FALLBACK = {
	models: [{ id: "composer-2.5", displayName: "Composer 2.5", parameters: [] }],
	source: "fallback" as const,
};
const LIVE = {
	models: [
		{ id: "composer-2.5", displayName: "Composer 2.5", parameters: [] },
		{ id: "gpt-5.5", displayName: "GPT-5.5", parameters: [] },
	],
	source: "live" as const,
};

type ProviderCallback = (editor: { add: (input: { models: Array<{ id: string; name: string }> }) => void }) => void;

function makeCtx(options: { reload?: boolean } = {}) {
	let key: string | undefined;
	const registrations: Array<{ dispose: Mock }> = [];
	const reg = () => {
		const r = { dispose: vi.fn(async () => undefined) };
		registrations.push(r);
		return r;
	};
	const provider: { transform: Mock; reload?: Mock } = { transform: vi.fn(async () => reg()) };
	if (options.reload !== false) provider.reload = vi.fn(async () => undefined);
	const ctx = {
		location: { directory: "/work" },
		options: {},
		integration: {
			transform: vi.fn(async () => reg()),
			connection: {
				active: vi.fn(async () => (key ? { type: "credential", id: "c1" } : undefined)),
				resolve: vi.fn(async () => (key ? { type: "key", key } : undefined)),
			},
		},
		provider,
		session: { hook: vi.fn(async () => reg()) },
		tool: { transform: vi.fn(async () => reg()) },
	};
	return {
		ctx: ctx as unknown as PluginContextV2,
		provider,
		registrations,
		storeKey: (value: string) => {
			key = value;
		},
		/** Model names the latest provider registration lists right now. */
		currentModelNames: () => {
			const calls = provider.transform.mock.calls;
			const callback = calls[calls.length - 1]![0] as ProviderCallback;
			let names: string[] = [];
			callback({ add: (input) => (names = input.models.map((m) => m.name)) });
			return names;
		},
	};
}

// Fake timers: advancing also flushes the async discovery chain each tick.
const advance = () => vi.advanceTimersByTimeAsync(30);

let savedPoll: string | undefined;
let savedEnvKey: string | undefined;
const disposers: Array<() => Promise<void>> = [];

beforeEach(() => {
	vi.useFakeTimers();
	savedPoll = process.env.OPENCODE_CURSOR_KEY_POLL_MS;
	savedEnvKey = process.env.CURSOR_API_KEY;
	process.env.OPENCODE_CURSOR_KEY_POLL_MS = "5";
	delete process.env.CURSOR_API_KEY;
	discover.mockReset();
	discover.mockImplementation(async (opts: { apiKey?: string }) =>
		opts.apiKey === "good-key" ? LIVE : FALLBACK,
	);
});

afterEach(async () => {
	for (const dispose of disposers.splice(0)) await dispose();
	vi.useRealTimers();
	if (savedPoll === undefined) delete process.env.OPENCODE_CURSOR_KEY_POLL_MS;
	else process.env.OPENCODE_CURSOR_KEY_POLL_MS = savedPoll;
	if (savedEnvKey === undefined) delete process.env.CURSOR_API_KEY;
	else process.env.CURSOR_API_KEY = savedEnvKey;
});

async function setup(h: ReturnType<typeof makeCtx>) {
	const dispose = await cursorV2Setup(h.ctx);
	disposers.push(dispose);
	return dispose;
}

describe("v2 live model refresh (G-013)", () => {
	it("marks fallback model names with a login hint", async () => {
		const h = makeCtx();
		await setup(h);
		expect(h.currentModelNames()).toEqual([`Composer 2.5${FALLBACK_NAME_HINT}`]);
	});

	it("re-discovers and reloads when a key is stored after setup", async () => {
		const h = makeCtx();
		await setup(h);
		h.storeKey("good-key");
		await advance();
		expect(h.provider.reload).toHaveBeenCalledTimes(1);
		expect(discover).toHaveBeenLastCalledWith({ apiKey: "good-key" });
		expect(h.currentModelNames()).toEqual(["Composer 2.5", "GPT-5.5"]);
		// Watch stops after success: no further discovery.
		const calls = discover.mock.calls.length;
		await advance();
		expect(discover.mock.calls.length).toBe(calls);
	});

	it("re-registers the provider when the host has no reload", async () => {
		const h = makeCtx({ reload: false });
		const dispose = await setup(h);
		const first = h.provider.transform.mock.results[0]!.value as Promise<{ dispose: Mock }>;
		h.storeKey("good-key");
		await advance();
		expect(h.provider.transform).toHaveBeenCalledTimes(2);
		expect((await first).dispose).toHaveBeenCalled();
		expect(h.currentModelNames()).toEqual(["Composer 2.5", "GPT-5.5"]);
		// The new registration is the one setup's dispose cleans up.
		const second = (await h.provider.transform.mock.results[1]!.value) as { dispose: Mock };
		await dispose();
		expect(second.dispose).toHaveBeenCalled();
	});

	it("keeps the fallback for a bad key and tries it only once", async () => {
		const h = makeCtx();
		await setup(h);
		h.storeKey("bad-key");
		await advance();
		expect(discover).toHaveBeenCalledWith({ apiKey: "bad-key" });
		await advance();
		expect(discover.mock.calls.filter(([o]) => o.apiKey === "bad-key")).toHaveLength(1);
		expect(h.provider.reload).not.toHaveBeenCalled();
		// A later good key still gets picked up.
		h.storeKey("good-key");
		await advance();
		expect(h.provider.reload).toHaveBeenCalledTimes(1);
	});

	it("does not poll when setup already had a working key", async () => {
		const h = makeCtx();
		h.storeKey("good-key");
		await setup(h);
		await advance();
		expect(discover).toHaveBeenCalledTimes(1);
		expect(h.currentModelNames()).toEqual(["Composer 2.5", "GPT-5.5"]);
	});

	it("stops polling on dispose", async () => {
		const h = makeCtx();
		const dispose = await setup(h);
		await dispose();
		h.storeKey("good-key");
		await advance();
		expect(discover).toHaveBeenCalledTimes(1);
	});

	it("is disabled by OPENCODE_CURSOR_KEY_POLL_MS=0", async () => {
		process.env.OPENCODE_CURSOR_KEY_POLL_MS = "0";
		const h = makeCtx();
		await setup(h);
		h.storeKey("good-key");
		await advance();
		expect(discover).toHaveBeenCalledTimes(1);
		expect(h.provider.reload).not.toHaveBeenCalled();
	});
});
