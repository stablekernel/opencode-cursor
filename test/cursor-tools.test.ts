import { afterEach, describe, expect, it, vi } from "vitest";

const runCloudAgent = vi.fn();

vi.mock("../src/provider/cloud-agent.js", () => ({ runCloudAgent }));

const { buildCursorTools } = await import("../src/plugin/cursor-tools.js");

function ctx(ask: ReturnType<typeof vi.fn>, controller = new AbortController()) {
  return {
    ask,
    abort: controller.signal,
    directory: "/work",
    worktree: "/work",
    sessionID: "parent-1",
    messageID: "m",
    agent: "a",
    metadata: vi.fn(),
  } as any;
}

function childClient() {
  return {
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: "child-1" } }),
      prompt: vi.fn().mockResolvedValue({
        data: {
          info: {
            tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 0, write: 0 } },
          },
          parts: [{ type: "text", text: "child result" }],
        },
      }),
      abort: vi.fn().mockResolvedValue({ data: {} }),
      delete: vi.fn().mockResolvedValue({ data: {} }),
    },
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    resolveApiKey: () => "k",
    defaultCwd: () => "/work",
    client: childClient(),
    setDelegateControls: vi.fn(),
    clearDelegateControls: vi.fn(),
    ...overrides,
  } as any;
}

afterEach(() => {
  runCloudAgent.mockReset();
});

describe("buildCursorTools", () => {
  it("returns a needs-auth message when no API key is available", async () => {
    const dependency = deps({ resolveApiKey: () => undefined });
    const tools = buildCursorTools(dependency);
    const out = await tools.cursor_delegate!.execute(
      { prompt: "p", model: "m" } as any,
      ctx(vi.fn().mockResolvedValue(undefined)),
    );
    expect(String(out)).toContain("No Cursor API key");
    expect(dependency.client.session.create).not.toHaveBeenCalled();
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
    const tools = buildCursorTools(deps());

    const out = (await tools.cursor_cloud_agent!.execute(
      { prompt: "p", repoUrl: "https://github.com/o/r", autoCreatePR: true } as any,
      ctx(ask),
    )) as { output: string; metadata: Record<string, unknown> };

    expect(ask).toHaveBeenCalledOnce();
    expect(runCloudAgent.mock.calls[0]![0].apiKey).toBe("k");
    expect(out.output).toContain("PR: https://github.com/o/r/pull/1");
    expect(out.metadata.agentId).toBe("bc-1");
  });

  it("blocks delegation when the permission gate denies it", async () => {
    const dependency = deps();
    const tools = buildCursorTools(dependency);
    const out = await tools.cursor_delegate!.execute(
      { prompt: "p", model: "m" } as any,
      ctx(vi.fn().mockRejectedValue(new Error("denied"))),
    );

    expect(String(out)).toContain("not approved");
    expect(String(out)).toContain("denied");
    expect(dependency.client.session.create).not.toHaveBeenCalled();
  });

  it("creates and prompts a parent-linked Cursor child session", async () => {
    const dependency = deps();
    const tools = buildCursorTools(dependency);

    const out = (await tools.cursor_delegate!.execute(
      { prompt: "inspect files", model: "composer-2.5", mode: "plan", thinking: "high" } as any,
      ctx(vi.fn().mockResolvedValue(undefined)),
    )) as { output: string; metadata: Record<string, unknown> };

    expect(dependency.client.session.create).toHaveBeenCalledWith({
      body: { parentID: "parent-1", title: "Cursor delegate: inspect files" },
      query: { directory: "/work" },
    });
    expect(dependency.client.session.prompt).toHaveBeenCalledWith({
      path: { id: "child-1" },
      query: { directory: "/work" },
      body: {
        model: { providerID: "cursor", modelID: "composer-2.5" },
        agent: "plan",
        tools: { cursor_delegate: false },
        parts: [{ type: "text", text: "inspect files" }],
      },
    });
    expect(dependency.setDelegateControls).toHaveBeenCalledWith("child-1", {
      mode: "plan",
      cwd: "/work",
      thinking: "high",
    });
    expect(dependency.clearDelegateControls).toHaveBeenCalledWith("child-1");
    expect(out.output).toBe("child result");
    expect(out.metadata).toMatchObject({
      childSessionID: "child-1",
      model: "composer-2.5",
      status: "finished",
    });
  });

  it("forwards cwd, sandbox, and agentId into the child controls", async () => {
    const dependency = deps();
    const tools = buildCursorTools(dependency);

    await tools.cursor_delegate!.execute(
      {
        prompt: "p",
        model: "m",
        cwd: "/explicit",
        sandbox: true,
        agentId: "cursor-agent",
      } as any,
      ctx(vi.fn().mockResolvedValue(undefined)),
    );

    expect(dependency.client.session.create).toHaveBeenCalledWith({
      body: { parentID: "parent-1", title: "Cursor delegate: p" },
      query: { directory: "/explicit" },
    });
    expect(dependency.setDelegateControls).toHaveBeenCalledWith("child-1", {
      mode: "agent",
      cwd: "/explicit",
      sandbox: true,
      agentId: "cursor-agent",
    });
  });

  it("returns a sanitized failure when the child prompt errors", async () => {
    const dependency = deps();
    dependency.client.session.prompt.mockRejectedValue(new Error("agent crashed"));
    const tools = buildCursorTools(dependency);

    const out = await tools.cursor_delegate!.execute(
      { prompt: "p", model: "m" } as any,
      ctx(vi.fn().mockResolvedValue(undefined)),
    );

    expect(String(out)).toContain("Delegation failed");
    expect(String(out)).toContain("agent crashed");
    expect(dependency.clearDelegateControls).toHaveBeenCalledWith("child-1");
  });

  it("aborts the child session when the tool aborts", async () => {
    const dependency = deps();
    let resolvePrompt!: (value: unknown) => void;
    dependency.client.session.prompt.mockReturnValue(
      new Promise((resolve) => {
        resolvePrompt = resolve;
      }),
    );
    const controller = new AbortController();
    const tools = buildCursorTools(dependency);
    const pending = tools.cursor_delegate!.execute(
      { prompt: "p", model: "m" } as any,
      ctx(vi.fn().mockResolvedValue(undefined), controller),
    );

    await vi.waitFor(() => expect(dependency.client.session.prompt).toHaveBeenCalled());
    controller.abort();
    await vi.waitFor(() =>
      expect(dependency.client.session.abort).toHaveBeenCalledWith({
        path: { id: "child-1" },
        query: { directory: "/work" },
      }),
    );
    resolvePrompt({ data: { info: {}, parts: [{ type: "text", text: "done" }] } });
    expect(String(await pending)).toContain("Delegation failed");
  });

  it("deletes a child session created after the tool has aborted", async () => {
    const dependency = deps();
    let resolveCreate!: (value: unknown) => void;
    dependency.client.session.create.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const controller = new AbortController();
    const tools = buildCursorTools(dependency);
    const pending = tools.cursor_delegate!.execute(
      { prompt: "p", model: "m" } as any,
      ctx(vi.fn().mockResolvedValue(undefined), controller),
    );

    await vi.waitFor(() => expect(dependency.client.session.create).toHaveBeenCalled());
    controller.abort();
    // The child resolves only after abort won the race. It was never prompted,
    // so it must be deleted (not aborted) to avoid an empty orphan session.
    resolveCreate({ data: { id: "late-child" } });

    const out = await pending;
    expect(String(out)).toContain("Delegation failed");
    expect(dependency.client.session.prompt).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(dependency.client.session.delete).toHaveBeenCalledWith({
        path: { id: "late-child" },
        query: { directory: "/work" },
      }),
    );
    expect(dependency.client.session.abort).not.toHaveBeenCalled();
  });

  it("fails closed for delegation when the host does not expose context.ask", async () => {
    const dependency = deps();
    const tools = buildCursorTools(dependency);
    const context = {
      abort: new AbortController().signal,
      directory: "/work",
      worktree: "/work",
      sessionID: "parent-1",
      messageID: "m",
      agent: "a",
      metadata: vi.fn(),
    } as any;

    const out = await tools.cursor_delegate!.execute({ prompt: "p", model: "m" } as any, context);

    expect(String(out)).toContain("not approved");
    expect(dependency.client.session.create).not.toHaveBeenCalled();
  });

  it("returns needs-auth for the cloud agent tool when no API key is available", async () => {
    const tools = buildCursorTools(deps({ resolveApiKey: () => undefined }));
    const out = await tools.cursor_cloud_agent!.execute(
      { prompt: "p", repoUrl: "https://github.com/o/r" } as any,
      ctx(vi.fn().mockResolvedValue(undefined)),
    );
    expect(String(out)).toContain("No Cursor API key");
    expect(runCloudAgent).not.toHaveBeenCalled();
  });

  it("blocks the cloud agent when the permission gate denies it", async () => {
    const tools = buildCursorTools(deps());
    const out = await tools.cursor_cloud_agent!.execute(
      { prompt: "p", repoUrl: "https://github.com/o/r" } as any,
      ctx(vi.fn().mockRejectedValue(new Error("denied"))),
    );
    expect(String(out)).toContain("not approved");
    expect(String(out)).toContain("denied");
    expect(runCloudAgent).not.toHaveBeenCalled();
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
    const tools = buildCursorTools(deps());

    const out = (await tools.cursor_cloud_agent!.execute(
      { prompt: "p", repoUrl: "https://github.com/o/r" } as any,
      ctx(vi.fn().mockResolvedValue(undefined)),
    )) as { output: string; metadata: Record<string, unknown> };

    expect(out.output).not.toContain("PR:");
    expect(out.output).toContain("Branches: feat-x");
    expect(out.output).toContain("Progress:");
    expect(out.output).toContain("summary text");
    expect(out.metadata.prUrl).toBeNull();
  });

  it("returns a sanitized failure (not a throw) when the cloud run errors", async () => {
    runCloudAgent.mockRejectedValue(new Error("network down"));
    const tools = buildCursorTools(deps());

    const out = await tools.cursor_cloud_agent!.execute(
      { prompt: "p", repoUrl: "https://github.com/o/r" } as any,
      ctx(vi.fn().mockResolvedValue(undefined)),
    );

    expect(String(out)).toContain("Cloud agent failed");
    expect(String(out)).toContain("network down");
  });
});
