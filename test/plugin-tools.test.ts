import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runCloudAgent = vi.fn();

// Mock the delegation runtimes so the tool hooks never touch the Cursor SDK.
vi.mock("../src/provider/cloud-agent.js", () => ({ runCloudAgent }));

const { default: plugin } = await import("../src/plugin/index.js");

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

function fakeClient() {
	return {
		session: {
			create: vi.fn().mockResolvedValue({ data: { id: "child-1" } }),
			prompt: vi.fn().mockResolvedValue({
				data: { info: {}, parts: [{ type: "text", text: "done" }] },
			}),
			abort: vi.fn().mockResolvedValue({ data: {} }),
		},
		config: { get: vi.fn().mockResolvedValue({ data: { mcp: {} } }) },
		mcp: { status: vi.fn().mockResolvedValue({ data: {} }) },
		tui: { showToast: vi.fn() },
	};
}

let savedEnvKey: string | undefined;

beforeEach(() => {
  // The captured-key path must not be masked by the env fallback.
  savedEnvKey = process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_API_KEY;
});

afterEach(() => {
  if (savedEnvKey === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = savedEnvKey;
	runCloudAgent.mockReset();
});

describe("CursorPlugin tool hook", () => {
  it("registers the refresh, cloud-agent, and delegate tools", async () => {
    const hooks = await plugin({ directory: "/work" } as never);
    expect(hooks.tool).toBeDefined();
    expect(Object.keys(hooks.tool!)).toEqual(
      expect.arrayContaining(["cursor_refresh_models", "cursor_cloud_agent", "cursor_delegate"]),
    );
  });

  it("reports needs-auth from the tools when no key was captured and no env var is set", async () => {
    const hooks = await plugin({ directory: "/work" } as never);
    const out = await hooks.tool!.cursor_delegate!.execute(
      { prompt: "p", model: "m" } as any,
      ctx(vi.fn().mockResolvedValue(undefined)),
    );
    expect(String(out)).toContain("No Cursor API key");
  });

  it("feeds the auth-loader-captured key into the delegation tools", async () => {
    const client = fakeClient();
    const hooks = await plugin({ directory: "/work", client } as never);
		let childOptions: Record<string, unknown> | undefined;
		let siblingOptions: Record<string, unknown> | undefined;
		client.session.prompt.mockImplementation(async ({ path }: any) => {
			const output = { options: {} } as any;
			await hooks["chat.params"]!(
				{
					sessionID: path.id,
					agent: "build",
					model: { providerID: "cursor", modelID: "m" },
					provider: {},
					message: {},
				} as never,
				output,
			);
			childOptions = output.options;
			// A sibling session must NOT inherit the delegate controls.
			const other = { options: {} } as any;
			await hooks["chat.params"]!(
				{
					sessionID: "unrelated",
					agent: "build",
					model: { providerID: "cursor", modelID: "m" },
					provider: {},
					message: {},
				} as never,
				other,
			);
			siblingOptions = other.options;
			return { data: { info: {}, parts: [{ type: "text", text: "done" }] } } as any;
		});

    // Simulate opencode's auth loader running with a stored API key.
    const loaded = await hooks.auth!.loader!(async () => ({ type: "api", key: "sekret" }) as never, {
      provider: "cursor",
    } as never);
    expect(loaded).toEqual({ apiKey: "sekret" });

    // The tool should now resolve the captured key rather than returning needs-auth.
    await hooks.tool!.cursor_delegate!.execute(
      { prompt: "p", model: "m", thinking: "high", sandbox: true, agentId: "cursor-agent" } as any,
      ctx(vi.fn().mockResolvedValue(undefined)),
    );
    expect(client.session.create).toHaveBeenCalledOnce();
    expect(client.session.prompt).toHaveBeenCalledOnce();
		expect(childOptions).toMatchObject({
			mode: "agent",
			thinking: "high",
			sandbox: true,
			agentId: "cursor-agent",
			sessionID: "child-1",
		});
		// Controls are keyed per child session, so an unrelated session never
		// inherits them (verified here while the child prompt is still pending).
		expect(siblingOptions).not.toHaveProperty("thinking");
		expect(siblingOptions).not.toHaveProperty("agentId");
  });

  it("falls back to CURSOR_API_KEY when the loader never captured a key", async () => {
    process.env.CURSOR_API_KEY = "env-key";
    runCloudAgent.mockResolvedValue({
      agentId: "bc-1",
      status: "finished",
      result: "",
      prUrl: undefined,
      branches: [],
      durationMs: 1,
      progress: [],
    });
    const hooks = await plugin({ directory: "/work" } as never);

    await hooks.tool!.cursor_cloud_agent!.execute(
      { prompt: "p", repoUrl: "https://github.com/o/r" } as any,
      ctx(vi.fn().mockResolvedValue(undefined)),
    );
    expect(runCloudAgent).toHaveBeenCalledOnce();
    expect(runCloudAgent.mock.calls[0]![0].apiKey).toBe("env-key");
  });
});

describe("CursorPlugin chat.params hook", () => {
  const model = { providerID: "cursor", modelID: "composer-2.5" } as never;

  async function runHook(agent: string, options?: Record<string, unknown>, m: unknown = model) {
    const hooks = await plugin({ directory: "/work" } as never);
    const output = { options: { ...(options ?? {}) } } as never;
    await hooks["chat.params"]!(
      { sessionID: "s1", agent, model: m, provider: {}, message: {} } as never,
      output,
    );
    return (output as { options: Record<string, unknown> }).options;
  }

  it("maps opencode's plan agent to Cursor plan mode", async () => {
    const options = await runHook("plan");
    expect(options["mode"]).toBe("plan");
    expect(options["sessionID"]).toBe("s1");
  });

  it("does not force a mode for non-plan agents", async () => {
    const options = await runHook("build");
    expect(options["mode"]).toBeUndefined();
  });

  it("never clobbers a mode already set by a selected variant", async () => {
    const options = await runHook("plan", { mode: "agent" });
    expect(options["mode"]).toBe("agent");
  });

  it("leaves other providers' params untouched", async () => {
    const options = await runHook("plan", {}, { providerID: "anthropic", modelID: "x" });
    expect(options).toEqual({});
  });
});
