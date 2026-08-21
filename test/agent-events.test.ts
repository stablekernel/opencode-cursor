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

describe("streamAgentTurn nested subagent (tool-call-delta)", () => {
	it("normalizes nested text/tool updates into subagent-event", async () => {
		const agent = fakeAgent({
			updates: [
				{
					type: "tool-call-delta",
					callId: "task-1",
					modelCallId: "m1",
					taskUpdate: { type: "text-delta", text: "hello " },
				},
				{
					type: "tool-call-delta",
					callId: "task-1",
					modelCallId: "m1",
					taskUpdate: {
						type: "tool-call-started",
						callId: "sub-1",
						toolCall: { type: "shell", args: { command: "git status" } },
					},
				},
				{
					type: "tool-call-delta",
					callId: "task-1",
					modelCallId: "m1",
					taskUpdate: {
						type: "tool-call-completed",
						callId: "sub-1",
						modelCallId: "m1",
						toolCall: {
							type: "shell",
							args: { command: "git status" },
							result: { status: "success", value: { stdout: "clean" } },
						},
					},
				},
			],
			result: { status: "finished", result: "" },
		});

		const events = await collect(streamAgentTurn(agent, MESSAGE, { mode: "agent" }));
		const sub = events.filter((e) => e.type === "subagent-event");
		expect(sub).toHaveLength(3);
		expect(sub[0]).toMatchObject({ callId: "task-1", event: { type: "text", text: "hello " } });
		expect(sub[1]).toMatchObject({
			callId: "task-1",
			event: { type: "tool-start", name: "shell", id: "sub-1" },
		});
		expect(sub[2]).toMatchObject({
			callId: "task-1",
			event: { type: "tool-result", name: "shell", id: "sub-1", isError: false },
		});
	});

	it("normalizes nested thinking deltas and drops non-renderable updates", async () => {
		const agent = fakeAgent({
			updates: [
				{
					type: "tool-call-delta",
					callId: "task-1",
					modelCallId: "m1",
					taskUpdate: { type: "thinking-delta", text: "reasoning…" },
				},
				{
					type: "tool-call-delta",
					callId: "task-1",
					modelCallId: "m1",
					taskUpdate: { type: "step-started", stepId: 1 },
				},
			],
			result: { status: "finished", result: "" },
		});

		const events = await collect(streamAgentTurn(agent, MESSAGE, { mode: "agent" }));
		const sub = events.filter((e) => e.type === "subagent-event");
		expect(sub).toHaveLength(1);
		expect(sub[0]).toMatchObject({ event: { type: "reasoning", text: "reasoning…" } });
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

	/**
	 * Drive a turn against an agent whose run only settles on cancel, tracking
	 * the outcome without blocking so a test can assert "still pending" partway
	 * through. `emit` receives the SDK `onDelta` hook, so updates can be
	 * scheduled at t>0 with `setTimeout` under fake timers.
	 */
	function watchdogTurn(opts: {
		emit?: (onDelta: OnDelta) => void;
		abortSignal?: AbortSignal;
	}): { outcome: { state: "pending" | "stalled" | "done"; error?: unknown }; promise: Promise<void> } {
		const outcome: { state: "pending" | "stalled" | "done"; error?: unknown } = {
			state: "pending",
		};
		const agent: AgentLike = {
			agentId: "agent-wd-harness",
			send: async (_m: unknown, sendOptions?: Record<string, unknown>) => {
				const onDelta = sendOptions?.["onDelta"] as OnDelta | undefined;
				if (onDelta) opts.emit?.(onDelta);
				let cancelled = false;
				return {
					wait: () =>
						new Promise<FakeRunResult>((resolve) => {
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

		const promise = (async () => {
			try {
				for await (const _e of streamAgentTurn(agent, MESSAGE, {
					mode: "agent",
					...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
				})) {
					/* drain */
				}
				outcome.state = "done";
			} catch (err) {
				outcome.state = "stalled";
				outcome.error = err;
			}
		})();
		promise.catch(() => {});
		return { outcome, promise };
	}

	/** An update that opens a tool call under `callId`. */
	function toolStarted(callId: string, type = "shell") {
		return { update: { type: "tool-call-started", callId, toolCall: { type } } };
	}

	it("uses the larger tool budget while a tool call is in flight", async () => {
		vi.useFakeTimers();
		try {
			process.env.OPENCODE_CURSOR_STALL_MS = "1000";
			process.env.OPENCODE_CURSOR_TOOL_STALL_MS = "5000";
			const { outcome, promise } = watchdogTurn({
				emit: (onDelta) => onDelta(toolStarted("c1")),
			});
			// Well past the idle budget (1000). This assertion is what fails if
			// budget selection is reverted to always using `stallMs`.
			await vi.advanceTimersByTimeAsync(2_000);
			expect(outcome.state).toBe("pending");
			// Past the tool budget (5000): terminal, and it names the tool.
			await vi.advanceTimersByTimeAsync(3_500);
			await promise;
			expect(outcome.state).toBe("stalled");
			expect(String(outcome.error)).toMatch(/tool "shell" still in flight/);
		} finally {
			delete process.env.OPENCODE_CURSOR_STALL_MS;
			delete process.env.OPENCODE_CURSOR_TOOL_STALL_MS;
			vi.useRealTimers();
		}
	});

	it("negative control: with no tool open the idle budget governs", async () => {
		vi.useFakeTimers();
		try {
			process.env.OPENCODE_CURSOR_STALL_MS = "1000";
			process.env.OPENCODE_CURSOR_TOOL_STALL_MS = "5000";
			// A text-delta sets `anyEvent` so the stall is terminal rather than a
			// pre-first-event force-resend, but opens no tool.
			const { outcome, promise } = watchdogTurn({
				emit: (onDelta) => onDelta({ update: { type: "text-delta", text: "x" } }),
			});
			await vi.advanceTimersByTimeAsync(2_000);
			await promise;
			// Same 2000ms window that stayed pending above now stalls, proving the
			// larger budget is applied only while a tool is open.
			expect(outcome.state).toBe("stalled");
			expect(String(outcome.error)).not.toMatch(/in flight/);
		} finally {
			delete process.env.OPENCODE_CURSOR_STALL_MS;
			delete process.env.OPENCODE_CURSOR_TOOL_STALL_MS;
			vi.useRealTimers();
		}
	});

	it("restores the idle budget once the tool call completes", async () => {
		vi.useFakeTimers();
		try {
			process.env.OPENCODE_CURSOR_STALL_MS = "1000";
			process.env.OPENCODE_CURSOR_TOOL_STALL_MS = "5000";
			const { outcome, promise } = watchdogTurn({
				emit: (onDelta) => {
					onDelta(toolStarted("c1"));
					onDelta({
						update: {
							type: "tool-call-completed",
							callId: "c1",
							toolCall: { type: "shell", result: { status: "success" } },
						},
					});
				},
			});
			// Tool closed, so the idle budget (1000) applies again: stalls inside
			// the 2000ms window. Fails if `openTools.delete` is removed (the turn
			// would stay pending on the 5000ms tool budget).
			await vi.advanceTimersByTimeAsync(2_000);
			await promise;
			expect(outcome.state).toBe("stalled");
			expect(String(outcome.error)).not.toMatch(/in flight/);
		} finally {
			delete process.env.OPENCODE_CURSOR_STALL_MS;
			delete process.env.OPENCODE_CURSOR_TOOL_STALL_MS;
			vi.useRealTimers();
		}
	});

	it("clears open tool calls on turn-ended so a dropped completion can't pin the tool budget", async () => {
		vi.useFakeTimers();
		try {
			process.env.OPENCODE_CURSOR_STALL_MS = "1000";
			process.env.OPENCODE_CURSOR_TOOL_STALL_MS = "5000";
			const { outcome, promise } = watchdogTurn({
				emit: (onDelta) => {
					onDelta(toolStarted("c1"));
					// Note: no `tool-call-completed` — simulates a dropped or
					// differently-keyed completion.
					onDelta({ update: { type: "turn-ended" } });
				},
			});
			await vi.advanceTimersByTimeAsync(2_000);
			await promise;
			expect(outcome.state).toBe("stalled");
			expect(String(outcome.error)).not.toMatch(/in flight/);
		} finally {
			delete process.env.OPENCODE_CURSOR_STALL_MS;
			delete process.env.OPENCODE_CURSOR_TOOL_STALL_MS;
			vi.useRealTimers();
		}
	});

	it("re-arms on an unmapped update type (raw SDK activity counts as liveness)", async () => {
		vi.useFakeTimers();
		try {
			process.env.OPENCODE_CURSOR_STALL_MS = "1000";
			const { outcome, promise } = watchdogTurn({
				emit: (onDelta) => {
					// t=0: sets anyEvent, arms deadline t=1000.
					onDelta({ update: { type: "text-delta", text: "x" } });
					// t=800: a type the plugin does not map, so it never reaches
					// push(). With the raw re-arm it pushes the deadline to t=1800.
					setTimeout(() => onDelta({ update: { type: "some-future-type" } }), 800);
				},
			});
			// Past the original t=1000 deadline but inside the re-armed t=1800 one.
			// Fails if the post-switch armWatchdog() is removed.
			await vi.advanceTimersByTimeAsync(1_500);
			expect(outcome.state).toBe("pending");
			// Past the re-armed deadline.
			await vi.advanceTimersByTimeAsync(600);
			await promise;
			expect(outcome.state).toBe("stalled");
		} finally {
			delete process.env.OPENCODE_CURSOR_STALL_MS;
			vi.useRealTimers();
		}
	});

	it("negative control: without the intervening update the same schedule stalls", async () => {
		vi.useFakeTimers();
		try {
			process.env.OPENCODE_CURSOR_STALL_MS = "1000";
			const { outcome, promise } = watchdogTurn({
				emit: (onDelta) => onDelta({ update: { type: "text-delta", text: "x" } }),
			});
			// Identical timeline to the test above, minus the t=800 update: the
			// t=1000 deadline stands, so 1500ms is enough to stall. This proves the
			// preceding test's "pending" result is caused by the re-arm.
			await vi.advanceTimersByTimeAsync(1_500);
			await promise;
			expect(outcome.state).toBe("stalled");
		} finally {
			delete process.env.OPENCODE_CURSOR_STALL_MS;
			vi.useRealTimers();
		}
	});

	it("falls back to the default when STALL_MS is not a number", async () => {
		vi.useFakeTimers();
		try {
			// Number("abc") is NaN. NaN <= 0 is false, so the old code armed
			// setTimeout(fn, NaN), which fires immediately and stalled every turn.
			process.env.OPENCODE_CURSOR_STALL_MS = "abc";
			const ac = new AbortController();
			const { outcome, promise } = watchdogTurn({ abortSignal: ac.signal });
			await vi.advanceTimersByTimeAsync(500);
			expect(outcome.state).toBe("pending");
			ac.abort();
			await vi.advanceTimersByTimeAsync(50);
			await promise;
		} finally {
			delete process.env.OPENCODE_CURSOR_STALL_MS;
			vi.useRealTimers();
		}
	});

	it("negative control: a valid small STALL_MS does stall inside that window", async () => {
		vi.useFakeTimers();
		try {
			process.env.OPENCODE_CURSOR_STALL_MS = "50";
			const { outcome, promise } = watchdogTurn({});
			// Proves the harness can observe a stall at this timescale, so the
			// "pending" result above is the fallback and not an artifact.
			await vi.advanceTimersByTimeAsync(500);
			await promise;
			expect(outcome.state).toBe("stalled");
		} finally {
			delete process.env.OPENCODE_CURSOR_STALL_MS;
			vi.useRealTimers();
		}
	});

	it("treats an empty STALL_MS as fully disabled (historical escape hatch)", async () => {
		vi.useFakeTimers();
		try {
			process.env.OPENCODE_CURSOR_STALL_MS = "";
			const ac = new AbortController();
			// The text-delta sets `anyEvent`, so any stall would be TERMINAL rather
			// than a pre-first-event force-resend (which would leave the turn
			// "pending" and make this assertion vacuous).
			const { outcome, promise } = watchdogTurn({
				abortSignal: ac.signal,
				emit: (onDelta) => onDelta({ update: { type: "text-delta", text: "x" } }),
			});
			// Past the 120000 fallback: had empty fallen back to the default
			// instead of disabling, this would have stalled.
			await vi.advanceTimersByTimeAsync(130_000);
			expect(outcome.state).toBe("pending");
			ac.abort();
			await vi.advanceTimersByTimeAsync(50);
			await promise;
		} finally {
			delete process.env.OPENCODE_CURSOR_STALL_MS;
			vi.useRealTimers();
		}
	});

	it("applies the raised 120000 idle default when STALL_MS is unset", async () => {
		vi.useFakeTimers();
		try {
			delete process.env.OPENCODE_CURSOR_STALL_MS;
			const { outcome, promise } = watchdogTurn({
				emit: (onDelta) => onDelta({ update: { type: "text-delta", text: "x" } }),
			});
			// Past the old 60000 default, inside the new 120000 one.
			await vi.advanceTimersByTimeAsync(90_000);
			expect(outcome.state).toBe("pending");
			// Past the new default.
			await vi.advanceTimersByTimeAsync(35_000);
			await promise;
			expect(outcome.state).toBe("stalled");
		} finally {
			vi.useRealTimers();
		}
	});

	it("TOOL_STALL_MS=0 disables the bound during tool execution", async () => {
		vi.useFakeTimers();
		try {
			process.env.OPENCODE_CURSOR_STALL_MS = "1000";
			process.env.OPENCODE_CURSOR_TOOL_STALL_MS = "0";
			const ac = new AbortController();
			const { outcome, promise } = watchdogTurn({
				emit: (onDelta) => onDelta(toolStarted("c1")),
				abortSignal: ac.signal,
			});
			// Far past the idle budget with a tool open and the tool bound off.
			await vi.advanceTimersByTimeAsync(4_000);
			expect(outcome.state).toBe("pending");
			ac.abort();
			await vi.advanceTimersByTimeAsync(50);
			await promise;
		} finally {
			delete process.env.OPENCODE_CURSOR_STALL_MS;
			delete process.env.OPENCODE_CURSOR_TOOL_STALL_MS;
			vi.useRealTimers();
		}
	});

	it("caps an over-large TOOL_STALL_MS instead of overflowing to ~instant", async () => {
		vi.useFakeTimers();
		try {
			// A timer delay above 2^31-1 overflows and Node clamps it to 1ms, so
			// without the cap this budget stalls the turn almost immediately —
			// while reporting "no events for 999999999999ms". The stall message
			// tells operators to raise this very variable, so the trap is reachable
			// by following the plugin's own advice.
			process.env.OPENCODE_CURSOR_STALL_MS = "1000";
			process.env.OPENCODE_CURSOR_TOOL_STALL_MS = "999999999999";
			const ac = new AbortController();
			const { outcome, promise } = watchdogTurn({
				emit: (onDelta) => onDelta(toolStarted("c1")),
				abortSignal: ac.signal,
			});
			// Past the idle budget AND past the 600000 tool default, so the result
			// can be neither the idle budget nor a silent fall back to the default.
			// (It cannot be the fallback anyway — that needs a non-finite value —
			// but this rules it out observationally rather than by argument.)
			await vi.advanceTimersByTimeAsync(601_000);
			expect(outcome.state).toBe("pending");
			ac.abort();
			await vi.advanceTimersByTimeAsync(50);
			await promise;
		} finally {
			delete process.env.OPENCODE_CURSOR_STALL_MS;
			delete process.env.OPENCODE_CURSOR_TOOL_STALL_MS;
			vi.useRealTimers();
		}
	});

	it("negative control: a large tool budget still stalls once exceeded", async () => {
		vi.useFakeTimers();
		try {
			// Same timescale as the cap test, with a budget the harness can outrun.
			// Proves that test's "pending" reflects a deadline further out and not
			// a watchdog that stopped arming, and that a stall is observable here.
			process.env.OPENCODE_CURSOR_STALL_MS = "1000";
			process.env.OPENCODE_CURSOR_TOOL_STALL_MS = "600000";
			const { outcome, promise } = watchdogTurn({
				emit: (onDelta) => onDelta(toolStarted("c1")),
			});
			await vi.advanceTimersByTimeAsync(601_000);
			await promise;
			expect(outcome.state).toBe("stalled");
			expect(String(outcome.error)).toMatch(/tool "shell" still in flight/);
		} finally {
			delete process.env.OPENCODE_CURSOR_STALL_MS;
			delete process.env.OPENCODE_CURSOR_TOOL_STALL_MS;
			vi.useRealTimers();
		}
	});

	it("caps an over-large idle STALL_MS as well", async () => {
		vi.useFakeTimers();
		try {
			process.env.OPENCODE_CURSOR_STALL_MS = "1e30";
			const ac = new AbortController();
			const { outcome, promise } = watchdogTurn({ abortSignal: ac.signal });
			// Without the cap this is a 1ms deadline and every turn dies here.
			await vi.advanceTimersByTimeAsync(1_000);
			expect(outcome.state).toBe("pending");
			ac.abort();
			await vi.advanceTimersByTimeAsync(50);
			await promise;
		} finally {
			delete process.env.OPENCODE_CURSOR_STALL_MS;
			vi.useRealTimers();
		}
	});
});
