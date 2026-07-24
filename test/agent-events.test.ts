import { describe, expect, it, vi } from "vitest";
import type { Run, SDKUserMessage } from "@cursor/sdk";
import {
	sendAgentTurnSilently,
	streamAgentTurn,
	type CursorEvent,
} from "../src/provider/agent-events.js";
import type { AgentLike } from "../src/provider/agent-backend.js";

const MESSAGE: SDKUserMessage = {
	type: "user",
	text: "hi",
} as unknown as SDKUserMessage;

type OnDelta = (input: {
	update: Record<string, unknown> & { type: string };
}) => void;

interface FakeRunResult {
	status: string;
	result?: string;
}

/** Build a fake agent (the {@link AgentLike} contract `streamAgentTurn`
 * consumes) whose send() drives onDelta and resolves wait(). */
function fakeAgent(opts: {
	updates?: Array<Record<string, unknown> & { type: string }>;
	result?: FakeRunResult;
	/** When set, reject the first N send() calls with this error. */
	rejectFirst?: { error: Error; times: number };
	sendCalls?: Array<Record<string, unknown> | undefined>;
}): AgentLike {
	let rejected = 0;
	return {
		agentId: "agent-test",
		send: async (
			_message: SDKUserMessage,
			sendOptions?: Record<string, unknown>,
		) => {
			opts.sendCalls?.push(sendOptions);
			if (opts.rejectFirst && rejected < opts.rejectFirst.times) {
				rejected++;
				throw opts.rejectFirst.error;
			}
			const onDelta = sendOptions?.["onDelta"] as OnDelta | undefined;
			for (const update of opts.updates ?? []) onDelta?.({ update });
			const run: Partial<Run> = {
				wait: async () =>
					(opts.result ?? { status: "finished", result: "" }) as never,
				cancel: async () => {},
			};
			return run as Run;
		},
	} as unknown as AgentLike;
}

async function collect(
	events: AsyncGenerator<CursorEvent>,
): Promise<CursorEvent[]> {
	const out: CursorEvent[] = [];
	for await (const e of events) out.push(e);
	return out;
}

describe("streamAgentTurn run terminal status", () => {
	it("throws when the run ends with status 'error' instead of finishing silently", async () => {
		const agent = fakeAgent({ result: { status: "error", result: "boom" } });
		await expect(
			collect(streamAgentTurn(agent, MESSAGE, { mode: "agent" })),
		).rejects.toThrow(/error/i);
	});

	it("completes without throwing when the run is cancelled", async () => {
		const agent = fakeAgent({ result: { status: "cancelled" } });
		const events = await collect(
			streamAgentTurn(agent, MESSAGE, { mode: "agent" }),
		);
		// No finish text is fabricated for a cancelled run.
		const finish = events.find((e) => e.type === "finish");
		expect(finish).toBeDefined();
		expect((finish as { text?: string }).text).toBeUndefined();
	});
});

describe("streamAgentTurn busy-agent recovery", () => {
	it("retries send with local.force when the agent reports AgentBusyError", async () => {
		const busy = new Error("agent busy");
		busy.name = "AgentBusyError";
		const sendCalls: Array<Record<string, unknown> | undefined> = [];
		const agent = fakeAgent({
			rejectFirst: { error: busy, times: 1 },
			updates: [{ type: "text-delta", text: "ok" }],
			result: { status: "finished", result: "ok" },
			sendCalls,
		});

		const events = await collect(
			streamAgentTurn(agent, MESSAGE, { mode: "agent" }),
		);

		expect(sendCalls).toHaveLength(2);
		expect(sendCalls[1]?.["local"]).toMatchObject({ force: true });
		expect(events).toContainEqual({ type: "text-delta", text: "ok" });
	});

	it("does not retry non-busy send failures", async () => {
		const nope = new Error("auth failed");
		const sendCalls: Array<Record<string, unknown> | undefined> = [];
		const agent = fakeAgent({
			rejectFirst: { error: nope, times: 99 },
			sendCalls,
		});

		await expect(
			collect(streamAgentTurn(agent, MESSAGE, { mode: "agent" })),
		).rejects.toThrow("auth failed");
		expect(sendCalls).toHaveLength(1);
	});
});

describe("silent-turn usage capture", () => {
	it("sendAgentTurnSilently captures turn-ended usage", async () => {
		const agent = fakeAgent({
			updates: [{ type: "turn-ended", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2 } }],
		});
		const usage = await sendAgentTurnSilently(agent, MESSAGE, { mode: "agent" });
		expect(usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2 });
	});

	it("streamAgentTurn adds usageBase to turn-ended usage", async () => {
		const agent = fakeAgent({
			updates: [{ type: "turn-ended", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
		});
		const events = await collect(streamAgentTurn(agent, MESSAGE, {
			mode: "agent",
			usageBase: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 3, cacheWriteTokens: 4 },
		}));
		const usage = events.find((e) => e.type === "usage");
		expect(usage).toEqual({
			type: "usage",
			usage: { inputTokens: 110, outputTokens: 55, cacheReadTokens: 3, cacheWriteTokens: 4 },
		});
	});
});

describe("sendAgentTurnSilently", () => {
	it("sends the message and awaits completion without returning text usage", async () => {
		const sendCalls: Array<Record<string, unknown> | undefined> = [];
		const agent = fakeAgent({
			updates: [{ type: "text-delta", text: "should-not-surface" }],
			result: { status: "finished", result: "done" },
			sendCalls,
		});

		// A turn with no turn-ended usage returns undefined; text deltas never
		// surface (the onDelta only captures usage).
		const usage = await sendAgentTurnSilently(agent, MESSAGE, { mode: "agent" });

		expect(sendCalls).toHaveLength(1);
		expect(usage).toBeUndefined();
	});

	it("throws when the run ends with status 'error'", async () => {
		const agent = fakeAgent({ result: { status: "error", result: "boom" } });
		await expect(
			sendAgentTurnSilently(agent, MESSAGE, { mode: "agent" }),
		).rejects.toThrow(/error/i);
	});

	it("throws when the run ends 'cancelled' without our abort (message never delivered)", async () => {
		// Cancellation we did NOT request (external cancel, CLI kill, …) means the
		// silent turn was not delivered; treating it as success would let the
		// caller keep a session record for a message the agent never received.
		const agent = fakeAgent({ result: { status: "cancelled" } });
		await expect(
			sendAgentTurnSilently(agent, MESSAGE, { mode: "agent" }),
		).rejects.toThrow(/cancelled/);
	});

	it("throws when the run ends with an unknown terminal status", async () => {
		const agent = fakeAgent({ result: { status: "expired" } });
		await expect(
			sendAgentTurnSilently(agent, MESSAGE, { mode: "agent" }),
		).rejects.toThrow(/expired/);
	});

	it("does not throw on 'cancelled' when our own abort signal caused it", async () => {
		const controller = new AbortController();
		controller.abort();
		// Already-aborted signal: returns early without sending at all.
		const sendCalls: Array<Record<string, unknown> | undefined> = [];
		const agent = fakeAgent({
			result: { status: "cancelled" },
			sendCalls,
		});
		await sendAgentTurnSilently(agent, MESSAGE, {
			mode: "agent",
			abortSignal: controller.signal,
		});
		expect(sendCalls).toHaveLength(0);
	});

	it("retries with local.force on AgentBusyError", async () => {
		const busy = new Error("agent busy");
		busy.name = "AgentBusyError";
		const sendCalls: Array<Record<string, unknown> | undefined> = [];
		const agent = fakeAgent({
			rejectFirst: { error: busy, times: 1 },
			result: { status: "finished", result: "" },
			sendCalls,
		});

		await sendAgentTurnSilently(agent, MESSAGE, { mode: "agent" });

		expect(sendCalls).toHaveLength(2);
		expect(sendCalls[1]?.["local"]).toMatchObject({ force: true });
	});

	it("cancels the run when the abort signal fires", async () => {
		let cancelled = false;
		const controller = new AbortController();
		const agent = {
			agentId: "agent-test",
			send: async (
				_message: SDKUserMessage,
				_sendOptions?: Record<string, unknown>,
			) => {
				const run: Partial<Run> = {
					wait: () =>
						new Promise((resolve) => {
							// Resolve only after abort triggers cancel().
							const check = setInterval(() => {
								if (cancelled) {
									clearInterval(check);
									resolve({ status: "cancelled" } as never);
								}
							}, 1);
						}),
					cancel: async () => {
						cancelled = true;
					},
				};
				return run as Run;
			},
		} as unknown as AgentLike;

		const promise = sendAgentTurnSilently(agent, MESSAGE, {
			mode: "agent",
			abortSignal: controller.signal,
		});
		controller.abort();
		await promise;
		expect(cancelled).toBe(true);
	});

	it("streamAgentTurn cancels the run when abort fires during the in-flight send", async () => {
		// Abort lands after send() is called but before runHolder.run is
		// populated (onAbort has nothing to cancel). The post-assignment guard
		// in startRun must still cancel the resolved run.
		let cancelled = false;
		const controller = new AbortController();
		let releaseSend: (() => void) | undefined;
		const agent = {
			agentId: "agent-inflight-abort",
			send: async (
				_message: SDKUserMessage,
				_sendOptions?: Record<string, unknown>,
			) => {
				// Hold send() in flight until the caller releases it (post-abort).
				await new Promise<void>((resolve) => {
					releaseSend = resolve;
				});
				const run: Partial<Run> = {
					wait: async () => ({ status: "cancelled" }) as never,
					cancel: async () => {
						cancelled = true;
					},
				};
				return run as Run;
			},
		} as unknown as AgentLike;

		const promise = collect(
			streamAgentTurn(agent, MESSAGE, {
				mode: "agent",
				abortSignal: controller.signal,
			}),
		);
		// Abort while send() is still in flight, then let send() resolve.
		await new Promise((r) => setTimeout(r, 5));
		controller.abort();
		releaseSend?.();
		await promise;
		expect(cancelled).toBe(true);
	});
});

describe("streamAgentTurn MCP error surfacing", () => {
	it("marks an MCP tool result as error when its success value carries isError", async () => {
		const agent = fakeAgent({
			updates: [
				{
					type: "tool-call-completed",
					callId: "c1",
					toolCall: {
						type: "mcp",
						args: { toolName: "find_symbol", providerIdentifier: "myserver" },
						result: {
							status: "success",
							value: { content: [], isError: true },
						},
					},
				},
			],
			result: { status: "finished", result: "" },
		});

		const events = await collect(
			streamAgentTurn(agent, MESSAGE, { mode: "agent" }),
		);
		const result = events.find((e) => e.type === "tool-result");
		expect(result).toMatchObject({ name: "myserver/find_symbol", isError: true });
	});
});

describe("streamAgentTurn idempotency key", () => {
	it("passes idempotencyKey through to agent.send", async () => {
		const sendCalls: Array<Record<string, unknown> | undefined> = [];
		const agent = fakeAgent({ sendCalls });
		await collect(streamAgentTurn(agent, MESSAGE, { mode: "agent", idempotencyKey: "k-1" }));
		expect(sendCalls[0]?.["idempotencyKey"]).toBe("k-1");
	});
});

describe("sendWithRecovery typed retries", () => {
	it("retries rate-limit with backoff on the same agent (no force)", async () => {
		vi.useFakeTimers();
		try {
			const sendCalls: Array<Record<string, unknown> | undefined> = [];
			const err = new Error("too many"); err.name = "RateLimitError";
			const agent = fakeAgent({ rejectFirst: { error: err, times: 2 }, sendCalls });
			const p = collect(streamAgentTurn(agent, MESSAGE, { mode: "agent" }));
			await vi.advanceTimersByTimeAsync(2_000);
			await p;
			expect(sendCalls).toHaveLength(3);
			expect(sendCalls.every((c) => c?.["local"] === undefined)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("retries network errors once then surfaces", async () => {
		vi.useFakeTimers();
		try {
			const sendCalls: Array<Record<string, unknown> | undefined> = [];
			const err = new Error("gone"); err.name = "NetworkError";
			const agent = fakeAgent({ rejectFirst: { error: err, times: 5 }, sendCalls });
			const p = collect(streamAgentTurn(agent, MESSAGE, { mode: "agent" }));
			const assertion = expect(p).rejects.toThrow("gone");
			await vi.advanceTimersByTimeAsync(5_000);
			await assertion;
			expect(sendCalls).toHaveLength(3); // initial + 2 bounded retries
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not retry auth errors", async () => {
		const sendCalls: Array<Record<string, unknown> | undefined> = [];
		const err = new Error("bad key"); err.name = "AuthenticationError";
		const agent = fakeAgent({ rejectFirst: { error: err, times: 5 }, sendCalls });
		await expect(collect(streamAgentTurn(agent, MESSAGE, { mode: "agent" }))).rejects.toThrow("bad key");
		expect(sendCalls).toHaveLength(1);
	});
});

describe("stream watchdog", () => {
	it("stall cancels and resends with local.force once", async () => {
		vi.useFakeTimers();
		try {
			process.env.OPENCODE_CURSOR_STALL_MS = "1000";
			const sendCalls: Array<Record<string, unknown> | undefined> = [];
			let sends = 0;
			const agent: AgentLike = {
				agentId: "agent-wd",
				send: async (_m: unknown, opts?: Record<string, unknown>) => {
					sends++;
					sendCalls.push(opts);
					if (sends === 1) {
						// Wedged: no deltas, wait() never settles until cancelled.
						let cancelled = false;
						return {
							wait: () => new Promise<{ status: string; result?: string }>((resolve) => {
								const t = setInterval(() => {
									if (cancelled) { clearInterval(t); resolve({ status: "cancelled" }); }
								}, 10);
							}),
							cancel: async () => { cancelled = true; },
						} as never;
					}
					const onDelta = opts?.["onDelta"] as ((a: { update: { type: string; text?: string } }) => void) | undefined;
					onDelta?.({ update: { type: "text-delta", text: "ok" } });
					return { wait: async () => ({ status: "finished", result: "ok" }), cancel: async () => {} } as never;
				},
				close: () => {},
			} as unknown as AgentLike;
			const p = collect(streamAgentTurn(agent, MESSAGE, { mode: "agent", idempotencyKey: "k-wd" }));
			await vi.advanceTimersByTimeAsync(1_500);
			const events = await p;
			expect(sendCalls).toHaveLength(2);
			expect(sendCalls[1]?.["local"]).toEqual({ force: true });
			expect(sendCalls[1]?.["idempotencyKey"]).toBe("k-wd");
			expect(events.some((e) => e.type === "finish")).toBe(true);
		} finally {
			delete process.env.OPENCODE_CURSOR_STALL_MS;
			vi.useRealTimers();
		}
	});

	it("abort during pre-first-event wait does not trigger a resend", async () => {
		vi.useFakeTimers();
		try {
			process.env.OPENCODE_CURSOR_STALL_MS = "1000";
			const sendCalls: Array<Record<string, unknown> | undefined> = [];
			const controller = new AbortController();
			const agent: AgentLike = {
				agentId: "agent-wd-abort",
				send: async (_m: unknown, opts?: Record<string, unknown>) => {
					sendCalls.push(opts);
					// Wedged pre-first-event: no deltas; wait() settles only on cancel.
					let cancelled = false;
					return {
						wait: () =>
							new Promise<{ status: string; result?: string }>((resolve) => {
								const t = setInterval(() => {
									if (cancelled) {
										clearInterval(t);
										resolve({ status: "cancelled" });
									}
								}, 10);
							}),
						cancel: async () => {
							cancelled = true;
						},
					} as never;
				},
				close: () => {},
			} as unknown as AgentLike;
			const p = collect(
				streamAgentTurn(agent, MESSAGE, { mode: "agent", abortSignal: controller.signal }),
			);
			// Let send() resolve so runHolder.run is populated, then abort before
			// the stall fires and let time pass well past stallMs.
			await vi.advanceTimersByTimeAsync(0);
			controller.abort();
			await vi.advanceTimersByTimeAsync(2_000);
			const events = await p;
			// No resend: the aborted turn's stall timer was cleared.
			expect(sendCalls).toHaveLength(1);
			// No spurious stall error surfaced; generator ended cleanly.
			expect(events.every((e) => e.type !== "text-delta")).toBe(true);
		} finally {
			delete process.env.OPENCODE_CURSOR_STALL_MS;
			vi.useRealTimers();
		}
	});

	it("mid-stream stall cancels the wedged run and surfaces an error (no resend)", async () => {
		vi.useFakeTimers();
		try {
			process.env.OPENCODE_CURSOR_STALL_MS = "1000";
			const sendCalls: Array<Record<string, unknown> | undefined> = [];
			let cancelCalls = 0;
			const agent: AgentLike = {
				agentId: "agent-wd-mid",
				send: async (_m: unknown, opts?: Record<string, unknown>) => {
					sendCalls.push(opts);
					// Emit one delta, then wedge: wait() settles only on cancel().
					const onDelta = opts?.["onDelta"] as
						| ((a: { update: { type: string; text?: string } }) => void)
						| undefined;
					onDelta?.({ update: { type: "text-delta", text: "partial" } });
					let cancelled = false;
					return {
						wait: () =>
							new Promise<{ status: string; result?: string }>((resolve) => {
								const t = setInterval(() => {
									if (cancelled) {
										clearInterval(t);
										resolve({ status: "cancelled" });
									}
								}, 10);
							}),
						cancel: async () => {
							cancelCalls++;
							cancelled = true;
						},
					} as never;
				},
				close: () => {},
			} as unknown as AgentLike;
			const p = collect(streamAgentTurn(agent, MESSAGE, { mode: "agent" }));
			const assertion = expect(p).rejects.toThrow(/stalled/i);
			await vi.advanceTimersByTimeAsync(2_000);
			await assertion;
			// Wedged run cancelled, not orphaned.
			expect(cancelCalls).toBeGreaterThanOrEqual(1);
			// No force-resend for a mid-stream stall.
			expect(sendCalls).toHaveLength(1);
		} finally {
			delete process.env.OPENCODE_CURSOR_STALL_MS;
			vi.useRealTimers();
		}
	});
});
