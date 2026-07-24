import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";

// Sandbox the on-disk session store away from the user's real cache dir.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "cursor-lm-test-"));

/**
 * A fake Cursor agent. Records every send() so tests can assert how many turns
 * were replayed and in what order. Each send drives its onDelta (if any) with a
 * single text delta echoing the sent text, then resolves wait().
 */
interface SentTurn {
	text: string;
	streamed: boolean;
}

function makeFakeAgent(
	agentId: string,
	sent: SentTurn[],
	opts?: { failOnText?: string; usage?: Record<string, number> },
) {
	return {
		agentId,
		close: vi.fn(),
		send: async (
			message: { text: string },
			sendOptions?: Record<string, unknown>,
		) => {
			const onDelta = sendOptions?.["onDelta"] as
				| ((a: { update: { type: string } & Record<string, unknown> }) => void)
				| undefined;
			// Both silent and streamed turns now receive an onDelta (silent uses it
			// only to capture turn-ended usage). The streamed turn is the one whose
			// text reaches the visible output stream; the silent onDelta discards
			// text-delta. So `streamed` here just records that a callback was wired,
			// and the caller asserts which text actually surfaces via the drained
			// stream (see the streamedTexts helper below).
			sent.push({ text: message.text, streamed: Boolean(onDelta) });
			const failed = opts?.failOnText === message.text;
			onDelta?.({ update: { type: "text-delta", text: message.text } });
			if (opts?.usage) onDelta?.({ update: { type: "turn-ended", usage: opts.usage } });
			return {
				id: "run",
				wait: async () =>
					failed
						? { status: "error", result: "silent send blew up" }
						: { status: "finished", result: message.text },
				cancel: async () => {},
			};
		},
	};
}

const sentTurns: SentTurn[] = [];
const create = vi.fn();
const resume = vi.fn();

vi.mock("../src/cursor-runtime.js", () => ({
	loadCursorSdk: async () => ({ Agent: { create, resume } }),
}));

const { CursorLanguageModel } = await import(
	"../src/provider/language-model.js"
);
const { clearAgentPool, getSessionRecord } = await import(
	"../src/provider/session-pool.js"
);

const SESSION_ID = "sess-interjection";

function model() {
	return new CursorLanguageModel("cursor/auto", {
		providerName: "cursor",
		apiKey: "k",
		cwd: "/tmp",
		mode: "agent",
	});
}

function callOptions(prompt: LanguageModelV3Prompt, abortSignal?: AbortSignal) {
	return {
		prompt,
		providerOptions: { cursor: { sessionID: SESSION_ID } },
		...(abortSignal ? { abortSignal } : {}),
	} as unknown as LanguageModelV3CallOptions;
}

async function drain(
	model: InstanceType<typeof CursorLanguageModel>,
	prompt: LanguageModelV3Prompt,
	abortSignal?: AbortSignal,
): Promise<Array<{ type: string }>> {
	const { stream } = await model.doStream(callOptions(prompt, abortSignal));
	const reader = stream.getReader();
	const parts: Array<{ type: string }> = [];
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value as { type: string });
	}
	return parts;
}

/** Texts that reached the visible output stream (silent turns emit none). */
function streamedTexts(parts: Array<{ type: string }>): string[] {
	return parts
		.filter((p) => p.type === "text-delta")
		.map((p) => (p as unknown as { delta: string }).delta);
}

const sys = { role: "system" as const, content: "S" };
const user = (text: string): LanguageModelV3Prompt[number] => ({
	role: "user",
	content: [{ type: "text", text }],
});
const assistant = (text: string): LanguageModelV3Prompt[number] => ({
	role: "assistant",
	content: [{ type: "text", text }],
});

afterEach(() => {
	create.mockReset();
	resume.mockReset();
	sentTurns.length = 0;
	clearAgentPool();
});

describe("multi-message interjection (continuation-multi)", () => {
	it("resumes and replays each queued message in order, streaming only the last", async () => {
		// Turn 1: establishes the pooled agent + fingerprint (single user msg).
		create.mockResolvedValue(makeFakeAgent("a1", sentTurns));
		await drain(model(), [sys, user("a")]);
		expect(create).toHaveBeenCalledOnce();

		// Turn 2: two new user messages were queued while busy -> continuation-multi.
		resume.mockResolvedValue(makeFakeAgent("a1", sentTurns));
		sentTurns.length = 0;
		const parts = await drain(model(), [
			sys,
			user("a"),
			assistant("x"),
			user("b"),
			user("c"),
		]);

		// Resumed the pooled agent (not a fresh create).
		expect(resume).toHaveBeenCalledWith("a1", expect.anything());
		// Two sequential sends in order: "b" then "c".
		expect(sentTurns.map((t) => t.text)).toEqual(["b", "c"]);
		// Only the final turn ("c") surfaces text to the visible stream; the
		// silent replay of "b" streams nothing.
		expect(streamedTexts(parts)).toEqual(["c"]);
	});

	it("folds silent-replay usage into the final visible turn's finish usage", async () => {
		// Turn 1: pool the agent.
		create.mockResolvedValue(makeFakeAgent("a1", sentTurns));
		await drain(model(), [sys, user("a")]);

		// Turn 2: continuation-multi (b silent, c streamed). Each turn reports the
		// same usage; the final finish usage must equal their sum.
		resume.mockResolvedValue(
			makeFakeAgent("a1", sentTurns, {
				usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2 },
			}),
		);
		sentTurns.length = 0;
		const parts = await drain(model(), [
			sys,
			user("a"),
			assistant("x"),
			user("b"),
			user("c"),
		]);

		const finish = parts.find((p) => p.type === "finish") as unknown as {
			usage: {
				inputTokens: { total: number; cacheRead: number; cacheWrite: number };
				outputTokens: { total: number };
			};
		};
		expect(finish).toBeDefined();
		// b (silent) + c (streamed): 10+10, 5+5, 1+1 cacheRead, 2+2 cacheWrite.
		expect(finish.usage.inputTokens.total).toBe(20);
		expect(finish.usage.outputTokens.total).toBe(10);
		expect(finish.usage.inputTokens.cacheRead).toBe(2);
		expect(finish.usage.inputTokens.cacheWrite).toBe(4);
	});

	it("drops the session record when a silent send fails mid-sequence, so the next turn replays fresh", async () => {
		// Turn 1: pool the agent.
		create.mockResolvedValue(makeFakeAgent("a1", sentTurns));
		await drain(model(), [sys, user("a")]);
		expect(getSessionRecord(SESSION_ID)).toBeDefined();

		// Turn 2: continuation-multi, but the FIRST (silent) send errors.
		resume.mockResolvedValue(
			makeFakeAgent("a1", sentTurns, { failOnText: "b" }),
		);
		sentTurns.length = 0;
		const parts = await drain(model(), [
			sys,
			user("a"),
			assistant("x"),
			user("b"),
			user("c"),
		]);

		// The failure surfaced as an error stream part, message "c" never sent.
		expect(parts.some((p) => p.type === "error")).toBe(true);
		expect(sentTurns.map((t) => t.text)).toEqual(["b"]);
		// Record rolled back: next turn must NOT resume on top of undelivered msgs.
		expect(getSessionRecord(SESSION_ID)).toBeUndefined();

		// Turn 3 (same prompt retry): classifies "new" -> fresh agent, full replay.
		create.mockClear();
		create.mockResolvedValue(makeFakeAgent("a2", sentTurns));
		resume.mockClear();
		sentTurns.length = 0;
		await drain(model(), [sys, user("a"), assistant("x"), user("b"), user("c")]);
		expect(create).toHaveBeenCalledOnce();
		expect(resume).not.toHaveBeenCalled();
		expect(sentTurns).toHaveLength(1); // one full-transcript send
		expect(sentTurns[0]?.streamed).toBe(true);
	});

	it("keeps the session record when the full multi sequence delivers", async () => {
		create.mockResolvedValue(makeFakeAgent("a1", sentTurns));
		await drain(model(), [sys, user("a")]);
		resume.mockResolvedValue(makeFakeAgent("a1", sentTurns));
		await drain(model(), [sys, user("a"), user("b"), user("c")]);
		expect(getSessionRecord(SESSION_ID)).toMatchObject({ agentId: "a1" });
	});

	it("stops sending and drops the record when abort fires between silent sends", async () => {
		// Turn 1: pool the agent.
		create.mockResolvedValue(makeFakeAgent("a1", sentTurns));
		await drain(model(), [sys, user("a")]);
		expect(getSessionRecord(SESSION_ID)).toBeDefined();

		// Turn 2: continuation-multi with THREE new msgs (b, c, d). The abort fires
		// as soon as the first silent send ("b") resolves, so the loop's pre-send
		// check breaks before "c" is ever sent and the final "d" never streams.
		const controller = new AbortController();
		const abortingAgent = {
			agentId: "a1",
			close: vi.fn(),
			send: async (
				message: { text: string },
				_sendOptions?: Record<string, unknown>,
			) => {
				sentTurns.push({ text: message.text, streamed: false });
				if (message.text === "b") controller.abort();
				return {
					id: "run",
					wait: async () => ({ status: "finished", result: message.text }),
					cancel: async () => {},
				};
			},
		};
		resume.mockResolvedValue(abortingAgent);
		sentTurns.length = 0;

		const parts = await drain(
			model(),
			[sys, user("a"), user("b"), user("c"), user("d")],
			controller.signal,
		);

		// Only "b" was sent; "c"/"d" skipped once the signal was observed.
		expect(sentTurns).toEqual([{ text: "b", streamed: false }]);
		// No error part: an aborted multi turn finishes cleanly (empty stream).
		expect(parts.some((p) => p.type === "error")).toBe(false);
		// Record dropped: next turn must replay fresh, not resume on undelivered msgs.
		expect(getSessionRecord(SESSION_ID)).toBeUndefined();
	});

	it("falls back to a full transcript replay when trailing user msgs are insufficient", async () => {
		// Prime the pool.
		create.mockResolvedValue(makeFakeAgent("a1", sentTurns));
		await drain(model(), [sys, user("a")]);

		// A transcript whose fingerprint claims 2 new msgs but the tail is broken by
		// an assistant turn -> classifier yields divergence, so full replay (fresh).
		create.mockResolvedValue(makeFakeAgent("a2", sentTurns));
		sentTurns.length = 0;
		await drain(model(), [sys, user("a"), user("b"), assistant("mid")]);

		// Last message not a user turn -> divergence -> fresh full replay, one send.
		expect(sentTurns).toHaveLength(1);
		expect(sentTurns[0]?.streamed).toBe(true);
	});
});
