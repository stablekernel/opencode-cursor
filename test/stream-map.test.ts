import { describe, expect, it } from "vitest";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { CursorEvent } from "../src/provider/agent-events.js";
import {
	cursorEventsToContent,
	cursorEventsToStream,
	mapUsage,
} from "../src/provider/stream-map.js";

async function* gen(events: CursorEvent[]): AsyncGenerator<CursorEvent> {
	for (const e of events) yield e;
}

async function* genThenThrow(
	events: CursorEvent[],
	err: unknown,
): AsyncGenerator<CursorEvent> {
	for (const e of events) yield e;
	throw err;
}

async function collect(
	stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3StreamPart[]> {
	const reader = stream.getReader();
	const out: LanguageModelV3StreamPart[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		out.push(value);
	}
	return out;
}

const types = (parts: LanguageModelV3StreamPart[]) => parts.map((p) => p.type);

// Mirrors the exact sequence observed from a live Cursor agent in CI:
// 4 reasoning deltas, then 2 text deltas, then usage, then finish.
const LIVE_SEQUENCE: CursorEvent[] = [
	{ type: "reasoning-delta", text: "th" },
	{ type: "reasoning-delta", text: "in" },
	{ type: "reasoning-delta", text: "ki" },
	{ type: "reasoning-delta", text: "ng" },
	{ type: "text-delta", text: "PO" },
	{ type: "text-delta", text: "NG" },
	{
		type: "usage",
		usage: {
			inputTokens: 10251,
			outputTokens: 46,
			cacheReadTokens: 7412,
			cacheWriteTokens: 0,
		},
	},
	{ type: "finish", text: "PONG" },
];

describe("cursorEventsToStream", () => {
	it("maps the live reasoning+text sequence with clean block nesting", async () => {
		const parts = await collect(cursorEventsToStream(gen(LIVE_SEQUENCE)));
		expect(types(parts)).toEqual([
			"stream-start",
			"reasoning-start",
			"reasoning-delta",
			"reasoning-delta",
			"reasoning-delta",
			"reasoning-delta",
			"reasoning-end", // closed before text starts
			"text-start",
			"text-delta",
			"text-delta",
			"text-end",
			"finish",
		]);

		const text = parts
			.filter(
				(p): p is Extract<LanguageModelV3StreamPart, { type: "text-delta" }> =>
					p.type === "text-delta",
			)
			.map((p) => p.delta)
			.join("");
		expect(text).toBe("PONG");

		const finish = parts.find((p) => p.type === "finish");
		expect(finish).toMatchObject({
			finishReason: { unified: "stop" },
			usage: {
				inputTokens: { total: 10251, cacheRead: 7412 },
				outputTokens: { total: 46 },
			},
		});
	});

	it("closes the open text part when reasoning resumes so parts render in true order", async () => {
		// Interleaved turn: intro text → tool/reasoning activity → final text. The
		// final text must land in a NEW part (text-1) that starts after the
		// reasoning block — appending it to text-0 makes the final answer render
		// ABOVE the thinking blocks in opencode's UI.
		const events: CursorEvent[] = [
			{ type: "text-delta", text: "intro" },
			{ type: "reasoning-delta", text: "thinking" },
			{ type: "text-delta", text: "final" },
			{ type: "finish" },
		];
		const parts = await collect(cursorEventsToStream(gen(events)));
		expect(types(parts)).toEqual([
			"stream-start",
			"text-start",
			"text-delta",
			"text-end", // closed before reasoning starts
			"reasoning-start",
			"reasoning-delta",
			"reasoning-end",
			"text-start", // fresh part for the final answer
			"text-delta",
			"text-end",
			"finish",
		]);

		const textStartIds = parts
			.filter(
				(p): p is Extract<LanguageModelV3StreamPart, { type: "text-start" }> =>
					p.type === "text-start",
			)
			.map((p) => p.id);
		expect(new Set(textStartIds).size).toBe(2);

		// Each delta belongs to the part that was open at the time.
		const deltas = parts.filter(
			(p): p is Extract<LanguageModelV3StreamPart, { type: "text-delta" }> =>
				p.type === "text-delta",
		);
		expect(deltas[0]!.id).toBe(textStartIds[0]);
		expect(deltas[1]!.id).toBe(textStartIds[1]);
	});

	it("renders Cursor's own tool activity as reasoning, not tool-call parts", async () => {
		const events: CursorEvent[] = [
			{ type: "tool-call", id: "c1", name: "write", input: { path: "a.txt" } },
			{
				type: "tool-result",
				id: "c1",
				name: "write",
				result: { ok: true },
				isError: false,
			},
			{ type: "tool-call", id: "c2", name: "serena/find_symbol", input: {} },
			{
				type: "tool-result",
				id: "c2",
				name: "serena/find_symbol",
				result: { e: 1 },
				isError: true,
			},
			{ type: "text-delta", text: "done" },
			{ type: "finish" },
		];
		const parts = await collect(cursorEventsToStream(gen(events), "reasoning"));

		// No tool-call/tool-result parts cross into opencode (avoids "unavailable tool").
		expect(types(parts)).not.toContain("tool-call");
		expect(types(parts)).not.toContain("tool-result");

		const reasoning = parts
			.filter(
				(
					p,
				): p is Extract<
					LanguageModelV3StreamPart,
					{ type: "reasoning-delta" }
				> => p.type === "reasoning-delta",
			)
			.map((p) => p.delta)
			.join("");
		expect(reasoning).toContain("[tool] write");
		expect(reasoning).toContain('{"path":"a.txt"}');
		// A failed tool surfaces its failure; a successful one does not add a status line.
		expect(reasoning).toContain("[tool] serena/find_symbol failed");
		expect(reasoning).not.toContain("write failed");

		// The final answer text is unpolluted by tool noise.
		const text = parts
			.filter(
				(p): p is Extract<LanguageModelV3StreamPart, { type: "text-delta" }> =>
					p.type === "text-delta",
			)
			.map((p) => p.delta)
			.join("");
		expect(text).toBe("done");
	});

	it("emits structured provider-executed tool-call/tool-result parts in 'blocks' mode", async () => {
		// Use tools with no native opencode counterpart so they stay generic
		// `cursor_*` blocks (mapped tools are covered in "native tool mapping").
		const events: CursorEvent[] = [
			{ type: "tool-call", id: "c1", name: "semSearch", input: { query: "x" } },
			{
				type: "tool-result",
				id: "c1",
				name: "semSearch",
				result: { results: "a\nb" },
				isError: false,
			},
			{
				type: "tool-call",
				id: "c2",
				name: "serena/find_symbol",
				input: { q: "x" },
			},
			{
				type: "tool-result",
				id: "c2",
				name: "serena/find_symbol",
				result: { err: "no" },
				isError: true,
			},
			{ type: "text-delta", text: "done" },
			{ type: "finish" },
		];
		const parts = await collect(cursorEventsToStream(gen(events), "blocks"));

		// Structured parts ARE emitted (not reasoning) in blocks mode.
		expect(types(parts)).toContain("tool-call");
		expect(types(parts)).toContain("tool-result");
		expect(types(parts)).not.toContain("reasoning-delta");

		// Names are prefixed/sanitized so they can't collide with opencode-registered
		// tools, and parts carry providerExecuted+dynamic so ai's parseToolCall
		// accepts them without registered-tool validation.
		const call = parts.find(
			(p): p is Extract<LanguageModelV3StreamPart, { type: "tool-call" }> =>
				p.type === "tool-call",
		)!;
		expect(call).toMatchObject({
			toolCallId: "c1",
			toolName: "cursor_semSearch",
			input: JSON.stringify({ query: "x" }),
			providerExecuted: true,
			dynamic: true,
		});

		// tool-result carries the V3-spec `result` + `isError` fields (ai v6 reads
		// `chunk.result`; a structured `output` field would stream through as undefined).
		const results = parts.filter((p) => p.type === "tool-result") as Array<
			Record<string, unknown>
		>;
		expect(results[0]).toMatchObject({
			toolCallId: "c1",
			toolName: "cursor_semSearch",
			providerExecuted: true,
			dynamic: true,
			result: { results: "a\nb" },
			isError: false,
		});
		expect(results[1]).toMatchObject({
			toolCallId: "c2",
			toolName: "cursor_serena_find_symbol",
			result: { err: "no" },
			isError: true,
		});

		const text = parts
			.filter(
				(p): p is Extract<LanguageModelV3StreamPart, { type: "text-delta" }> =>
					p.type === "text-delta",
			)
			.map((p) => p.delta)
			.join("");
		expect(text).toBe("done");
	});

	it("synthesizes an error tool-result for a dangling tool-call in 'blocks' mode", async () => {
		// A run that dies mid-tool emits tool-call-started but never -completed.
		// Without a matching tool-result, opencode renders "Tool execution aborted".
		const events: CursorEvent[] = [
			{ type: "tool-call", id: "c1", name: "semSearch", input: { query: "x" } },
			{ type: "finish" },
		];
		const parts = await collect(cursorEventsToStream(gen(events), "blocks"));

		const result = parts.find((p) => p.type === "tool-result") as Record<
			string,
			unknown
		>;
		expect(result).toMatchObject({
			toolCallId: "c1",
			toolName: "cursor_semSearch",
			isError: true,
			providerExecuted: true,
			dynamic: true,
		});
		// Synthetic result arrives before finish so the part is never dangling.
		expect(types(parts).indexOf("tool-result")).toBeLessThan(
			types(parts).indexOf("finish"),
		);
	});

	it("synthesizes error tool-results for dangling calls when the source throws", async () => {
		const events: CursorEvent[] = [
			{ type: "tool-call", id: "c1", name: "semSearch", input: { query: "x" } },
		];
		const parts = await collect(
			cursorEventsToStream(
				genThenThrow(events, new Error("run died")),
				"blocks",
			),
		);
		const result = parts.find((p) => p.type === "tool-result") as Record<
			string,
			unknown
		>;
		expect(result).toMatchObject({
			toolCallId: "c1",
			toolName: "cursor_semSearch",
			isError: true,
		});
		const finish = parts.find((p) => p.type === "finish");
		expect(finish).toMatchObject({ finishReason: { unified: "error" } });
	});

	it("does not synthesize results for tool calls that completed", async () => {
		const events: CursorEvent[] = [
			{ type: "tool-call", id: "c1", name: "semSearch", input: {} },
			{
				type: "tool-result",
				id: "c1",
				name: "semSearch",
				result: { ok: 1 },
				isError: false,
			},
			{ type: "finish" },
		];
		const parts = await collect(cursorEventsToStream(gen(events), "blocks"));
		const results = parts.filter((p) => p.type === "tool-result");
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ isError: false });
	});

	it("falls back to finish.text when the agent streamed no text deltas", async () => {
		const events: CursorEvent[] = [{ type: "finish", text: "final answer" }];
		const parts = await collect(cursorEventsToStream(gen(events)));
		expect(types(parts)).toEqual([
			"stream-start",
			"text-start",
			"text-delta",
			"text-end",
			"finish",
		]);
		const delta = parts.find((p) => p.type === "text-delta");
		expect(delta).toMatchObject({ delta: "final answer" });
	});

	it("emits an error part and an error finish when the source throws", async () => {
		const boom = new Error("agent exploded");
		const parts = await collect(
			cursorEventsToStream(
				genThenThrow([{ type: "text-delta", text: "partial" }], boom),
			),
		);
		const error = parts.find((p) => p.type === "error");
		expect(error).toMatchObject({ error: boom });
		// text block that was opened still gets closed
		expect(types(parts)).toContain("text-end");
		const finish = parts.find((p) => p.type === "finish");
		expect(finish).toMatchObject({ finishReason: { unified: "error" } });
	});

	it("uses empty usage when no usage event arrives", async () => {
		const parts = await collect(
			cursorEventsToStream(
				gen([{ type: "text-delta", text: "hi" }, { type: "finish" }]),
			),
		);
		const finish = parts.find((p) => p.type === "finish");
		expect(finish).toMatchObject({
			usage: {
				inputTokens: { total: undefined },
				outputTokens: { total: undefined },
			},
		});
	});
});

describe("cursorEventsToContent (doGenerate)", () => {
	it("aggregates reasoning, text, and tool activity with usage", async () => {
		const { content, finishReason, usage } = await cursorEventsToContent(
			gen(LIVE_SEQUENCE),
		);
		expect(finishReason).toMatchObject({ unified: "stop" });
		expect(usage).toMatchObject({
			inputTokens: { total: 10251 },
			outputTokens: { total: 46 },
		});
		// reasoning first, then text
		expect(content[0]).toMatchObject({ type: "reasoning", text: "thinking" });
		expect(content[content.length - 1]).toMatchObject({
			type: "text",
			text: "PONG",
		});
	});

	it("folds tool activity into reasoning content", async () => {
		const { content } = await cursorEventsToContent(
			gen([
				{ type: "tool-call", id: "c1", name: "read", input: { path: "x" } },
				{ type: "text-delta", text: "ok" },
				{ type: "finish" },
			]),
			"reasoning",
		);
		const reasoning = content.find((c) => c.type === "reasoning");
		expect(reasoning).toMatchObject({ type: "reasoning" });
		expect((reasoning as { text: string }).text).toContain("[tool] read");
	});

	it("emits tool-call/tool-result content items in 'blocks' mode", async () => {
		const { content } = await cursorEventsToContent(
			gen([
				{
					type: "tool-call",
					id: "c1",
					name: "semSearch",
					input: { query: "x" },
				},
				{
					type: "tool-result",
					id: "c1",
					name: "semSearch",
					result: { data: "hi" },
					isError: false,
				},
				{ type: "text-delta", text: "ok" },
				{ type: "finish" },
			]),
			"blocks",
		);
		const callItem = content.find((c) => c.type === "tool-call");
		expect(callItem).toMatchObject({
			toolCallId: "c1",
			toolName: "cursor_semSearch",
			providerExecuted: true,
			dynamic: true,
		});
		const resultItem = content.find((c) => c.type === "tool-result") as Record<
			string,
			unknown
		>;
		expect(resultItem).toMatchObject({
			result: { data: "hi" },
			isError: false,
		});
		expect(content.find((c) => c.type === "reasoning")).toBeUndefined();
		expect(content[content.length - 1]).toMatchObject({
			type: "text",
			text: "ok",
		});
	});

	it("synthesizes an error tool-result content item for a dangling call in 'blocks' mode", async () => {
		const { content } = await cursorEventsToContent(
			gen([
				{ type: "tool-call", id: "c1", name: "semSearch", input: {} },
				{ type: "finish" },
			]),
			"blocks",
		);
		const resultItem = content.find((c) => c.type === "tool-result") as Record<
			string,
			unknown
		>;
		expect(resultItem).toMatchObject({
			toolCallId: "c1",
			toolName: "cursor_semSearch",
			isError: true,
		});
	});

	it("reports finishReason 'error' when the source throws", async () => {
		const { finishReason } = await cursorEventsToContent(
			genThenThrow([{ type: "text-delta", text: "x" }], new Error("nope")),
		);
		expect(finishReason).toMatchObject({ unified: "error" });
	});
});

// A unified diff as Cursor returns it in an edit result's `value.diffString`.
const EDIT_DIFF = [
	"Index: /a.ts",
	"===================================================================",
	"--- /a.ts",
	"+++ /a.ts",
	"@@ -1,3 +1,3 @@",
	" const x = 1;",
	"-const y = 2;",
	"+const y = 3;",
	" const z = 4;",
].join("\n");

type ToolCallPart = Extract<LanguageModelV3StreamPart, { type: "tool-call" }>;
type ToolResultPart = Extract<
	LanguageModelV3StreamPart,
	{ type: "tool-result" }
>;
const toolCalls = (parts: LanguageModelV3StreamPart[]) =>
	parts.filter((p): p is ToolCallPart => p.type === "tool-call");
const toolResults = (parts: LanguageModelV3StreamPart[]) =>
	parts.filter((p): p is ToolResultPart => p.type === "tool-result");

describe("native edit mapping (blocks)", () => {
	it("maps a Cursor edit onto opencode's registered `edit` tool with a reconstructed input + metadata.diff", async () => {
		const events: CursorEvent[] = [
			{ type: "tool-call", id: "e1", name: "edit", input: { path: "/a.ts" } },
			{
				type: "tool-result",
				id: "e1",
				name: "edit",
				result: {
					status: "success",
					value: { diffString: EDIT_DIFF, linesAdded: 1, linesRemoved: 1 },
				},
				isError: false,
			},
			{ type: "finish" },
		];
		const parts = await collect(cursorEventsToStream(gen(events), "blocks"));

		// Emitted under the REGISTERED name `edit` (not `cursor_edit`) so opencode's
		// diff viewer renders; input matches opencode's edit schema, reconstructed
		// from the diff's -/+ lines.
		const call = toolCalls(parts)[0]!;
		expect(call).toMatchObject({
			toolCallId: "e1",
			toolName: "edit",
			input: JSON.stringify({
				filePath: "/a.ts",
				oldString: "const y = 2;",
				newString: "const y = 3;",
			}),
			providerExecuted: true,
			dynamic: true,
		});

		// Result carries the {title, metadata:{diff}, output} shape opencode folds
		// into state.* — the diff viewer keys on metadata.diff.
		const result = toolResults(parts)[0]! as unknown as {
			result: Record<string, unknown>;
		};
		expect(result).toMatchObject({
			toolCallId: "e1",
			toolName: "edit",
			isError: false,
			providerExecuted: true,
			dynamic: true,
			result: {
				title: "/a.ts",
				metadata: { diff: EDIT_DIFF, diagnostics: {} },
				output: "Edit applied (+1/-1).",
			},
		});
	});

	it("holds the edit tool-call until its result (the diff only arrives with the result)", async () => {
		const events: CursorEvent[] = [
			{ type: "tool-call", id: "e1", name: "edit", input: { path: "/a.ts" } },
			{ type: "reasoning-delta", text: "thinking" },
			{
				type: "tool-result",
				id: "e1",
				name: "edit",
				result: { status: "success", value: { diffString: EDIT_DIFF } },
				isError: false,
			},
			{ type: "finish" },
		];
		const parts = await collect(cursorEventsToStream(gen(events), "blocks"));
		const callIndex = parts.findIndex((p) => p.type === "tool-call");
		const reasoningIndex = parts.findIndex((p) => p.type === "reasoning-delta");
		// The edit call is emitted AFTER the interleaved reasoning, i.e. at result time.
		expect(reasoningIndex).toBeGreaterThanOrEqual(0);
		expect(callIndex).toBeGreaterThan(reasoningIndex);
	});

	it("falls back to a safe `cursor_edit` block when the edit result is an error", async () => {
		const events: CursorEvent[] = [
			{ type: "tool-call", id: "e1", name: "edit", input: { path: "/a.ts" } },
			{
				type: "tool-result",
				id: "e1",
				name: "edit",
				result: { status: "error", error: "boom" },
				isError: true,
			},
			{ type: "finish" },
		];
		const parts = await collect(cursorEventsToStream(gen(events), "blocks"));
		expect(toolCalls(parts)[0]).toMatchObject({
			toolName: "cursor_edit",
			dynamic: true,
		});
		expect(toolResults(parts)[0]).toMatchObject({
			toolName: "cursor_edit",
			isError: true,
		});
	});

	it("falls back to `cursor_edit` when a successful result carries no usable diff", async () => {
		const events: CursorEvent[] = [
			{ type: "tool-call", id: "e1", name: "edit", input: { path: "/a.ts" } },
			{
				type: "tool-result",
				id: "e1",
				name: "edit",
				result: { status: "success", value: {} },
				isError: false,
			},
			{ type: "finish" },
		];
		const parts = await collect(cursorEventsToStream(gen(events), "blocks"));
		expect(toolCalls(parts)[0]).toMatchObject({ toolName: "cursor_edit" });
		expect(toolResults(parts)[0]).toMatchObject({ toolName: "cursor_edit" });
	});

	it("closes a dangling edit (call, no result) as a safe `cursor_edit` error block", async () => {
		const events: CursorEvent[] = [
			{ type: "tool-call", id: "e1", name: "edit", input: { path: "/a.ts" } },
			{ type: "finish" },
		];
		const parts = await collect(cursorEventsToStream(gen(events), "blocks"));
		expect(toolCalls(parts)[0]).toMatchObject({ toolName: "cursor_edit" });
		expect(toolResults(parts)[0]).toMatchObject({
			toolName: "cursor_edit",
			isError: true,
		});
	});

	it("leaves tools with no native counterpart as prefixed `cursor_*` blocks", async () => {
		const events: CursorEvent[] = [
			{ type: "tool-call", id: "c1", name: "semSearch", input: { query: "x" } },
			{
				type: "tool-result",
				id: "c1",
				name: "semSearch",
				result: { ok: true },
				isError: false,
			},
			{ type: "finish" },
		];
		const parts = await collect(cursorEventsToStream(gen(events), "blocks"));
		expect(toolCalls(parts)[0]).toMatchObject({ toolName: "cursor_semSearch" });
	});

	it("maps edits onto native `edit` content items in doGenerate", async () => {
		const { content } = await cursorEventsToContent(
			gen([
				{ type: "tool-call", id: "e1", name: "edit", input: { path: "/a.ts" } },
				{
					type: "tool-result",
					id: "e1",
					name: "edit",
					result: {
						status: "success",
						value: { diffString: EDIT_DIFF, linesAdded: 1, linesRemoved: 1 },
					},
					isError: false,
				},
				{ type: "finish" },
			]),
			"blocks",
		);
		const call = content.find(
			(c) => c.type === "tool-call",
		) as unknown as Record<string, unknown>;
		const result = content.find((c) => c.type === "tool-result") as unknown as {
			result: Record<string, unknown>;
		};
		expect(call).toMatchObject({
			toolName: "edit",
			input: JSON.stringify({
				filePath: "/a.ts",
				oldString: "const y = 2;",
				newString: "const y = 3;",
			}),
		});
		expect(result.result).toMatchObject({ metadata: { diff: EDIT_DIFF } });
	});
});

describe("native tool mapping (blocks)", () => {
	// Drive a single Cursor tool call+result through the stream and return the
	// emitted native tool-call/tool-result parts.
	async function mapTool(
		name: string,
		input: unknown,
		result: unknown,
		isError = false,
	): Promise<{ call: ToolCallPart; result: ToolResultPart }> {
		const parts = await collect(
			cursorEventsToStream(
				gen([
					{ type: "tool-call", id: "t1", name, input },
					{ type: "tool-result", id: "t1", name, result, isError },
					{ type: "finish" },
				]),
				"blocks",
			),
		);
		return { call: toolCalls(parts)[0]!, result: toolResults(parts)[0]! };
	}

	const foldedResult = (part: ToolResultPart) =>
		(part as unknown as { result: Record<string, unknown> }).result;

	it("maps Cursor `shell` onto opencode's `bash` tool", async () => {
		const { call, result } = await mapTool(
			"shell",
			{ command: "ls -a", workingDirectory: "/tmp" },
			{
				status: "success",
				value: {
					exitCode: 0,
					signal: "",
					stdout: "a\nb",
					stderr: "",
					executionTime: 5,
				},
			},
		);
		expect(call).toMatchObject({
			toolName: "bash",
			input: JSON.stringify({ command: "ls -a" }),
			providerExecuted: true,
			dynamic: true,
		});
		expect(result).toMatchObject({ toolName: "bash", isError: false });
		expect(foldedResult(result)).toMatchObject({
			title: "ls -a",
			metadata: { command: "ls -a", output: "a\nb" },
			output: "a\nb",
		});
	});

	it("includes stderr and a non-zero exit code in bash output", async () => {
		const { result } = await mapTool(
			"shell",
			{ command: "false" },
			{
				status: "success",
				value: {
					exitCode: 1,
					signal: "",
					stdout: "",
					stderr: "boom",
					executionTime: 1,
				},
			},
		);
		expect(foldedResult(result).output).toBe("boom\n(exit 1)");
	});

	it("maps Cursor `read` onto opencode's `read` tool (path → filePath)", async () => {
		const { call, result } = await mapTool(
			"read",
			{ path: "/a.ts" },
			{
				status: "success",
				value: { content: "l1\nl2", totalLines: 2, fileSize: 6 },
			},
		);
		expect(call).toMatchObject({
			toolName: "read",
			input: JSON.stringify({ filePath: "/a.ts" }),
		});
		expect(foldedResult(result)).toMatchObject({
			title: "/a.ts",
			output: "l1\nl2",
			metadata: { preview: "l1\nl2", totalLines: 2 },
		});
	});

	it("maps Cursor `write` onto opencode's `write` tool (renders the new content)", async () => {
		const { call, result } = await mapTool(
			"write",
			{ path: "/a.ts", fileText: "hello\nworld" },
			{
				status: "success",
				value: { path: "/a.ts", linesCreated: 2, fileSize: 11 },
			},
		);
		expect(call).toMatchObject({
			toolName: "write",
			input: JSON.stringify({ filePath: "/a.ts", content: "hello\nworld" }),
		});
		expect(foldedResult(result)).toMatchObject({
			title: "/a.ts",
			metadata: { filepath: "/a.ts" },
			output: "Wrote 2 lines.",
		});
	});

	it("maps Cursor `glob` onto opencode's `glob` tool", async () => {
		const { call, result } = await mapTool(
			"glob",
			{ globPattern: "**/*.ts", targetDirectory: "/src" },
			{
				status: "success",
				value: {
					files: ["/src/a.ts", "/src/b.ts"],
					totalFiles: 2,
					clientTruncated: false,
					ripgrepTruncated: false,
				},
			},
		);
		expect(call).toMatchObject({
			toolName: "glob",
			input: JSON.stringify({ pattern: "**/*.ts", path: "/src" }),
		});
		expect(foldedResult(result)).toMatchObject({
			metadata: { count: 2, truncated: false },
			output: "/src/a.ts\n/src/b.ts",
		});
	});

	it("maps Cursor `grep` onto opencode's `grep` tool (glob → include)", async () => {
		const { call, result } = await mapTool(
			"grep",
			{ pattern: "foo", path: "/src", glob: "*.ts" },
			{
				status: "success",
				value: {
					workspaceResults: {
						ws: {
							type: "content",
							output: {
								matches: [
									{ file: "/src/a.ts", lineNumber: 3, line: "const foo = 1" },
								],
								totalMatches: 1,
							},
						},
					},
				},
			},
		);
		expect(call).toMatchObject({
			toolName: "grep",
			input: JSON.stringify({ pattern: "foo", path: "/src", include: "*.ts" }),
		});
		expect(foldedResult(result)).toMatchObject({ metadata: { matches: 1 } });
		expect(foldedResult(result).output).toContain("/src/a.ts:");
		expect(foldedResult(result).output).toContain("Line 3: const foo = 1");
	});

	it("maps Cursor `ls` onto opencode's `list` tool (flattens the tree)", async () => {
		const { call, result } = await mapTool(
			"ls",
			{ path: "/src" },
			{
				status: "success",
				value: {
					directoryTreeRoot: {
						absPath: "/src",
						childrenFiles: [{ name: "a.ts" }],
						childrenDirs: [
							{
								absPath: "/src/sub",
								childrenFiles: [{ name: "b.ts" }],
								childrenDirs: [],
							},
						],
					},
				},
			},
		);
		expect(call).toMatchObject({
			toolName: "list",
			input: JSON.stringify({ path: "/src" }),
		});
		expect(foldedResult(result).output).toBe(
			"/src/a.ts\n/src/sub/\n/src/sub/b.ts",
		);
	});

	it("maps Cursor `updateTodos` onto opencode's `todowrite` (inProgress → in_progress)", async () => {
		const { call, result } = await mapTool(
			"updateTodos",
			{
				todos: [
					{ content: "a", status: "completed" },
					{ content: "b", status: "inProgress" },
					{ content: "c", status: "pending" },
				],
			},
			{ status: "success", value: {} },
		);
		const todos = [
			{ content: "a", status: "completed" },
			{ content: "b", status: "in_progress" },
			{ content: "c", status: "pending" },
		];
		expect(call).toMatchObject({
			toolName: "todowrite",
			input: JSON.stringify({ todos }),
		});
		expect(foldedResult(result)).toMatchObject({
			title: "1/3",
			metadata: { todos },
		});
	});

	it("falls back to a generic `cursor_shell` block when the result shape is unexpected", async () => {
		const { call, result } = await mapTool(
			"shell",
			{ command: "ls" },
			{ weird: 1 },
		);
		// Call is still emitted natively; only the result folding falls back.
		expect(call).toMatchObject({ toolName: "bash" });
		expect(result).toMatchObject({ toolName: "bash", isError: false });
		expect(foldedResult(result)).toEqual({ weird: 1 });
	});

	it("emits a native error result (matched name) when a mapped tool fails", async () => {
		const { call, result } = await mapTool(
			"read",
			{ path: "/missing" },
			{ status: "error", error: "ENOENT" },
			true,
		);
		// Name stays `read` so the call/result pair never dangles.
		expect(call).toMatchObject({ toolName: "read" });
		expect(result).toMatchObject({ toolName: "read", isError: true });
	});

	it("closes a dangling mapped call under its native name", async () => {
		const parts = await collect(
			cursorEventsToStream(
				gen([
					{
						type: "tool-call",
						id: "t1",
						name: "shell",
						input: { command: "ls" },
					},
					{ type: "finish" },
				]),
				"blocks",
			),
		);
		expect(toolResults(parts)[0]).toMatchObject({
			toolName: "bash",
			isError: true,
		});
	});

	it("maps Cursor `task` onto opencode's native `task` agent card", async () => {
		const { call, result } = await mapTool(
			"task",
			{
				description: "Investigate flake",
				prompt: "find the cause",
				subagentType: { kind: "agent", name: "explorer" },
			},
			{
				status: "success",
				value: { isBackground: false, resultSuffix: "done" },
			},
		);
		expect(call).toMatchObject({
			toolName: "task",
			input: JSON.stringify({
				description: "Investigate flake",
				subagent_type: "explorer",
			}),
		});
		expect(foldedResult(result)).toMatchObject({
			title: "Investigate flake",
			output: "done",
		});
	});

	it("flags a background `task` in metadata", async () => {
		const { result } = await mapTool(
			"task",
			{ description: "bg", prompt: "p" },
			{ status: "success", value: { isBackground: true } },
		);
		expect(foldedResult(result)).toMatchObject({
			metadata: { background: true },
			output: "Subagent task completed.",
		});
	});

	it("formats Cursor `readLints` as a `cursor_readLints` diagnostics list", async () => {
		const { call, result } = await mapTool(
			"readLints",
			{ paths: ["/a.ts"] },
			{
				status: "success",
				value: {
					fileDiagnostics: [
						{
							path: "/a.ts",
							diagnostics: [
								{
									severity: "error",
									range: { start: { line: 4, character: 2 } },
									message: "Unexpected any",
								},
							],
						},
					],
				},
			},
		);
		// No native lints tool — stays a prefixed block, but result is formatted.
		expect(call).toMatchObject({ toolName: "cursor_readLints" });
		expect(result).toMatchObject({ toolName: "cursor_readLints" });
		expect(foldedResult(result)).toMatchObject({
			title: "1 problem",
			metadata: { count: 1 },
		});
		// 1-based line/col, severity + message.
		expect(foldedResult(result).output).toBe(
			"/a.ts\n  error L5:3: Unexpected any",
		);
	});

	it("reports a clean message when `readLints` finds nothing", async () => {
		const { result } = await mapTool(
			"readLints",
			{ paths: ["/a.ts"] },
			{ status: "success", value: { fileDiagnostics: [] } },
		);
		expect(foldedResult(result)).toMatchObject({
			title: "No problems",
			output: "No problems found.",
		});
	});

	it("formats Cursor `delete` as a one-line `cursor_delete` confirmation", async () => {
		const { call, result } = await mapTool(
			"delete",
			{ path: "/tmp/x.txt" },
			{ status: "success", value: { fileSize: 128 } },
		);
		expect(call).toMatchObject({ toolName: "cursor_delete" });
		expect(foldedResult(result)).toMatchObject({
			title: "/tmp/x.txt",
			output: "Deleted /tmp/x.txt (128 bytes).",
		});
	});

	it("maps a Cursor MCP web search onto opencode's native `websearch`", async () => {
		const { call, result } = await mapTool(
			"exa/web_search_exa",
			{
				providerIdentifier: "exa",
				toolName: "web_search_exa",
				args: { query: "opencode plugins" },
			},
			{
				status: "success",
				value: {
					content: [
						{ text: { text: "Result one" } },
						{ text: { text: "Result two" } },
					],
				},
			},
		);
		expect(call).toMatchObject({
			toolName: "websearch",
			input: JSON.stringify({ query: "opencode plugins" }),
		});
		expect(foldedResult(result)).toMatchObject({
			metadata: { provider: "exa" },
			output: "Result one\nResult two",
		});
	});

	it("flattens a generic MCP result's `content` instead of dumping JSON", async () => {
		const { call, result } = await mapTool(
			"notion/search",
			{ providerIdentifier: "notion", toolName: "search", args: {} },
			{ status: "success", value: { content: [{ text: { text: "a page" } }] } },
		);
		// Stays a prefixed block (no native renderer), but output is readable text.
		expect(call).toMatchObject({ toolName: "cursor_notion_search" });
		expect(foldedResult(result)).toMatchObject({ output: "a page" });
	});
});

describe("mapUsage", () => {
	it("maps Cursor usage into the V3 nested shape", () => {
		expect(
			mapUsage({
				inputTokens: 100,
				outputTokens: 20,
				cacheReadTokens: 80,
				cacheWriteTokens: 5,
			}),
		).toEqual({
			inputTokens: {
				total: 100,
				noCache: undefined,
				cacheRead: 80,
				cacheWrite: 5,
			},
			outputTokens: { total: 20, text: undefined, reasoning: undefined },
		});
	});
});
