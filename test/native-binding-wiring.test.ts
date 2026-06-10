import { afterEach, describe, expect, it, vi } from "vitest";

const ensureSqliteBinding = vi.fn(async () => "present" as const);
vi.mock("../src/native-binding.js", () => ({ ensureSqliteBinding }));

const createAgent = vi.fn(async () => ({ agentId: "sidecar-agent" }));
const resumeAgent = vi.fn(async () => ({ agentId: "sidecar-agent" }));
vi.mock("../src/provider/sidecar-client.js", () => ({
  SidecarClient: class {
    createAgent = createAgent;
    resumeAgent = resumeAgent;
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("loadCursorSdk", () => {
  it("ensures the sqlite binding before importing the SDK", async () => {
    const { loadCursorSdk } = await import("../src/cursor-runtime.js");
    await loadCursorSdk();
    expect(ensureSqliteBinding).toHaveBeenCalled();
  });
});

describe("sidecar backend", () => {
  it("ensures the sqlite binding before creating an agent", async () => {
    vi.stubEnv("OPENCODE_CURSOR_SIDECAR", "1");
    const { loadAgentBackend, resetAgentBackend } = await import(
      "../src/provider/agent-backend.js"
    );
    resetAgentBackend();
    const backend = loadAgentBackend();
    expect(backend.kind).toBe("sidecar");
    await backend.createAgent({});
    expect(ensureSqliteBinding).toHaveBeenCalled();
    expect(createAgent).toHaveBeenCalled();
    resetAgentBackend();
  });
});
