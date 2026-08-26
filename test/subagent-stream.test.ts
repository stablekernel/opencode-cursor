import { describe, expect, it, vi } from "vitest";
import type { SubagentLiveSession } from "../src/provider/subagent-bridge.js";
import { SubagentTranscriptSink } from "../src/provider/subagent-stream.js";

/**
 * A fake live session capturing flushed transcript snapshots and tool-part
 * writes. Each `flush` entry is a CUMULATIVE snapshot (the full transcript so
 * far), matching the growing-message contract.
 */
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
	it("renders text and reasoning into the transcript", async () => {
		const { session, flushed } = fakeSession();
		const sink = new SubagentTranscriptSink(session);
		sink.push({ type: "text", text: "hello world" });
		sink.push({ type: "reasoning", text: "thinking hard" });
		await sink.finalize();

		const body = flushed.join("\n");
		expect(body).toContain("hello world");
		expect(body).toContain("> thinking hard");
	});

	it("keeps tool activity out of the transcript — tool parts render it", async () => {
		const { session, flushed, parts } = fakeSession();
		const sink = new SubagentTranscriptSink(session);
		sink.push({ type: "text", text: "before" });
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
		sink.push({ type: "text", text: "after" });
		await sink.finalize();

		const body = flushed.join("\n");
		expect(body).toContain("before");
		expect(body).toContain("after");
		// Tool args/results appear via `tool` parts, not markdown in the
		// transcript (writing both duplicates them in the subagent pane).
		expect(body).not.toContain("git status");
		expect(body).not.toContain("clean");
		expect(parts.map((p) => p.status)).toEqual(["running", "completed"]);
	});

	it("each flush carries the FULL cumulative transcript", async () => {
		vi.useFakeTimers();
		try {
			const { session, flushed } = fakeSession();
			const sink = new SubagentTranscriptSink(session);
			sink.push({ type: "text", text: "first fragment" });
			await vi.advanceTimersByTimeAsync(2000);
			expect(flushed).toHaveLength(1);
			expect(flushed[0]).toContain("first fragment");
			sink.push({ type: "text", text: " second fragment" });
			await vi.advanceTimersByTimeAsync(2000);
			expect(flushed).toHaveLength(2);
			// The second snapshot still carries the first — the growing message
			// is replaced wholesale, never appended to piece by piece.
			expect(flushed[1]).toContain("first fragment");
			expect(flushed[1]).toContain("second fragment");
			await sink.finalize();
		} finally {
			vi.useRealTimers();
		}
	});

	it("coalesces text on a timer and does not flush on tool events", async () => {
		vi.useFakeTimers();
		try {
			const { session, flushed } = fakeSession();
			const sink = new SubagentTranscriptSink(session);
			sink.push({ type: "text", text: "a" });
			expect(flushed).toHaveLength(0);
			// Tool events no longer force a flush — they only write tool parts,
			// so a flowing paragraph is never cut at a tool boundary.
			sink.push({
				type: "tool-result",
				id: "s1",
				name: "read",
				result: { status: "success", value: { fileContentAfterWrite: "data" } },
				isError: false,
			});
			expect(flushed).toHaveLength(0);
			await vi.advanceTimersByTimeAsync(2000);
			expect(flushed).toHaveLength(1);
			expect(flushed[0]).toContain("a");
			await sink.finalize();
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

	it("merges the final answer, steps, and activity into ONE flush", async () => {
		const { session, flushed } = fakeSession();
		const sink = new SubagentTranscriptSink(session);
		sink.push({ type: "text", text: "working on it" });
		await sink.finalize(
			{
				resultSuffix: "final answer",
				conversationSteps: [
					{ assistantMessage: { text: "step text" } },
					{
						toolCall: {
							shellToolCall: {
								args: { command: "git status" },
								result: { stdout: "clean" },
							},
						},
					},
				],
			},
			"_Subagent ran 1 step in 5.0s._",
		);
		// Everything lands in a single final snapshot, not three extra messages.
		expect(flushed).toHaveLength(1);
		const body = flushed[0]!;
		expect(body).toContain("working on it");
		expect(body).toContain("final answer");
		expect(body).toContain("step text");
		expect(body).toContain("git status");
		expect(body).toContain("clean");
		expect(body).toContain("5.0s");
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
