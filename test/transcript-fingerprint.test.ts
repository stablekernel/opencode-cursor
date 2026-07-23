import { describe, expect, it } from "vitest";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import {
	classifyTurn,
	fingerprint,
	mcpServersFingerprint,
	sendIdempotencyKey,
	type TranscriptRecord,
} from "../src/provider/transcript-fingerprint.js";

const sys = (text: string): LanguageModelV3Prompt[number] => ({
	role: "system",
	content: text,
});
const user = (text: string): LanguageModelV3Prompt[number] => ({
	role: "user",
	content: [{ type: "text", text }],
});
const assistant = (text: string): LanguageModelV3Prompt[number] => ({
	role: "assistant",
	content: [{ type: "text", text }],
});

/** Build a pool record from a prompt + agentId (what the pool would store). */
function record(
	prompt: LanguageModelV3Prompt,
	agentId = "a1",
): TranscriptRecord {
	return { agentId, ...fingerprint(prompt) };
}

describe("classifyTurn", () => {
	it("returns 'new' when there is no prior record", () => {
		const prompt = [sys("S"), user("hi")];
		expect(classifyTurn(undefined, prompt).kind).toBe("new");
	});

	it("returns 'continuation' when one new user turn is appended", () => {
		const turn1 = [sys("S"), user("hi")];
		const prev = record(turn1);
		const turn2 = [sys("S"), user("hi"), assistant("hello"), user("more")];
		const c = classifyTurn(prev, turn2);
		expect(c.kind).toBe("continuation");
		expect(c.fingerprint.userHashes).toHaveLength(2);
		expect(c.newUserCount).toBe(1);
	});

	it("returns 'side-call' when the system prompt changes (e.g. title gen)", () => {
		const prev = record([sys("chat system"), user("hi")]);
		const titleGen = [sys("Generate a short title"), user("hi")];
		expect(classifyTurn(prev, titleGen).kind).toBe("side-call");
	});

	it("returns 'divergence' when an earlier user message was edited", () => {
		const prev = record([sys("S"), user("hi"), assistant("ok")]);
		const edited = [
			sys("S"),
			user("HELLO EDITED"),
			assistant("ok"),
			user("next"),
		];
		expect(classifyTurn(prev, edited).kind).toBe("divergence");
	});

	it("returns 'divergence' on revert/compaction (fewer or reshaped user turns)", () => {
		const prev = record([sys("S"), user("a"), assistant("x"), user("b")]);
		const reverted = [sys("S"), user("a")];
		expect(classifyTurn(prev, reverted).kind).toBe("divergence");
	});

	it("returns 'continuation-multi' when >=2 new user messages are appended to a strict prefix", () => {
		const prev = record([sys("S"), user("a")]);
		const queued = [sys("S"), user("a"), user("b"), user("c")];
		const c = classifyTurn(prev, queued);
		expect(c.kind).toBe("continuation-multi");
		expect(c.newUserCount).toBe(2);
		expect(c.fingerprint.userHashes).toHaveLength(3);
	});

	it("returns 'divergence' when new user msgs are interleaved with assistant turns (non-contiguous tail)", () => {
		// Interject -> abort mid-response -> interject again: opencode keeps the
		// aborted assistant turn, so the new user msgs are NOT a contiguous tail.
		// Resuming here would silently drop the earlier queued message, so this
		// must fall back to divergence (fresh agent + full replay).
		const prev = record([sys("S"), user("a")]);
		const interleaved = [
			sys("S"),
			user("a"),
			assistant("x"),
			user("b"),
			assistant("partial"),
			user("c"),
		];
		expect(classifyTurn(prev, interleaved).kind).toBe("divergence");
	});

	it("returns 'divergence' when an earlier message is edited AND multiple new msgs are queued", () => {
		const prev = record([sys("S"), user("a")]);
		const editedPlusQueued = [sys("S"), user("EDITED"), user("b"), user("c")];
		expect(classifyTurn(prev, editedPlusQueued).kind).toBe("divergence");
	});

	it("returns 'divergence' when the last message is not a user turn", () => {
		const prev = record([sys("S"), user("a")]);
		const endsAssistant = [sys("S"), user("a"), assistant("trailing")];
		expect(classifyTurn(prev, endsAssistant).kind).toBe("divergence");
	});

	it("treats identical image-bearing user turns as a stable prefix", () => {
		const img = (): LanguageModelV3Prompt[number] => ({
			role: "user",
			content: [
				{ type: "text", text: "look" },
				{ type: "file", data: "https://x/a.png", mediaType: "image/png" },
			],
		});
		const prev = record([sys("S"), img()]);
		const turn2 = [sys("S"), img(), assistant("seen"), user("and now?")];
		expect(classifyTurn(prev, turn2).kind).toBe("continuation");
	});
});

describe("mcpServersFingerprint", () => {
	it("hashes empty/undefined sets to the same empty string", () => {
		expect(mcpServersFingerprint(undefined)).toBe("");
		expect(mcpServersFingerprint({})).toBe("");
	});

	it("is independent of key insertion order", () => {
		const a = mcpServersFingerprint({
			serena: { type: "stdio", command: "serena" },
			ctx: { type: "http", url: "https://x" },
		});
		const b = mcpServersFingerprint({
			ctx: { type: "http", url: "https://x" },
			serena: { type: "stdio", command: "serena" },
		});
		expect(a).toBe(b);
	});

	it("changes when a server is added or removed", () => {
		const one = mcpServersFingerprint({
			serena: { type: "stdio", command: "serena" },
		});
		const two = mcpServersFingerprint({
			serena: { type: "stdio", command: "serena" },
			ctx: { type: "http", url: "https://x" },
		});
		expect(one).not.toBe(two);
	});
});

describe("fingerprint", () => {
	it("is stable for identical prompts and ignores assistant content", () => {
		const a = fingerprint([sys("S"), user("hi"), assistant("one")]);
		const b = fingerprint([sys("S"), user("hi"), assistant("TWO DIFFERENT")]);
		expect(a).toEqual(b);
	});

	it("changes when a user message changes", () => {
		const a = fingerprint([sys("S"), user("hi")]);
		const b = fingerprint([sys("S"), user("bye")]);
		expect(a.userHashes).not.toEqual(b.userHashes);
	});
});

describe("sendIdempotencyKey", () => {
	it("is deterministic and distinct per transcript state", () => {
		const a = sendIdempotencyKey("s1", { userHashes: ["h1", "h2"] }, "hello");
		const b = sendIdempotencyKey("s1", { userHashes: ["h1", "h2"] }, "hello");
		const c = sendIdempotencyKey("s1", { userHashes: ["h1", "h2", "h3"] }, "hello");
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a).toMatch(/^[0-9a-f]{32}$/);
	});

	it("distinct sessions never share a key", () => {
		expect(sendIdempotencyKey("s1", undefined, "hi")).not.toBe(
			sendIdempotencyKey("s2", undefined, "hi"),
		);
	});
});
