import { afterEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const resume = vi.fn();

vi.mock("../src/cursor-runtime.js", () => ({
  loadCursorSdk: async () => ({ Agent: { create, resume } }),
}));

const { runDelegate } = await import("../src/provider/delegate.js");

type Update = { type: string } & Record<string, unknown>;

function fakeAgent(agentId: string, deltas: Update[], result: unknown) {
  return {
    agentId,
    close: vi.fn(),
    send: async (_msg: unknown, opts: { onDelta?: (a: { update: Update }) => void }) => {
      for (const update of deltas) await opts.onDelta?.({ update });
      return { cancel: vi.fn().mockResolvedValue(undefined), wait: async () => result };
    },
  };
}

const deltas: Update[] = [
  { type: "text-delta", text: "Hel" },
  { type: "text-delta", text: "lo" },
  { type: "thinking-delta", text: "hmm" },
  { type: "tool-call-started", callId: "1", toolCall: { type: "read", args: {} } },
  { type: "tool-call-completed", callId: "1", toolCall: { type: "read", result: { status: "success" } } },
  {
    type: "turn-ended",
    usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
];

afterEach(() => {
  create.mockReset();
  resume.mockReset();
});

describe("runDelegate", () => {
  it("aggregates text, reasoning, tool activity, and usage from a fresh agent", async () => {
    create.mockResolvedValue(fakeAgent("a1", deltas, { status: "finished", result: "Hello" }));

    const r = await runDelegate({ apiKey: "k", prompt: "do", model: "m", cwd: "/tmp" });

    expect(create).toHaveBeenCalledOnce();
    expect(r.agentId).toBe("a1");
    expect(r.text).toBe("Hello");
    expect(r.reasoning).toBe("hmm");
    expect(r.toolActivity).toEqual([{ name: "read", isError: false }]);
    expect(r.usage).toEqual({
      inputTokens: 5,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const opts = create.mock.calls[0]![0] as any;
    expect(opts.model).toEqual({ id: "m" });
    expect(opts.mode).toBe("agent");
  });

  it("resumes an explicit agentId instead of creating", async () => {
    resume.mockResolvedValue(fakeAgent("keep", [], { status: "finished", result: "ok" }));

    const r = await runDelegate({
      apiKey: "k",
      prompt: "do",
      model: "m",
      cwd: "/tmp",
      agentId: "keep",
    });

    expect(resume).toHaveBeenCalledWith("keep", expect.anything());
    expect(create).not.toHaveBeenCalled();
    expect(r.agentId).toBe("keep");
    expect(r.text).toBe("ok");
  });

  it("maps the thinking convenience into a model param and plan mode", async () => {
    create.mockResolvedValue(fakeAgent("a2", [], { status: "finished", result: "" }));

    await runDelegate({
      apiKey: "k",
      prompt: "do",
      model: "m",
      cwd: "/tmp",
      mode: "plan",
      thinking: "high",
    });

    const opts = create.mock.calls[0]![0] as any;
    expect(opts.mode).toBe("plan");
    expect(opts.model).toEqual({ id: "m", params: [{ id: "thinking", value: "high" }] });
  });

  it("flags failed tool calls and does not double-count successful ones", async () => {
    const mixed: Update[] = [
      { type: "tool-call-started", callId: "1", toolCall: { type: "read", args: {} } },
      {
        type: "tool-call-completed",
        callId: "1",
        toolCall: { type: "read", result: { status: "success" } },
      },
      { type: "tool-call-started", callId: "2", toolCall: { type: "write", args: {} } },
      {
        type: "tool-call-completed",
        callId: "2",
        toolCall: { type: "write", result: { status: "error" } },
      },
    ];
    create.mockResolvedValue(fakeAgent("a3", mixed, { status: "finished", result: "ok" }));

    const r = await runDelegate({ apiKey: "k", prompt: "do", model: "m", cwd: "/tmp" });

    // read+write yield two tool-call entries; the failed write adds one more isError entry.
    expect(r.toolActivity).toEqual([
      { name: "read", isError: false },
      { name: "write", isError: false },
      { name: "write", isError: true },
    ]);
  });

  it("falls back to the finish result text when no text deltas were emitted", async () => {
    create.mockResolvedValue(
      fakeAgent("a4", [{ type: "thinking-delta", text: "thinking only" }], {
        status: "finished",
        result: "final answer",
      }),
    );

    const r = await runDelegate({ apiKey: "k", prompt: "do", model: "m", cwd: "/tmp" });
    expect(r.text).toBe("final answer");
    expect(r.reasoning).toBe("thinking only");
  });

  it("releases the agent and propagates when the turn fails", async () => {
    const close = vi.fn();
    create.mockResolvedValue({
      agentId: "a5",
      close,
      send: async () => {
        throw new Error("send failed");
      },
    });

    await expect(
      runDelegate({ apiKey: "k", prompt: "do", model: "m", cwd: "/tmp" }),
    ).rejects.toThrow("send failed");
    // Non-pooled (session:false) agents must be closed by release() even on failure.
    expect(close).toHaveBeenCalled();
  });
});
