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
/** Advance exactly `n` poll intervals (OPENCODE_CURSOR_KEY_POLL_MS=5). */
const ticks = (n: number) => vi.advanceTimersByTimeAsync(5 * n);

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

	it("retries a key that fell back only every 5th check", async () => {
		const h = makeCtx();
		await setup(h);
		const badCalls = () => discover.mock.calls.filter(([o]) => o.apiKey === "bad-key").length;
		h.storeKey("bad-key");
		await ticks(1);
		expect(badCalls()).toBe(1);
		await ticks(4);
		expect(badCalls()).toBe(1);
		await ticks(1);
		expect(badCalls()).toBe(2);
		// The backoff restarts after each retry, not just the first.
		await ticks(4);
		expect(badCalls()).toBe(2);
		await ticks(1);
		expect(badCalls()).toBe(3);
		expect(h.provider.reload).not.toHaveBeenCalled();
		// A different key is tried on the next check, not after the backoff.
		h.storeKey("good-key");
		await ticks(1);
		expect(h.provider.reload).toHaveBeenCalledTimes(1);
	});

	it("does not reload after teardown during discovery", async () => {
		const h = makeCtx();
		const dispose = await setup(h);
		let finishDiscovery!: () => void;
		discover.mockImplementationOnce(
			() => new Promise((resolve) => (finishDiscovery = () => resolve(LIVE))),
		);
		h.storeKey("good-key");
		await ticks(1);
		expect(discover).toHaveBeenLastCalledWith({ apiKey: "good-key" });
		await dispose();
		finishDiscovery();
		await ticks(1);
		expect(h.provider.reload).not.toHaveBeenCalled();
	});

	it("keeps polling when reload throws, and retries it", async () => {
		const h = makeCtx();
		await setup(h);
		h.provider.reload!.mockRejectedValueOnce(new Error("catalog busy"));
		h.storeKey("good-key");
		await ticks(1);
		expect(h.provider.reload).toHaveBeenCalledTimes(1);
		await ticks(5);
		expect(h.provider.reload).toHaveBeenCalledTimes(2);
		// Success stops the watch.
		const calls = discover.mock.calls.length;
		await ticks(10);
		expect(discover.mock.calls.length).toBe(calls);
	});

	it("recovers a good key whose first discovery failed transiently", async () => {
		discover.mockImplementationOnce(async () => FALLBACK); // setup, no key
		discover.mockImplementationOnce(async () => FALLBACK); // good key, network blip
		const h = makeCtx();
		await setup(h);
		h.storeKey("good-key");
		await ticks(1);
		expect(h.provider.reload).not.toHaveBeenCalled();
		await ticks(5);
		expect(h.provider.reload).toHaveBeenCalledTimes(1);
		expect(h.currentModelNames()).toEqual(["Composer 2.5", "GPT-5.5"]);
	});

	it("disposes a registration that finishes after teardown (no-reload host)", async () => {
		const h = makeCtx({ reload: false });
		const dispose = await setup(h);
		const first = (await h.provider.transform.mock.results[0]!.value) as { dispose: Mock };
		const late = { dispose: vi.fn(async () => undefined) };
		let finishRegistration!: () => void;
		h.provider.transform.mockImplementationOnce(
			() => new Promise((resolve) => (finishRegistration = () => resolve(late))),
		);
		h.storeKey("good-key");
		await ticks(1);
		expect(h.provider.transform).toHaveBeenCalledTimes(2);
		await dispose();
		finishRegistration();
		await ticks(1);
		expect(late.dispose).toHaveBeenCalledTimes(1);
		expect(first.dispose).toHaveBeenCalledTimes(1);
	});

	it("treats an invalid OPENCODE_CURSOR_KEY_POLL_MS as the 15s default", async () => {
		process.env.OPENCODE_CURSOR_KEY_POLL_MS = "abc";
		const h = makeCtx();
		await setup(h);
		h.storeKey("good-key");
		await vi.advanceTimersByTimeAsync(14_999);
		expect(h.provider.reload).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
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
