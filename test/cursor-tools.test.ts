import { afterEach, describe, expect, it, vi } from "vitest";

const runCloudAgent = vi.fn();
const runDelegate = vi.fn();

vi.mock("../src/provider/cloud-agent.js", () => ({ runCloudAgent }));
vi.mock("../src/provider/delegate.js", () => ({ runDelegate }));

const { buildCursorTools } = await import("../src/plugin/cursor-tools.js");

function ctx(ask: ReturnType<typeof vi.fn>) {
  return {
    ask,
    abort: new AbortController().signal,
    directory: "/work",
    worktree: "/work",
    sessionID: "s",
    messageID: "m",
    agent: "a",
    metadata: vi.fn(),
  } as any;
}

const withKey = { resolveApiKey: () => "k", defaultCwd: () => "/work" };
const noKey = { resolveApiKey: () => undefined, defaultCwd: () => "/work" };

afterEach(() => {
  runCloudAgent.mockReset();
  runDelegate.mockReset();
});

describe("buildCursorTools", () => {
  it("returns a needs-auth message when no API key is available", async () => {
    const tools = buildCursorTools(noKey);
    const out = await tools.cursor_delegate!.execute(
      { prompt: "p", model: "m" } as any,
      ctx(vi.fn().mockResolvedValue(undefined)),
    );
    expect(String(out)).toContain("No Cursor API key");
    expect(runDelegate).not.toHaveBeenCalled();
  });

  it("runs the cloud agent after approval and surfaces the PR url", async () => {
    runCloudAgent.mockResolvedValue({
      agentId: "bc-1",
      status: "finished",
      result: "done",
      prUrl: "https://github.com/o/r/pull/1",
      branches: [{ repoUrl: "https://github.com/o/r", branch: "feat" }],
      durationMs: 10,
      progress: ["status: finished"],
    });
    const ask = vi.fn().mockResolvedValue(undefined);
    const tools = buildCursorTools(withKey);

    const out = (await tools.cursor_cloud_agent!.execute(
      { prompt: "p", repoUrl: "https://github.com/o/r", autoCreatePR: true } as any,
      ctx(ask),
    )) as { output: string; metadata: Record<string, unknown> };

    expect(ask).toHaveBeenCalledOnce();
    const callArgs = runCloudAgent.mock.calls[0]![0];
    expect(callArgs.apiKey).toBe("k");
    expect(callArgs.abortSignal).toBeDefined();
    expect(out.output).toContain("PR: https://github.com/o/r/pull/1");
    expect(out.metadata.agentId).toBe("bc-1");
  });

  it("blocks delegation when the permission gate denies it", async () => {
    const ask = vi.fn().mockRejectedValue(new Error("denied"));
    const tools = buildCursorTools(withKey);

    const out = await tools.cursor_delegate!.execute(
      { prompt: "p", model: "m" } as any,
      ctx(ask),
    );

    expect(String(out)).toContain("not approved");
    expect(String(out)).toContain("denied");
    expect(runDelegate).not.toHaveBeenCalled();
  });

  it("delegates after approval and returns the agent text", async () => {
    runDelegate.mockResolvedValue({
      agentId: "a1",
      text: "result text",
      reasoning: "",
      toolActivity: [{ name: "read", isError: false }],
      usage: undefined,
    });
    const ask = vi.fn().mockResolvedValue(undefined);
    const tools = buildCursorTools(withKey);

    const out = (await tools.cursor_delegate!.execute(
      { prompt: "p", model: "m", thinking: "high" } as any,
      ctx(ask),
    )) as { output: string; metadata: Record<string, unknown> };

    const callArgs = runDelegate.mock.calls[0]![0];
    expect(callArgs).toMatchObject({ apiKey: "k", model: "m", thinking: "high", cwd: "/work" });
    expect(callArgs.abortSignal).toBeDefined();
    expect(out.output).toContain("result text");
    expect(out.output).toContain("1 tool call");
    expect(out.metadata.agentId).toBe("a1");
  });

  it("returns needs-auth for the cloud agent tool when no API key is available", async () => {
    const tools = buildCursorTools(noKey);
    const out = await tools.cursor_cloud_agent!.execute(
      { prompt: "p", repoUrl: "https://github.com/o/r" } as any,
      ctx(vi.fn().mockResolvedValue(undefined)),
    );
    expect(String(out)).toContain("No Cursor API key");
    expect(runCloudAgent).not.toHaveBeenCalled();
  });

  it("blocks the cloud agent when the permission gate denies it", async () => {
    const ask = vi.fn().mockRejectedValue(new Error("denied"));
    const tools = buildCursorTools(withKey);

    const out = await tools.cursor_cloud_agent!.execute(
      { prompt: "p", repoUrl: "https://github.com/o/r" } as any,
      ctx(ask),
    );

    expect(String(out)).toContain("not approved");
    expect(String(out)).toContain("denied");
    expect(runCloudAgent).not.toHaveBeenCalled();
  });

  it("fails closed when the host does not expose context.ask", async () => {
    const tools = buildCursorTools(withKey);
    // context with no `ask` function (e.g. an unexpected/older host).
    const context = {
      abort: new AbortController().signal,
      directory: "/work",
      worktree: "/work",
      sessionID: "s",
      messageID: "m",
      agent: "a",
      metadata: vi.fn(),
    } as any;

    const out = await tools.cursor_delegate!.execute({ prompt: "p", model: "m" } as any, context);

    // No silent allow: a missing gate blocks rather than running unsupervised.
    expect(String(out)).toContain("not approved");
    expect(runDelegate).not.toHaveBeenCalled();
  });

  it("renders '(no text output)' and a failed-tool note for an empty delegate result", async () => {
    runDelegate.mockResolvedValue({
      agentId: "a9",
      text: "",
      reasoning: "",
      toolActivity: [
        { name: "read", isError: false },
        { name: "write", isError: true },
      ],
      usage: undefined,
    });
    const tools = buildCursorTools(withKey);

    const out = (await tools.cursor_delegate!.execute(
      { prompt: "p", model: "m" } as any,
      ctx(vi.fn().mockResolvedValue(undefined)),
    )) as { output: string; metadata: Record<string, unknown> };

    expect(out.output).toContain("(no text output)");
    expect(out.output).toContain("2 tool call(s)");
    expect(out.output).toContain("some failed");
    expect(out.metadata.toolCalls).toBe(2);
  });

  it("resolves cwd from args > context.directory > defaultCwd for delegation", async () => {
    runDelegate.mockResolvedValue({
      agentId: "a1",
      text: "x",
      reasoning: "",
      toolActivity: [],
      usage: undefined,
    });
    const tools = buildCursorTools(withKey);

    await tools.cursor_delegate!.execute(
      { prompt: "p", model: "m", cwd: "/explicit" } as any,
      ctx(vi.fn().mockResolvedValue(undefined)),
    );
    expect(runDelegate.mock.calls[0]![0].cwd).toBe("/explicit");
  });

  it("formats the cloud output with branches and progress when no PR is opened", async () => {
    runCloudAgent.mockResolvedValue({
      agentId: "bc-9",
      status: "finished",
      result: "summary text",
      prUrl: undefined,
      branches: [{ repoUrl: "https://github.com/o/r", branch: "feat-x" }],
      durationMs: 5,
      progress: ["status: running", "status: finished"],
    });
    const tools = buildCursorTools(withKey);

    const out = (await tools.cursor_cloud_agent!.execute(
      { prompt: "p", repoUrl: "https://github.com/o/r" } as any,
      ctx(vi.fn().mockResolvedValue(undefined)),
    )) as { output: string; metadata: Record<string, unknown> };

    expect(out.output).not.toContain("PR:");
    expect(out.output).toContain("Branches: feat-x");
    expect(out.output).toContain("Progress:");
    expect(out.output).toContain("status: finished");
    expect(out.output).toContain("summary text");
    expect(out.metadata.prUrl).toBeNull();
  });

  it("returns a sanitized failure (not a throw) when the cloud run errors", async () => {
    runCloudAgent.mockRejectedValue(new Error("network down"));
    const tools = buildCursorTools(withKey);

    const out = await tools.cursor_cloud_agent!.execute(
      { prompt: "p", repoUrl: "https://github.com/o/r" } as any,
      ctx(vi.fn().mockResolvedValue(undefined)),
    );

    expect(String(out)).toContain("Cloud agent failed");
    expect(String(out)).toContain("network down");
  });

  it("returns a sanitized failure (not a throw) when delegation errors", async () => {
    runDelegate.mockRejectedValue(new Error("agent crashed"));
    const tools = buildCursorTools(withKey);

    const out = await tools.cursor_delegate!.execute(
      { prompt: "p", model: "m" } as any,
      ctx(vi.fn().mockResolvedValue(undefined)),
    );

    expect(String(out)).toContain("Delegation failed");
    expect(String(out)).toContain("agent crashed");
  });
});
