import { afterEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();

vi.mock("../src/cursor-runtime.js", () => ({
  loadCursorSdk: async () => ({ Agent: { create } }),
}));

const { runCloudAgent } = await import("../src/provider/cloud-agent.js");

type Update = { type: string } & Record<string, unknown>;

function fakeRun(result: unknown, statuses: string[]) {
  return {
    onDidChangeStatus: (fn: (s: string) => void) => {
      statuses.forEach(fn);
      return () => {};
    },
    cancel: vi.fn().mockResolvedValue(undefined),
    wait: async () => result,
  };
}

function fakeAgent(
  agentId: string,
  result: unknown,
  deltas: Update[],
  statuses: string[],
  steps: Array<{ type: string } & Record<string, unknown>> = [],
) {
  return {
    agentId,
    close: vi.fn(),
    send: async (
      _msg: unknown,
      opts: {
        onDelta?: (a: { update: Update }) => void;
        onStep?: (a: { step: { type: string } & Record<string, unknown> }) => void;
      },
    ) => {
      for (const update of deltas) await opts.onDelta?.({ update });
      for (const step of steps) await opts.onStep?.({ step });
      return fakeRun(result, statuses);
    },
  };
}

afterEach(() => create.mockReset());

describe("runCloudAgent", () => {
  it("builds cloud options, returns status/PR/progress, and closes the handle", async () => {
    const result = {
      id: "r1",
      status: "finished",
      result: "done",
      durationMs: 1234,
      git: {
        branches: [
          {
            repoUrl: "https://github.com/o/r",
            branch: "feat",
            prUrl: "https://github.com/o/r/pull/1",
          },
        ],
      },
    };
    const agent = fakeAgent(
      "bc-1",
      result,
      [{ type: "summary", summary: "did a thing" }],
      ["running", "finished"],
      [
        { type: "assistantMessage", message: { text: "hi" } },
        { type: "toolCall", message: { type: "shell" } },
      ],
    );
    create.mockResolvedValue(agent);

    const r = await runCloudAgent({
      apiKey: "k",
      prompt: "do it",
      repoUrl: "https://github.com/o/r",
      autoCreatePR: true,
    });

    const opts = create.mock.calls[0]![0] as any;
    expect(opts.cloud.repos).toEqual([{ url: "https://github.com/o/r" }]);
    expect(opts.cloud.autoCreatePR).toBe(true);
    expect(opts.apiKey).toBe("k");

    expect(r.agentId).toBe("bc-1");
    expect(r.status).toBe("finished");
    expect(r.prUrl).toBe("https://github.com/o/r/pull/1");
    expect(r.durationMs).toBe(1234);
    expect(r.branches).toEqual([
      { repoUrl: "https://github.com/o/r", branch: "feat", prUrl: "https://github.com/o/r/pull/1" },
    ]);
    expect(r.progress).toContain("summary: did a thing");
    expect(r.progress).toContain("step: assistantMessage");
    expect(r.progress).toContain("step: toolCall:shell");
    expect(r.progress).toContain("status: finished");
    expect(agent.close).toHaveBeenCalled();
  });

  it("passes startingRef and a thinking model selection", async () => {
    create.mockResolvedValue(fakeAgent("bc-2", { id: "r", status: "finished" }, [], []));

    const r = await runCloudAgent({
      apiKey: "k",
      prompt: "x",
      repoUrl: "https://github.com/o/r",
      startingRef: "main",
      model: "gpt-5",
      thinking: "high",
    });

    const opts = create.mock.calls[0]![0] as any;
    expect(opts.cloud.repos).toEqual([{ url: "https://github.com/o/r", startingRef: "main" }]);
    expect(opts.model).toEqual({ id: "gpt-5", params: [{ id: "thinking", value: "high" }] });
    expect(r.prUrl).toBeUndefined();
    expect(r.branches).toEqual([]);
  });

  it("passes workOnCurrentBranch and autoCreatePR:false through to cloud options", async () => {
    create.mockResolvedValue(fakeAgent("bc-3", { id: "r", status: "finished" }, [], []));

    await runCloudAgent({
      apiKey: "k",
      prompt: "x",
      repoUrl: "https://github.com/o/r",
      autoCreatePR: false,
      workOnCurrentBranch: true,
    });

    const opts = create.mock.calls[0]![0] as any;
    expect(opts.cloud.autoCreatePR).toBe(false);
    expect(opts.cloud.workOnCurrentBranch).toBe(true);
  });

  it("passes through a non-finished terminal status (error/cancelled)", async () => {
    create.mockResolvedValue(
      fakeAgent("bc-4", { id: "r", status: "error", result: "boom" }, [], ["running", "error"]),
    );

    const r = await runCloudAgent({
      apiKey: "k",
      prompt: "x",
      repoUrl: "https://github.com/o/r",
    });

    expect(r.status).toBe("error");
    expect(r.result).toBe("boom");
    expect(r.prUrl).toBeUndefined();
    expect(r.branches).toEqual([]);
    expect(r.progress).toContain("status: error");
  });

  it("closes the agent and propagates when run.wait() rejects", async () => {
    const close = vi.fn();
    create.mockResolvedValue({
      agentId: "bc-5",
      close,
      send: async () => ({
        onDidChangeStatus: () => () => {},
        cancel: vi.fn().mockResolvedValue(undefined),
        wait: async () => {
          throw new Error("run blew up");
        },
      }),
    });

    await expect(
      runCloudAgent({ apiKey: "k", prompt: "x", repoUrl: "https://github.com/o/r" }),
    ).rejects.toThrow("run blew up");
    expect(close).toHaveBeenCalled();
  });

  it("cancels the run when the abort signal fires", async () => {
    const controller = new AbortController();
    const cancel = vi.fn().mockResolvedValue(undefined);
    let resolveWait: (v: unknown) => void;
    const waitP = new Promise((res) => {
      resolveWait = res;
    });
    create.mockResolvedValue({
      agentId: "bc-6",
      close: vi.fn(),
      send: async () => ({
        onDidChangeStatus: () => () => {},
        cancel: () => {
          cancel();
          // Resolve wait once cancelled so the run can settle.
          resolveWait({ id: "r", status: "cancelled" });
          return Promise.resolve();
        },
        // Aborting here guarantees the abort listener is already attached.
        wait: () => {
          controller.abort();
          return waitP;
        },
      }),
    });

    const r = await runCloudAgent({
      apiKey: "k",
      prompt: "x",
      repoUrl: "https://github.com/o/r",
      abortSignal: controller.signal,
    });

    expect(cancel).toHaveBeenCalled();
    expect(r.status).toBe("cancelled");
  });

  it("works on hosts whose run has no onDidChangeStatus", async () => {
    create.mockResolvedValue({
      agentId: "bc-7",
      close: vi.fn(),
      send: async (_m: unknown, opts: { onDelta?: (a: { update: Update }) => void }) => {
        await opts.onDelta?.({ update: { type: "summary", summary: "only deltas" } });
        return {
          // no onDidChangeStatus
          cancel: vi.fn().mockResolvedValue(undefined),
          wait: async () => ({ id: "r", status: "finished" }),
        };
      },
    });

    const r = await runCloudAgent({ apiKey: "k", prompt: "x", repoUrl: "https://github.com/o/r" });
    expect(r.status).toBe("finished");
    expect(r.progress).toContain("summary: only deltas");
  });
});
