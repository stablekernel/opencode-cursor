import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";

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
	opts?: { failOnText?: string },
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
			sent.push({ text: message.text, streamed: Boolean(onDelta) });
			const failed = opts?.failOnText === message.text;
			onDelta?.({ update: { type: "text-delta", text: message.text } });
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

function callOptions(prompt: LanguageModelV3Prompt) {
	return {
		prompt,
		providerOptions: { cursor: { sessionID: SESSION_ID } },
	} as never;
}

async function drain(
	model: InstanceType<typeof CursorLanguageModel>,
	prompt: LanguageModelV3Prompt,
): Promise<Array<{ type: string }>> {
	const { stream } = await model.doStream(callOptions(prompt));
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
		await drain(model(), [sys, user("a"), assistant("x"), user("b"), user("c")]);

		// Resumed the pooled agent (not a fresh create).
		expect(resume).toHaveBeenCalledWith("a1", expect.anything());
		// Two sequential sends: "b" silent, "c" streamed.
		expect(sentTurns).toEqual([
			{ text: "b", streamed: false },
			{ text: "c", streamed: true },
		]);
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
		expect(sentTurns).toEqual([{ text: "b", streamed: false }]);
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
