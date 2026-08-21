import { describe, expect, it, vi } from "vitest";
import type { SubagentLiveSession } from "../src/provider/subagent-bridge.js";
import { SubagentTranscriptSink } from "../src/provider/subagent-stream.js";

/** A fake live session capturing flushed markdown and tool-part writes. */
function fakeSession(): {
	session: SubagentLiveSession;
	flushed: string[];
	finalized: string[];
	parts: Array<{
		callID: string;
		tool: string;
		status: string;
		title?: string;
		partID?: string;
	}>;
} {
	const flushed: string[] = [];
	const finalized: string[] = [];
	const parts: Array<{
		callID: string;
		tool: string;
		status: string;
		title?: string;
		partID?: string;
	}> = [];
	let counter = 0;
	return {
		flushed,
		finalized,
		parts,
		session: {
			childId: "ses_child",
			messageID: "msg_seed",
			flush: async (markdown: string) => {
				flushed.push(markdown);
			},
			toolPart: async (part) => {
				const partID = part.partID ?? `prt_${++counter}`;
				parts.push({
					callID: part.callID,
					tool: part.tool,
					status: part.status,
					title: part.title,
					partID,
				});
				return partID;
			},
			finalize: async (activity?: string) => {
				if (activity) finalized.push(activity);
			},
		},
	};
}

describe("SubagentTranscriptSink", () => {
	it("renders text, reasoning, and tool activity into markdown", async () => {
		const { session, flushed } = fakeSession();
		const sink = new SubagentTranscriptSink(session);
		sink.push({ type: "text", text: "hello world" });
		sink.push({ type: "reasoning", text: "thinking hard" });
		sink.push({
			type: "tool-start",
			id: "s1",
			name: "shell",
			input: { command: "git status" },
		});
		sink.push({
			type: "tool-result",
			id: "s1",
			name: "shell",
			result: { status: "success", value: { stdout: "clean" } },
			isError: false,
		});
		await sink.finalize(
			{ resultSuffix: "done", conversationSteps: [] },
			"_Subagent ran 1 step in 5.0s._",
		);

		const body = flushed.join("\n");
		expect(body).toContain("hello world");
		expect(body).toContain("> thinking hard");
		expect(body).toContain("shell");
		expect(body).toContain("git status");
		expect(body).toContain("clean");
		expect(body).toContain("done");
	});

	it("marks failed tool results and keeps long output intact", async () => {
		const { session, flushed } = fakeSession();
		const sink = new SubagentTranscriptSink(session);
		sink.push({
			type: "tool-start",
			id: "s1",
			name: "shell",
			input: { command: "x".repeat(5000) },
		});
		sink.push({
			type: "tool-result",
			id: "s1",
			name: "shell",
			result: { status: "error", error: "boom" },
			isError: true,
		});
		await sink.finalize();

		const body = flushed.join("\n");
		expect(body).toContain("failed");
		// The child session carries the full transcript: nothing is truncated.
		expect(body).toContain("x".repeat(5000));
	});

	it("flushes tool results promptly and coalesces text on a timer", async () => {
		vi.useFakeTimers();
		try {
			const { session, flushed } = fakeSession();
			const sink = new SubagentTranscriptSink(session);
			sink.push({ type: "text", text: "a" });
			// A tool result triggers an immediate flush of the buffered text.
			sink.push({
				type: "tool-result",
				id: "s1",
				name: "read",
				result: { status: "success", value: { fileContentAfterWrite: "data" } },
				isError: false,
			});
			expect(flushed.join("\n")).toContain("a");
			expect(flushed.join("\n")).toContain("data");
			// Text pushed after the flush is buffered until the timer fires.
			sink.push({ type: "text", text: "b" });
			expect(flushed.join("\n")).not.toContain("b");
			await vi.advanceTimersByTimeAsync(2000);
			expect(flushed.join("\n")).toContain("b");
		} finally {
			vi.useRealTimers();
		}
	});

	it("is a no-op after finalize", async () => {
		const { session, flushed } = fakeSession();
		const sink = new SubagentTranscriptSink(session);
		await sink.finalize({ resultSuffix: "done" });
		sink.push({ type: "text", text: "late" });
		await sink.finalize({ resultSuffix: "again" });
		expect(flushed.join("\n")).toContain("done");
		expect(flushed.join("\n")).not.toContain("late");
		expect(flushed.join("\n")).not.toContain("again");
	});

	it("renders conversation steps on finalize", async () => {
		const { session, flushed } = fakeSession();
		const sink = new SubagentTranscriptSink(session);
		await sink.finalize({
			resultSuffix: "final answer",
			conversationSteps: [
				{ assistantMessage: { text: "working on it" } },
				{
					toolCall: {
						shellToolCall: {
							args: { command: "git status" },
							result: { stdout: "clean" },
						},
					},
				},
			],
		});
		const body = flushed.join("\n");
		expect(body).toContain("final answer");
		expect(body).toContain("working on it");
		expect(body).toContain("git status");
		expect(body).toContain("clean");
	});

	it("writes a running then completed tool part per nested tool call", async () => {
		const { session, parts } = fakeSession();
		const sink = new SubagentTranscriptSink(session);
		sink.push({
			type: "tool-start",
			id: "s1",
			name: "shell",
			input: { command: "git status" },
		});
		sink.push({
			type: "tool-result",
			id: "s1",
			name: "shell",
			result: { status: "success", value: {} },
			isError: false,
		});
		await sink.finalize();
		expect(parts.map((p) => `${p.tool}:${p.status}`)).toEqual([
			"shell:running",
			"shell:completed",
		]);
		expect(parts[0]!.title).toBe("git status");
		// The completion upserts the running part rather than adding a second.
		expect(parts[1]!.partID).toBe(parts[0]!.partID);
	});

	it("completes a tool call left open when the subagent ends", async () => {
		const { session, parts } = fakeSession();
		const sink = new SubagentTranscriptSink(session);
		sink.push({
			type: "tool-start",
			id: "s1",
			name: "read",
			input: { path: "a.ts" },
		});
		await sink.finalize();
		expect(parts.map((p) => `${p.tool}:${p.status}`)).toEqual([
			"read:running",
			"read:completed",
		]);
		expect(parts[1]!.partID).toBe(parts[0]!.partID);
	});

	it("writes a completed part for a result whose start was never observed", async () => {
		const { session, parts } = fakeSession();
		const sink = new SubagentTranscriptSink(session);
		sink.push({
			type: "tool-result",
			id: "s9",
			name: "grep",
			result: { status: "success", value: {} },
			isError: false,
		});
		await sink.finalize();
		expect(parts.map((p) => `${p.tool}:${p.status}`)).toEqual(["grep:completed"]);
	});
});
