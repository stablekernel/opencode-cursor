import { describe, expect, it } from "vitest";
import type { Run, SDKUserMessage } from "@cursor/sdk";
import {
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
