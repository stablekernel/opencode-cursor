import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	LanguageModelV3CallOptions,
	LanguageModelV3Prompt,
} from "@ai-sdk/provider";

// Sandbox the on-disk session store away from the user's real cache dir.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "cursor-lm-fb-test-"));

interface SentTurn {
	text: string;
	streamed: boolean;
}

const sentTurns: SentTurn[] = [];
const create = vi.fn();
const resume = vi.fn();

vi.mock("../src/cursor-runtime.js", () => ({
	loadCursorSdk: async () => ({ Agent: { create, resume } }),
}));

// The classifier guarantees `continuation-multi` prompts end in a contiguous
// user tail of exactly `newUserCount` messages, so the count/tail mismatch the
// model guards against is unreachable through the public API. Construct it
// artificially: make trailingUserMessages return one message fewer than asked,
// as a stand-in for a future refactor breaking the classifier invariant.
vi.mock("../src/provider/message-map.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/provider/message-map.js")>();
	return {
		...actual,
		trailingUserMessages: (prompt: LanguageModelV3Prompt, count: number) =>
			actual.trailingUserMessages(prompt, count).slice(1),
	};
});

const { CursorLanguageModel } = await import(
	"../src/provider/language-model.js"
);
const { clearAgentPool, getSessionRecord } = await import(
	"../src/provider/session-pool.js"
);

const SESSION_ID = "sess-fallback";

function makeFakeAgent(agentId: string) {
	return {
		agentId,
		close: vi.fn(),
		send: async (
			message: { text: string },
			sendOptions?: Record<string, unknown>,
		) => {
			sentTurns.push({
				text: message.text,
				streamed: Boolean(sendOptions?.["onDelta"]),
			});
			return {
				id: "run",
				wait: async () => ({ status: "finished", result: message.text }),
				cancel: async () => {},
			};
		},
	};
}

function model() {
	return new CursorLanguageModel("cursor/auto", {
		providerName: "cursor",
		apiKey: "k",
		cwd: "/tmp",
		mode: "agent",
	});
}

async function drain(prompt: LanguageModelV3Prompt): Promise<void> {
	const options = {
		prompt,
		providerOptions: { cursor: { sessionID: SESSION_ID } },
	} as unknown as LanguageModelV3CallOptions;
	const { stream } = await model().doStream(options);
	const reader = stream.getReader();
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const { done } = await reader.read();
		if (done) break;
	}
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

describe("multi-turn tail mismatch (defensive fallback)", () => {
	it("forces a cold full-transcript replay instead of degrading to the latest message", async () => {
		// Turn 1: pool the agent with a single-user fingerprint.
		create.mockResolvedValue(makeFakeAgent("a1"));
		await drain([sys, user("a")]);
		expect(getSessionRecord(SESSION_ID)).toBeDefined();

		// Turn 2: continuation-multi (2 new user msgs), but the mocked
		// trailingUserMessages recovers only 1 of them — the mismatch case.
		// The model must NOT resume-and-send-only-"c" (which silently drops "b");
		// it must fall back to a fresh agent + full transcript so nothing is lost.
		create.mockClear();
		create.mockResolvedValue(makeFakeAgent("a2"));
		resume.mockResolvedValue(makeFakeAgent("a1"));
		sentTurns.length = 0;
		await drain([sys, user("a"), assistant("x"), user("b"), user("c")]);

		expect(resume).not.toHaveBeenCalled();
		expect(create).toHaveBeenCalledOnce();
		expect(sentTurns).toHaveLength(1);
		expect(sentTurns[0]?.streamed).toBe(true);
		// Full transcript: every queued message is present, none dropped.
		expect(sentTurns[0]?.text).toContain("b");
		expect(sentTurns[0]?.text).toContain("c");

		// The record now reflects the fully delivered transcript: the NEXT turn
		// is a clean continuation on the fresh agent.
		expect(getSessionRecord(SESSION_ID)).toMatchObject({ agentId: "a2" });
	});
});
