import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/plugin/index.js";
import {
	clearSubagentBridge,
	linkSubagentSessionLive,
	registerSubagentCall,
	renderConversationSteps,
	setSubagentBridge,
	stampTaskPartSessionId,
	subagentCallChildId,
	unregisterSubagentCall,
} from "../src/provider/subagent-bridge.js";

describe("linkSubagentSessionLive tool parts", () => {
	afterEach(() => clearSubagentBridge());

	/** `session.prompt` with `noReply` returns the created USER message
	 *  (`session/prompt.ts:1069`), whose id owns the child's parts. */
	function bridge() {
		const request = vi.fn(async (_options: Record<string, unknown>): Promise<unknown> => ({}));
		const prompt = vi.fn(async () => ({ data: { info: { id: "msg_seed" }, parts: [] } }));
		const create = vi.fn(async () => ({ data: { id: "ses_child" } }));
		setSubagentBridge({
			client: { session: { create, prompt }, _client: { request } } as never,
			directory: "/w",
		});
		return { request };
	}

	it("captures the seeded message id and writes a tool part to it", async () => {
		const { request } = bridge();
		const live = await linkSubagentSessionLive({
			parentSessionID: "ses_parent",
			args: { description: "d", prompt: "do the thing" },
		});
		expect(live?.messageID).toBe("msg_seed");
		const partID = await live?.toolPart({
			callID: "c1",
			tool: "read",
			title: "a.ts",
			status: "running",
			start: 1,
		});
		expect(partID).toMatch(/^prt_/);
		expect(request).toHaveBeenCalledTimes(1);
		const body = request.mock.calls[0]![0]["body"] as Record<string, unknown>;
		expect(body["messageID"]).toBe("msg_seed");
		expect(body["tool"]).toBe("read");
	});

	it("reuses a caller-supplied part id so a call can be flipped to completed", async () => {
		const { request } = bridge();
		const live = await linkSubagentSessionLive({
			parentSessionID: "ses_parent",
			args: { description: "d", prompt: "p" },
		});
		const partID = await live?.toolPart({
			callID: "c1",
			tool: "bash",
			status: "running",
			start: 1,
		});
		await live?.toolPart({
			callID: "c1",
			tool: "bash",
			status: "completed",
			partID,
			start: 1,
			end: 2,
		});
		expect(request).toHaveBeenCalledTimes(2);
		const second = request.mock.calls[1]![0]["body"] as Record<string, unknown>;
		expect(second["id"]).toBe(partID);
		expect(second["state"]).toMatchObject({ status: "completed" });
	});

	it("stops writing tool parts once finalized", async () => {
		const { request } = bridge();
		const live = await linkSubagentSessionLive({
			parentSessionID: "ses_parent",
			args: { description: "d", prompt: "p" },
		});
		await live?.finalize();
		await expect(
			live?.toolPart({ callID: "c1", tool: "read", status: "running", start: 1 }),
		).resolves.toBeUndefined();
		expect(request).not.toHaveBeenCalled();
	});
});

/**
 * Cursor returns `conversationSteps` as raw protobuf-es `toJson()` output of
 * `agent.v1.ConversationStep`, whose `message` oneof serializes to a single
 * camelCase key — NOT the `{ type, message }` shape of the SDK's public zod
 * type. `agent.v1.ToolCall` nests the same way (`<tool>ToolCall` keys).
 */
describe("renderConversationSteps (proto oneof shape)", () => {
	it("renders assistant text from a oneof-keyed step", () => {
		const out = renderConversationSteps({
			conversationSteps: [{ assistantMessage: { text: "the answer is 42" } }],
		});
		expect(out).toBe("the answer is 42");
	});

	it("renders thinking text as a blockquote", () => {
		const out = renderConversationSteps({
			conversationSteps: [{ thinkingMessage: { text: "considering options", durationMs: 12 } }],
		});
		expect(out).toBe("> considering options");
	});

	it("renders a tool call, deriving the name from the oneof key", () => {
		const out = renderConversationSteps({
			conversationSteps: [
				{ toolCall: { shellToolCall: { args: { command: "ls -la" } } } },
			],
		});
		expect(out).toContain("shell");
		expect(out).toContain("ls -la");
	});

	it("renders every step of a mixed transcript in order", () => {
		const out = renderConversationSteps({
			conversationSteps: [
				{ thinkingMessage: { text: "plan" } },
				{ toolCall: { readToolCall: { args: { path: "a.ts" } } } },
				{ assistantMessage: { text: "done" } },
			],
		});
		const lines = (out ?? "").split("\n\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe("> plan");
		expect(lines[1]).toContain("read");
		expect(lines[2]).toBe("done");
	});

	it("renders a tool call's result alongside its args", () => {
		const out = renderConversationSteps({
			conversationSteps: [
				{
					toolCall: {
						shellToolCall: { args: { command: "git status" }, result: { stdout: "clean" } },
					},
				},
			],
		});
		expect(out).toContain("git status");
		expect(out).toContain("clean");
	});

	it("does not truncate long tool output", () => {
		const long = "x".repeat(5000);
		const out = renderConversationSteps({
			conversationSteps: [
				{ toolCall: { shellToolCall: { args: { command: "cat big" }, result: { stdout: long } } } },
			],
		});
		expect(out).toContain(long);
		expect(out).not.toContain("…");
	});

	it("does not truncate long assistant text", () => {
		const long = "y".repeat(5000);
		const out = renderConversationSteps({ conversationSteps: [{ assistantMessage: { text: long } }] });
		expect(out).toBe(long);
	});

	// protobuf-es represents a oneof on a live Message as `{ case, value }`.
	// The SDK only calls `toJson()` when it exists (`e.toJson?.() ?? e`), so
	// steps can reach us in this runtime form rather than as proto JSON.
	it("renders assistant text from the protobuf-es runtime oneof", () => {
		const out = renderConversationSteps({
			conversationSteps: [{ message: { case: "assistantMessage", value: { text: "hi there" } } }],
		});
		expect(out).toBe("hi there");
	});

	it("renders a tool call from the protobuf-es runtime oneof", () => {
		const out = renderConversationSteps({
			conversationSteps: [
				{
					message: {
						case: "toolCall",
						value: {
							tool: {
								case: "shellToolCall",
								value: { args: { command: "git diff" }, result: { stdout: "patched" } },
							},
						},
					},
				},
			],
		});
		expect(out).toContain("shell");
		expect(out).toContain("git diff");
		expect(out).toContain("patched");
	});

	// A silently-dropped step is what made two wrong shape guesses look
	// identical to "no output at all". Always render something.
	it("dumps an unrecognized step instead of dropping it", () => {
		const out = renderConversationSteps({
			conversationSteps: [{ somethingNew: { detail: "unmapped" } }],
		});
		expect(out).toContain("somethingNew");
		expect(out).toContain("unmapped");
	});

	it("still renders the SDK's public zod shape", () => {
		const out = renderConversationSteps({
			conversationSteps: [{ type: "assistantMessage", message: { text: "legacy" } }],
		});
		expect(out).toBe("legacy");
	});

	it("returns undefined when no step carries content", () => {
		expect(renderConversationSteps({ conversationSteps: [{}, { assistantMessage: {} }] })).toBeUndefined();
	});
});

afterEach(() => {
	clearSubagentBridge();
	unregisterSubagentCall("call-1");
});

describe("subagent call registry", () => {
	it("round-trips a call→child mapping", () => {
		registerSubagentCall("call-1", "ses_child");
		expect(subagentCallChildId("call-1")).toBe("ses_child");
		unregisterSubagentCall("call-1");
		expect(subagentCallChildId("call-1")).toBeUndefined();
	});

	it("returns undefined for unknown calls", () => {
		expect(subagentCallChildId("nope")).toBeUndefined();
	});
});

describe("stampTaskPartSessionId", () => {
	const runningPart = {
		id: "part-1",
		sessionID: "ses_parent",
		messageID: "msg-1",
		type: "tool",
		callID: "call-1",
		tool: "task",
		state: {
			status: "running",
			input: { description: "d" },
			title: "d",
			time: { start: 1 },
		},
	};

	it("PATCHes the running part with state.metadata.sessionId", async () => {
		const request = vi.fn(
			async (_opts: Record<string, unknown>) => ({ data: undefined, response: new Response() }),
		);
		setSubagentBridge({
			client: {
				_client: { request },
				session: {
					message: async () => ({
						data: { info: {}, parts: [runningPart] },
					}),
				},
			} as never,
			directory: "/repo",
		});
		await stampTaskPartSessionId({
			sessionID: "ses_parent",
			messageID: "msg-1",
			partID: "part-1",
			part: runningPart,
			childId: "ses_child",
		});
		expect(request).toHaveBeenCalledTimes(1);
		const opts = request.mock.calls[0]![0] as Record<string, unknown>;		expect(opts["method"]).toBe("PATCH");
		expect(opts["url"]).toBe("/session/{sessionID}/message/{messageID}/part/{partID}");
		expect(opts["path"]).toMatchObject({
			sessionID: "ses_parent",
			messageID: "msg-1",
			partID: "part-1",
		});
		expect(opts["query"]).toEqual({ directory: "/repo" });
		const body = opts["body"] as { state: { status: string; metadata?: Record<string, unknown> } };
		expect(body.state["status"]).toBe("running");
		expect(body.state["metadata"]).toMatchObject({ sessionId: "ses_child" });
	});

	it("skips non-running parts", async () => {
		const request = vi.fn();
		setSubagentBridge({
			client: { _client: { request } } as never,
			directory: "/repo",
		});
		await stampTaskPartSessionId({
			sessionID: "ses_parent",
			messageID: "msg-1",
			partID: "part-1",
			part: { ...runningPart, state: { status: "completed", input: {}, output: "x", title: "t", metadata: {}, time: { start: 1, end: 2 } } },
			childId: "ses_child",
		});
		expect(request).not.toHaveBeenCalled();
	});

	it("is a no-op when already stamped", async () => {
		const request = vi.fn();
		setSubagentBridge({
			client: { _client: { request } } as never,
			directory: "/repo",
		});
		await stampTaskPartSessionId({
			sessionID: "ses_parent",
			messageID: "msg-1",
			partID: "part-1",
			part: {
				...runningPart,
				state: { ...runningPart.state, metadata: { sessionId: "ses_child" } },
			},
			childId: "ses_child",
		});
		expect(request).not.toHaveBeenCalled();
	});

	it("is a no-op without a bridge or raw client", async () => {
		await stampTaskPartSessionId({
			sessionID: "ses_parent",
			messageID: "msg-1",
			partID: "part-1",
			part: runningPart,
			childId: "ses_child",
		});
		setSubagentBridge({
			client: {} as never,
			directory: "/repo",
		});
		await stampTaskPartSessionId({
			sessionID: "ses_parent",
			messageID: "msg-1",
			partID: "part-1",
			part: runningPart,
			childId: "ses_child",
		});
	});

	it("swallows PATCH failures", async () => {
		const request = vi.fn(async () => {
			throw new Error("boom");
		});
		setSubagentBridge({
			client: {
				_client: { request },
				session: {
					message: async () => ({
						data: { info: {}, parts: [runningPart] },
					}),
				},
			} as never,
			directory: "/repo",
		});
		await expect(
			stampTaskPartSessionId({
				sessionID: "ses_parent",
				messageID: "msg-1",
				partID: "part-1",
				part: runningPart,
				childId: "ses_child",
			}),
		).resolves.toBeUndefined();
	});

	it("skips the PATCH when the part is no longer running", async () => {
		const request = vi.fn();
		setSubagentBridge({
			client: {
				_client: { request },
				session: {
					message: async () => ({
						data: {
							info: {},
							parts: [
								{
									...runningPart,
									state: {
										status: "completed",
										input: {},
										output: "x",
										title: "t",
										metadata: {},
										time: { start: 1, end: 2 },
									},
								},
							],
						},
					}),
				},
			} as never,
			directory: "/repo",
		});
		await stampTaskPartSessionId({
			sessionID: "ses_parent",
			messageID: "msg-1",
			partID: "part-1",
			part: runningPart,
			childId: "ses_child",
		});
		expect(request).not.toHaveBeenCalled();
	});
});

describe("plugin event hook — running task stamp", () => {
	it("patches a registered running task part with the child session id", async () => {
		const request = vi.fn(
			async (_opts: Record<string, unknown>) => ({ data: undefined, response: new Response() }),
		);
		setSubagentBridge({
			client: {
				_client: { request },
				session: {
					message: async () => ({
						data: {
							info: {},
							parts: [
								{
									id: "part-1",
									sessionID: "ses_parent",
									messageID: "msg-1",
									type: "tool",
									callID: "call-1",
									tool: "task",
									state: {
										status: "running",
										input: { description: "d" },
										title: "d",
										time: { start: 1 },
									},
								},
							],
						},
					}),
				},
			} as never,
			directory: "/repo",
		});
		registerSubagentCall("call-1", "ses_child");
		const hooks = await plugin({} as never);
		await hooks.event!({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						id: "part-1",
						sessionID: "ses_parent",
						messageID: "msg-1",
						type: "tool",
						callID: "call-1",
						tool: "task",
						state: {
							status: "running",
							input: { description: "d" },
							title: "d",
							time: { start: 1 },
						},
					},
				},
			} as never,
		});
		expect(request).toHaveBeenCalledTimes(1);
		const opts = request.mock.calls[0]![0] as { body: { state: { metadata?: Record<string, unknown> } } };
		expect(opts.body.state["metadata"]).toMatchObject({ sessionId: "ses_child" });
	});

	it("ignores non-task parts and unregistered calls", async () => {
		const request = vi.fn();
		setSubagentBridge({
			client: { _client: { request } } as never,
			directory: "/repo",
		});
		const hooks = await plugin({} as never);
		await hooks.event!({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						id: "part-1",
						sessionID: "ses_parent",
						messageID: "msg-1",
						type: "tool",
						callID: "other",
						tool: "read",
						state: { status: "running", input: {}, title: "x", time: { start: 1 } },
					},
				},
			} as never,
		});
		await hooks.event!({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						id: "part-2",
						sessionID: "ses_parent",
						messageID: "msg-1",
						type: "tool",
						callID: "unregistered",
						tool: "task",
						state: { status: "running", input: {}, title: "x", time: { start: 1 } },
					},
				},
			} as never,
		});
		expect(request).not.toHaveBeenCalled();
	});
});
