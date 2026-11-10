import { describe, it, expect } from "vitest";
import { streamAgentTurn, type CursorEvent } from "../src/provider/agent-events.js";
import type { AgentLike, AgentRunLike, AgentSendOptions } from "../src/provider/agent-backend.js";

/**
 * Test that duplicate tool-call events (same ID) are filtered out.
 * This reproduces the scenario where the watchdog forces a resend and the SDK
 * replays tool-call-started events with the same callId.
 */
describe("duplicate tool call filtering", () => {
	it("deduplicates tool-call events with the same ID", async () => {
		let onDelta: ((event: { update: any }) => void) | undefined;

		const mockRun: AgentRunLike = {
			cancel: async () => {},
			wait: async () => {
				// Emit events before resolving
				if (onDelta) {
					// First tool call
					onDelta({
						update: {
							type: "tool-call-started",
							callId: "toolu_01RaUwXi2EGFB3VKvHrxM3zE",
							toolCall: { type: "shell", args: { command: "ls" } },
						},
					});
					// Duplicate tool call with same ID (e.g., after force resend)
					onDelta({
						update: {
							type: "tool-call-started",
							callId: "toolu_01RaUwXi2EGFB3VKvHrxM3zE",
							toolCall: { type: "shell", args: { command: "ls" } },
						},
					});
					// Tool result
					onDelta({
						update: {
							type: "tool-call-completed",
							callId: "toolu_01RaUwXi2EGFB3VKvHrxM3zE",
							toolCall: {
								type: "shell",
								result: { status: "success", value: { stdout: "file.txt" } },
							},
						},
					});
					// Turn ended
					onDelta({
						update: {
							type: "turn-ended",
							usage: {
								inputTokens: 100,
								outputTokens: 50,
								cacheReadTokens: 0,
								cacheWriteTokens: 0,
							},
						},
					});
				}
				return { status: "finished" as const, result: "done" };
			},
		};

		const mockAgent: AgentLike = {
			agentId: "test-agent",
			send: async (_message, options: AgentSendOptions) => {
				onDelta = options.onDelta;
				return mockRun;
			},
			close: async () => {},
		};

		const events: CursorEvent[] = [];
		const stream = streamAgentTurn(
			mockAgent,
			{ text: "run ls" },
			{ mode: "agent", idempotencyKey: "test" },
		);

		for await (const event of stream) {
			events.push(event);
		}

		// Should have exactly ONE tool-call event (duplicate filtered out)
		const toolCallEvents = events.filter((e) => e.type === "tool-call");
		expect(toolCallEvents).toHaveLength(1);
		expect(toolCallEvents[0]?.id).toBe("toolu_01RaUwXi2EGFB3VKvHrxM3zE");

		// Should still have the tool-result
		const toolResultEvents = events.filter((e) => e.type === "tool-result");
		expect(toolResultEvents).toHaveLength(1);
		expect(toolResultEvents[0]?.id).toBe("toolu_01RaUwXi2EGFB3VKvHrxM3zE");
	});

	it("allows different tool call IDs", async () => {
		let onDelta: ((event: { update: any }) => void) | undefined;

		const mockRun: AgentRunLike = {
			cancel: async () => {},
			wait: async () => {
				if (onDelta) {
					// First tool call
					onDelta({
						update: {
							type: "tool-call-started",
							callId: "toolu_01AAA",
							toolCall: { type: "shell", args: { command: "ls" } },
						},
					});
					// Second tool call with different ID
					onDelta({
						update: {
							type: "tool-call-started",
							callId: "toolu_01BBB",
							toolCall: { type: "read", args: { path: "file.txt" } },
						},
					});
					// Results
					onDelta({
						update: {
							type: "tool-call-completed",
							callId: "toolu_01AAA",
							toolCall: {
								type: "shell",
								result: { status: "success", value: { stdout: "file.txt" } },
							},
						},
					});
					onDelta({
						update: {
							type: "tool-call-completed",
							callId: "toolu_01BBB",
							toolCall: {
								type: "read",
								result: { status: "success", value: { content: "hello" } },
							},
						},
					});
					onDelta({
						update: {
							type: "turn-ended",
							usage: {
								inputTokens: 100,
								outputTokens: 50,
								cacheReadTokens: 0,
								cacheWriteTokens: 0,
							},
						},
					});
				}
				return { status: "finished" as const, result: "done" };
			},
		};

		const mockAgent: AgentLike = {
			agentId: "test-agent-2",
			send: async (_message, options: AgentSendOptions) => {
				onDelta = options.onDelta;
				return mockRun;
			},
			close: async () => {},
		};

		const events: CursorEvent[] = [];
		const stream = streamAgentTurn(
			mockAgent,
			{ text: "list and read" },
			{ mode: "agent", idempotencyKey: "test" },
		);

		for await (const event of stream) {
			events.push(event);
		}

		// Should have TWO distinct tool-call events
		const toolCallEvents = events.filter((e) => e.type === "tool-call");
		expect(toolCallEvents).toHaveLength(2);
		expect(toolCallEvents.map((e) => e.id)).toEqual(["toolu_01AAA", "toolu_01BBB"]);

		// Should have both tool-results
		const toolResultEvents = events.filter((e) => e.type === "tool-result");
		expect(toolResultEvents).toHaveLength(2);
	});

	it("deduplicates multiple duplicates of the same ID", async () => {
		let onDelta: ((event: { update: any }) => void) | undefined;

		const mockRun: AgentRunLike = {
			cancel: async () => {},
			wait: async () => {
				if (onDelta) {
					const callId = "toolu_01XYZ";
					// Emit the same tool call 3 times (simulating multiple force resends)
					for (let i = 0; i < 3; i++) {
						onDelta({
							update: {
								type: "tool-call-started",
								callId,
								toolCall: { type: "shell", args: { command: "echo test" } },
							},
						});
					}
					// Result
					onDelta({
						update: {
							type: "tool-call-completed",
							callId,
							toolCall: {
								type: "shell",
								result: { status: "success", value: { stdout: "test" } },
							},
						},
					});
					onDelta({
						update: {
							type: "turn-ended",
							usage: {
								inputTokens: 100,
								outputTokens: 50,
								cacheReadTokens: 0,
								cacheWriteTokens: 0,
							},
						},
					});
				}
				return { status: "finished" as const, result: "done" };
			},
		};

		const mockAgent: AgentLike = {
			agentId: "test-agent-3",
			send: async (_message, options: AgentSendOptions) => {
				onDelta = options.onDelta;
				return mockRun;
			},
			close: async () => {},
		};

		const events: CursorEvent[] = [];
		const stream = streamAgentTurn(
			mockAgent,
			{ text: "echo test" },
			{ mode: "agent", idempotencyKey: "test" },
		);

		for await (const event of stream) {
			events.push(event);
		}

		// Should have exactly ONE tool-call event (all duplicates filtered)
		const toolCallEvents = events.filter((e) => e.type === "tool-call");
		expect(toolCallEvents).toHaveLength(1);
		expect(toolCallEvents[0]?.id).toBe("toolu_01XYZ");

		// Should still have the tool-result
		const toolResultEvents = events.filter((e) => e.type === "tool-result");
		expect(toolResultEvents).toHaveLength(1);
	});
});
