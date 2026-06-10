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

async function* genThenThrow(events: CursorEvent[], err: unknown): AsyncGenerator<CursorEvent> {
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
  { type: "usage", usage: { inputTokens: 10251, outputTokens: 46, cacheReadTokens: 7412, cacheWriteTokens: 0 } },
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
      .filter((p): p is Extract<LanguageModelV3StreamPart, { type: "text-delta" }> => p.type === "text-delta")
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
      .filter((p): p is Extract<LanguageModelV3StreamPart, { type: "text-start" }> => p.type === "text-start")
      .map((p) => p.id);
    expect(new Set(textStartIds).size).toBe(2);

    // Each delta belongs to the part that was open at the time.
    const deltas = parts.filter(
      (p): p is Extract<LanguageModelV3StreamPart, { type: "text-delta" }> => p.type === "text-delta",
    );
    expect(deltas[0]!.id).toBe(textStartIds[0]);
    expect(deltas[1]!.id).toBe(textStartIds[1]);
  });

  it("renders Cursor's own tool activity as reasoning, not tool-call parts", async () => {
    const events: CursorEvent[] = [
      { type: "tool-call", id: "c1", name: "write", input: { path: "a.txt" } },
      { type: "tool-result", id: "c1", name: "write", result: { ok: true }, isError: false },
      { type: "tool-call", id: "c2", name: "serena/find_symbol", input: {} },
      { type: "tool-result", id: "c2", name: "serena/find_symbol", result: { e: 1 }, isError: true },
      { type: "text-delta", text: "done" },
      { type: "finish" },
    ];
    const parts = await collect(cursorEventsToStream(gen(events)));

    // No tool-call/tool-result parts cross into opencode (avoids "unavailable tool").
    expect(types(parts)).not.toContain("tool-call");
    expect(types(parts)).not.toContain("tool-result");

    const reasoning = parts
      .filter((p): p is Extract<LanguageModelV3StreamPart, { type: "reasoning-delta" }> => p.type === "reasoning-delta")
      .map((p) => p.delta)
      .join("");
    expect(reasoning).toContain("[tool] write");
    expect(reasoning).toContain('{"path":"a.txt"}');
    // A failed tool surfaces its failure; a successful one does not add a status line.
    expect(reasoning).toContain("[tool] serena/find_symbol failed");
    expect(reasoning).not.toContain("write failed");

    // The final answer text is unpolluted by tool noise.
    const text = parts
      .filter((p): p is Extract<LanguageModelV3StreamPart, { type: "text-delta" }> => p.type === "text-delta")
      .map((p) => p.delta)
      .join("");
    expect(text).toBe("done");
  });

  it("emits structured provider-executed tool-call/tool-result parts in 'blocks' mode", async () => {
    const events: CursorEvent[] = [
      { type: "tool-call", id: "c1", name: "shell", input: { command: "ls" } },
      { type: "tool-result", id: "c1", name: "shell", result: { stdout: "a\nb" }, isError: false },
      { type: "tool-call", id: "c2", name: "serena/find_symbol", input: { q: "x" } },
      { type: "tool-result", id: "c2", name: "serena/find_symbol", result: { err: "no" }, isError: true },
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
      (p): p is Extract<LanguageModelV3StreamPart, { type: "tool-call" }> => p.type === "tool-call",
    )!;
    expect(call).toMatchObject({
      toolCallId: "c1",
      toolName: "cursor_shell",
      input: JSON.stringify({ command: "ls" }),
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
      toolName: "cursor_shell",
      providerExecuted: true,
      dynamic: true,
      result: { stdout: "a\nb" },
      isError: false,
    });
    expect(results[1]).toMatchObject({
      toolCallId: "c2",
      toolName: "cursor_serena_find_symbol",
      result: { err: "no" },
      isError: true,
    });

    const text = parts
      .filter((p): p is Extract<LanguageModelV3StreamPart, { type: "text-delta" }> => p.type === "text-delta")
      .map((p) => p.delta)
      .join("");
    expect(text).toBe("done");
  });

  it("synthesizes an error tool-result for a dangling tool-call in 'blocks' mode", async () => {
    // A run that dies mid-tool emits tool-call-started but never -completed.
    // Without a matching tool-result, opencode renders "Tool execution aborted".
    const events: CursorEvent[] = [
      { type: "tool-call", id: "c1", name: "shell", input: { command: "ls" } },
      { type: "finish" },
    ];
    const parts = await collect(cursorEventsToStream(gen(events), "blocks"));

    const result = parts.find((p) => p.type === "tool-result") as Record<string, unknown>;
    expect(result).toMatchObject({
      toolCallId: "c1",
      toolName: "cursor_shell",
      isError: true,
      providerExecuted: true,
      dynamic: true,
    });
    // Synthetic result arrives before finish so the part is never dangling.
    expect(types(parts).indexOf("tool-result")).toBeLessThan(types(parts).indexOf("finish"));
  });

  it("synthesizes error tool-results for dangling calls when the source throws", async () => {
    const events: CursorEvent[] = [
      { type: "tool-call", id: "c1", name: "read", input: { path: "x" } },
    ];
    const parts = await collect(
      cursorEventsToStream(genThenThrow(events, new Error("run died")), "blocks"),
    );
    const result = parts.find((p) => p.type === "tool-result") as Record<string, unknown>;
    expect(result).toMatchObject({ toolCallId: "c1", toolName: "cursor_read", isError: true });
    const finish = parts.find((p) => p.type === "finish");
    expect(finish).toMatchObject({ finishReason: { unified: "error" } });
  });

  it("does not synthesize results for tool calls that completed", async () => {
    const events: CursorEvent[] = [
      { type: "tool-call", id: "c1", name: "shell", input: {} },
      { type: "tool-result", id: "c1", name: "shell", result: { ok: 1 }, isError: false },
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
    expect(types(parts)).toEqual(["stream-start", "text-start", "text-delta", "text-end", "finish"]);
    const delta = parts.find((p) => p.type === "text-delta");
    expect(delta).toMatchObject({ delta: "final answer" });
  });

  it("emits an error part and an error finish when the source throws", async () => {
    const boom = new Error("agent exploded");
    const parts = await collect(
      cursorEventsToStream(genThenThrow([{ type: "text-delta", text: "partial" }], boom)),
    );
    const error = parts.find((p) => p.type === "error");
    expect(error).toMatchObject({ error: boom });
    // text block that was opened still gets closed
    expect(types(parts)).toContain("text-end");
    const finish = parts.find((p) => p.type === "finish");
    expect(finish).toMatchObject({ finishReason: { unified: "error" } });
  });

  it("uses empty usage when no usage event arrives", async () => {
    const parts = await collect(cursorEventsToStream(gen([{ type: "text-delta", text: "hi" }, { type: "finish" }])));
    const finish = parts.find((p) => p.type === "finish");
    expect(finish).toMatchObject({
      usage: { inputTokens: { total: undefined }, outputTokens: { total: undefined } },
    });
  });
});

describe("cursorEventsToContent (doGenerate)", () => {
  it("aggregates reasoning, text, and tool activity with usage", async () => {
    const { content, finishReason, usage } = await cursorEventsToContent(gen(LIVE_SEQUENCE));
    expect(finishReason).toMatchObject({ unified: "stop" });
    expect(usage).toMatchObject({ inputTokens: { total: 10251 }, outputTokens: { total: 46 } });
    // reasoning first, then text
    expect(content[0]).toMatchObject({ type: "reasoning", text: "thinking" });
    expect(content.at(-1)).toMatchObject({ type: "text", text: "PONG" });
  });

  it("folds tool activity into reasoning content", async () => {
    const { content } = await cursorEventsToContent(
      gen([
        { type: "tool-call", id: "c1", name: "read", input: { path: "x" } },
        { type: "text-delta", text: "ok" },
        { type: "finish" },
      ]),
    );
    const reasoning = content.find((c) => c.type === "reasoning");
    expect(reasoning).toMatchObject({ type: "reasoning" });
    expect((reasoning as { text: string }).text).toContain("[tool] read");
  });

  it("emits tool-call/tool-result content items in 'blocks' mode", async () => {
    const { content } = await cursorEventsToContent(
      gen([
        { type: "tool-call", id: "c1", name: "read", input: { path: "x" } },
        { type: "tool-result", id: "c1", name: "read", result: { data: "hi" }, isError: false },
        { type: "text-delta", text: "ok" },
        { type: "finish" },
      ]),
      "blocks",
    );
    const callItem = content.find((c) => c.type === "tool-call");
    expect(callItem).toMatchObject({
      toolCallId: "c1",
      toolName: "cursor_read",
      providerExecuted: true,
      dynamic: true,
    });
    const resultItem = content.find((c) => c.type === "tool-result") as Record<string, unknown>;
    expect(resultItem).toMatchObject({ result: { data: "hi" }, isError: false });
    expect(content.find((c) => c.type === "reasoning")).toBeUndefined();
    expect(content.at(-1)).toMatchObject({ type: "text", text: "ok" });
  });

  it("synthesizes an error tool-result content item for a dangling call in 'blocks' mode", async () => {
    const { content } = await cursorEventsToContent(
      gen([
        { type: "tool-call", id: "c1", name: "shell", input: {} },
        { type: "finish" },
      ]),
      "blocks",
    );
    const resultItem = content.find((c) => c.type === "tool-result") as Record<string, unknown>;
    expect(resultItem).toMatchObject({ toolCallId: "c1", toolName: "cursor_shell", isError: true });
  });

  it("reports finishReason 'error' when the source throws", async () => {
    const { finishReason } = await cursorEventsToContent(
      genThenThrow([{ type: "text-delta", text: "x" }], new Error("nope")),
    );
    expect(finishReason).toMatchObject({ unified: "error" });
  });
});

describe("mapUsage", () => {
  it("maps Cursor usage into the V3 nested shape", () => {
    expect(mapUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 5 })).toEqual({
      inputTokens: { total: 100, noCache: undefined, cacheRead: 80, cacheWrite: 5 },
      outputTokens: { total: 20, text: undefined, reasoning: undefined },
    });
  });
});
