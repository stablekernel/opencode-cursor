import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { Run, SDKUserMessage } from "@cursor/sdk";

// Sandbox the on-disk session store away from the user's real cache dir.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "cursor-lm-test-"));

const create = vi.fn();
const resume = vi.fn();

vi.mock("../src/cursor-runtime.js", () => ({
	loadCursorSdk: async () => ({ Agent: { create, resume } }),
}));

vi.mock("../src/api-key.js", () => ({
	resolveCursorApiKey: () => "test-key",
}));

const { CursorLanguageModel } = await import(
	"../src/provider/language-model.js"
);
const { clearAgentPool, getPooledAgentId } = await import(
	"../src/provider/session-pool.js"
);

type OnDelta = (input: {
	update: Record<string, unknown> & { type: string };
}) => void;

interface FakeAgentOpts {
	agentId: string;
	/** Updates to emit via onDelta before the run resolves. */
	updates?: Array<Record<string, unknown> & { type: string }>;
	/** Final run status + result. */
	result?: { status: string; result?: string };
	/** Captures the message passed to send() for assertions. */
	sentMessages?: SDKUserMessage[];
}

/** Build a fake AgentLike whose send() drives onDelta and resolves wait(). */
function fakeAgent(opts: FakeAgentOpts) {
	return {
		agentId: opts.agentId,
		send: async (
			message: SDKUserMessage,
			sendOptions?: Record<string, unknown>,
		) => {
			opts.sentMessages?.push(message);
			const onDelta = sendOptions?.["onDelta"] as OnDelta | undefined;
			for (const update of opts.updates ?? []) onDelta?.({ update });
			const run: Partial<Run> = {
				wait: async () =>
					(opts.result ?? { status: "finished", result: "ok" }) as never,
				cancel: async () => {},
			};
			return run as Run;
		},
		close: vi.fn(),
	} as unknown as import("../src/provider/agent-backend.js").AgentLike;
}

const sys = (text: string) => ({ role: "system" as const, content: text });
const user = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
});

function makeModel() {
	return new CursorLanguageModel("m", {
		providerName: "cursor",
		cwd: "/tmp",
		mode: "agent",
		session: "auto",
	});
}

async function streamCall(
	model: ReturnType<typeof makeModel>,
	opts: Parameters<ReturnType<typeof makeModel>["doStream"]>[0],
): Promise<ReadableStream<LanguageModelV3StreamPart>> {
	const r = await model.doStream(opts);
	return r.stream;
}

async function collectStream(
	stream:
		| ReadableStream<LanguageModelV3StreamPart>
		| Promise<ReadableStream<LanguageModelV3StreamPart>>,
): Promise<LanguageModelV3StreamPart[]> {
	const reader = (await stream).getReader();
	const out: LanguageModelV3StreamPart[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		out.push(value);
	}
	return out;
}

const eventTypes = (parts: LanguageModelV3StreamPart[]) =>
	parts.map((p) => p.type);

beforeEach(() => {
	create.mockReset();
	resume.mockReset();
	clearAgentPool();
});

afterEach(() => {
	clearAgentPool();
});

describe("CursorLanguageModel doStream — resume-aware retry", () => {
	it("forwards a per-turn sandbox override to Cursor agent creation", async () => {
		const model = makeModel();
		create.mockResolvedValueOnce(fakeAgent({ agentId: "sandboxed" }));

		await collectStream(
			streamCall(model, {
				prompt: [sys("S"), user("run")],
				providerOptions: { cursor: { sessionID: "sandbox-session", sandbox: true } },
			} as never),
		);

		expect(create.mock.calls[0]![0]).toMatchObject({
			local: { sandboxOptions: { enabled: true } },
		});
	});

	it("forwards a per-turn cwd override to Cursor agent creation", async () => {
		const model = makeModel();
		create.mockResolvedValueOnce(fakeAgent({ agentId: "scoped" }));

		await collectStream(
			streamCall(model, {
				prompt: [sys("S"), user("run")],
				providerOptions: { cursor: { sessionID: "cwd-session", cwd: "/child/dir" } },
			} as never),
		);

		expect(create.mock.calls[0]![0]).toMatchObject({
			local: { cwd: "/child/dir" },
		});
	});

	it("re-creates a fresh agent + full transcript when a resumed turn errors before emitting", async () => {
		const model = makeModel();
		const firstSent: SDKUserMessage[] = [];
		const retrySent: SDKUserMessage[] = [];

		// Turn 1: fresh create, pools under the session.
		create.mockResolvedValueOnce(
			fakeAgent({ agentId: "a1", sentMessages: firstSent }),
		);
		await collectStream(
			streamCall(model, {
				prompt: [sys("S"), user("hi")],
				providerOptions: { cursor: { sessionID: "s1" } },
			} as never),
		);
		expect(getPooledAgentId("s1")).toBe("a1");

		// Turn 2: resume → run ends "error" with no deltas. Retry → fresh create succeeds.
		resume.mockResolvedValueOnce(
			fakeAgent({
				agentId: "a1",
				result: { status: "error", result: "agent expired" },
			}),
		);
		create.mockResolvedValueOnce(
			fakeAgent({ agentId: "a2", sentMessages: retrySent }),
		);

		const parts = await collectStream(
			streamCall(model, {
				prompt: [sys("S"), user("hi"), user("there")],
				providerOptions: { cursor: { sessionID: "s1" } },
			} as never),
		);

		// Retry produced a finish, not an error.
		expect(eventTypes(parts)).not.toContain("error");
		expect(eventTypes(parts)).toContain("finish");

		// Resume attempted once; create called twice (turn 1 + retry).
		expect(resume).toHaveBeenCalledOnce();
		expect(create).toHaveBeenCalledTimes(2);

		// Pool re-pointed to the fresh agent.
		expect(getPooledAgentId("s1")).toBe("a2");

		// Resumed turn sent only the latest message; retry sent the full transcript.
		expect(firstSent[0]?.text).toContain("hi");
		expect(retrySent[0]?.text).toContain("# User\nhi");
		expect(retrySent[0]?.text).toContain("there");
	});

	it("does not retry when a resumed turn errors after already yielding events", async () => {
		const model = makeModel();

		// Turn 1: pool a1.
		create.mockResolvedValueOnce(fakeAgent({ agentId: "a1" }));
		await collectStream(
			streamCall(model, {
				prompt: [sys("S"), user("hi")],
				providerOptions: { cursor: { sessionID: "s1" } },
			} as never),
		);

		// Turn 2: resume emits a text delta, THEN errors.
		resume.mockResolvedValueOnce(
			fakeAgent({
				agentId: "a1",
				updates: [{ type: "text-delta", text: "partial" }],
				result: { status: "error", result: "expired" },
			}),
		);

		const parts = await collectStream(
			streamCall(model, {
				prompt: [sys("S"), user("hi"), user("there")],
				providerOptions: { cursor: { sessionID: "s1" } },
			} as never),
		);

		// Error propagates; no retry (create not called again).
		expect(eventTypes(parts)).toContain("error");
		expect(create).toHaveBeenCalledOnce(); // turn 1 only
		expect(resume).toHaveBeenCalledOnce();
	});

	it("does not retry a fresh-create turn that errors (resumed === false)", async () => {
		const model = makeModel();
		create.mockResolvedValueOnce(
			fakeAgent({ agentId: "a1", result: { status: "error", result: "boom" } }),
		);

		const parts = await collectStream(
			streamCall(model, {
				prompt: [sys("S"), user("hi")],
				providerOptions: { cursor: { sessionID: "s1" } },
			} as never),
		);

		expect(eventTypes(parts)).toContain("error");
		expect(create).toHaveBeenCalledOnce();
		expect(resume).not.toHaveBeenCalled();
	});

	it("does not retry when the abort signal is already fired", async () => {
		const model = makeModel();

		// Turn 1: pool a1.
		create.mockResolvedValueOnce(fakeAgent({ agentId: "a1" }));
		await collectStream(
			streamCall(model, {
				prompt: [sys("S"), user("hi")],
				providerOptions: { cursor: { sessionID: "s1" } },
			} as never),
		);

		// Turn 2: resume errors, but the user already aborted.
		resume.mockResolvedValueOnce(
			fakeAgent({
				agentId: "a1",
				result: { status: "error", result: "expired" },
			}),
		);
		const ac = new AbortController();
		ac.abort();

		const parts = await collectStream(
			streamCall(model, {
				prompt: [sys("S"), user("hi"), user("there")],
				providerOptions: { cursor: { sessionID: "s1" } },
				abortSignal: ac.signal,
			} as never),
		);

		// No retry; error propagates.
		expect(eventTypes(parts)).toContain("error");
		expect(create).toHaveBeenCalledOnce(); // turn 1 only
		expect(resume).toHaveBeenCalledOnce();
	});

	it("propagates the error when the retry itself also fails", async () => {
		const model = makeModel();

		// Turn 1: pool a1.
		create.mockResolvedValueOnce(fakeAgent({ agentId: "a1" }));
		await collectStream(
			streamCall(model, {
				prompt: [sys("S"), user("hi")],
				providerOptions: { cursor: { sessionID: "s1" } },
			} as never),
		);

		// Turn 2: resume errors (no emit), retry create also errors.
		resume.mockResolvedValueOnce(
			fakeAgent({
				agentId: "a1",
				result: { status: "error", result: "expired" },
			}),
		);
		create.mockResolvedValueOnce(
			fakeAgent({ agentId: "a2", result: { status: "error", result: "boom" } }),
		);

		const parts = await collectStream(
			streamCall(model, {
				prompt: [sys("S"), user("hi"), user("there")],
				providerOptions: { cursor: { sessionID: "s1" } },
			} as never),
		);

		expect(eventTypes(parts)).toContain("error");
		expect(resume).toHaveBeenCalledOnce();
		expect(create).toHaveBeenCalledTimes(2);
	});

	it("retries a non-pooled explicit-agentId resume, closing both agents and pooling neither", async () => {
		const model = makeModel();

		// Explicit agentId: usePool is false, so the turn resumes without pooling.
		const original = fakeAgent({
			agentId: "explicit",
			result: { status: "error", result: "expired" },
		}) as unknown as { close: ReturnType<typeof vi.fn> };
		const fresh = fakeAgent({ agentId: "fresh" }) as unknown as {
			close: ReturnType<typeof vi.fn>;
		};
		resume.mockResolvedValueOnce(original);
		create.mockResolvedValueOnce(fresh);

		const parts = await collectStream(
			streamCall(model, {
				prompt: [sys("S"), user("hi")],
				providerOptions: { cursor: { sessionID: "s1", agentId: "explicit" } },
			} as never),
		);

		// Retry succeeded: a finish, no error.
		expect(eventTypes(parts)).not.toContain("error");
		expect(eventTypes(parts)).toContain("finish");
		expect(resume).toHaveBeenCalledWith("explicit", expect.anything());
		expect(create).toHaveBeenCalledOnce();

		// Non-pooled: both agents closed on release; nothing pooled under the session.
		expect(original.close).toHaveBeenCalled();
		expect(fresh.close).toHaveBeenCalled();
		expect(getPooledAgentId("s1")).toBeUndefined();
	});

	it("applies per-model default params (fast:false) when a turn arrives with no params", async () => {
		// Simulates an opencode subagent that inherited its parent's model: the
		// provider gets the bare model id with no per-request params. The
		// modelParamDefaults floor must still pin fast:false so Cursor's
		// server-side fast:true default never applies.
		const model = new CursorLanguageModel("composer-2.5", {
			providerName: "cursor",
			cwd: "/tmp",
			mode: "agent",
			session: "auto",
			modelParamDefaults: { "composer-2.5": { fast: "false" } },
		});
		create.mockResolvedValueOnce(fakeAgent({ agentId: "a1" }));

		await collectStream(
			streamCall(model, {
				prompt: [sys("S"), user("hi")],
				providerOptions: { cursor: { sessionID: "s1" } },
			} as never),
		);

		const acquireArgs = create.mock.calls[0]?.[0] as {
			model: { id: string; params?: Array<{ id: string; value: string }> };
		};
		expect(acquireArgs.model).toEqual({
			id: "composer-2.5",
			params: [{ id: "fast", value: "false" }],
		});
	});

	it("chains the original resume failure as cause when re-acquire throws", async () => {
		const model = makeModel();

		// Turn 1: pool a1.
		create.mockResolvedValueOnce(fakeAgent({ agentId: "a1" }));
		await collectStream(
			streamCall(model, {
				prompt: [sys("S"), user("hi")],
				providerOptions: { cursor: { sessionID: "s1" } },
			} as never),
		);

		// Turn 2: resume errors (no emit); the retry's acquireAgent itself rejects.
		resume.mockResolvedValueOnce(
			fakeAgent({
				agentId: "a1",
				result: { status: "error", result: "expired" },
			}),
		);
		create.mockRejectedValueOnce(new Error("create failed"));

		const parts = await collectStream(
			streamCall(model, {
				prompt: [sys("S"), user("hi"), user("there")],
				providerOptions: { cursor: { sessionID: "s1" } },
			} as never),
		);

		const errPart = parts.find((p) => p.type === "error") as
			| { type: "error"; error: unknown }
			| undefined;
		expect(errPart).toBeDefined();
		const error = errPart?.error as Error;
		expect(error.message).toBe("create failed");
		// Original resume failure preserved as the cause for diagnosability.
		expect((error.cause as Error)?.message).toContain("error");
	});
});
