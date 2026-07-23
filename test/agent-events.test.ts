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

describe("sendAgentTurnSilently", () => {
	it("sends the message with no onDelta and awaits completion", async () => {
		const sendCalls: Array<Record<string, unknown> | undefined> = [];
		const agent = fakeAgent({
			updates: [{ type: "text-delta", text: "should-not-surface" }],
			result: { status: "finished", result: "done" },
			sendCalls,
		});

		await sendAgentTurnSilently(agent, MESSAGE, { mode: "agent" });

		expect(sendCalls).toHaveLength(1);
		expect(sendCalls[0]?.["onDelta"]).toBeUndefined();
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
