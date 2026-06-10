import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runCloudAgent = vi.fn();
const runDelegate = vi.fn();

// Mock the delegation runtimes so the tool hooks never touch the Cursor SDK.
vi.mock("../src/provider/cloud-agent.js", () => ({ runCloudAgent }));
vi.mock("../src/provider/delegate.js", () => ({ runDelegate }));

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
  runDelegate.mockReset();
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
    expect(runDelegate).not.toHaveBeenCalled();
  });

  it("feeds the auth-loader-captured key into the delegation tools", async () => {
    runDelegate.mockResolvedValue({
      agentId: "a1",
      text: "done",
      reasoning: "",
      toolActivity: [],
      usage: undefined,
    });
    const hooks = await plugin({ directory: "/work" } as never);

    // Simulate opencode's auth loader running with a stored API key.
    const loaded = await hooks.auth!.loader!(async () => ({ type: "api", key: "sekret" }) as never, {
      provider: "cursor",
    } as never);
    expect(loaded).toEqual({ apiKey: "sekret" });

    // The tool should now resolve the captured key rather than returning needs-auth.
    await hooks.tool!.cursor_delegate!.execute(
      { prompt: "p", model: "m" } as any,
      ctx(vi.fn().mockResolvedValue(undefined)),
    );
    expect(runDelegate).toHaveBeenCalledOnce();
    expect(runDelegate.mock.calls[0]![0].apiKey).toBe("sekret");
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
