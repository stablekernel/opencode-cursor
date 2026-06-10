import { afterEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const resume = vi.fn();

vi.mock("../src/cursor-runtime.js", () => ({
  loadCursorSdk: async () => ({ Agent: { create, resume } }),
}));

const { acquireAgent, clearAgentPool, getPooledAgentId } = await import(
  "../src/provider/session-pool.js"
);

function fakeAgent(agentId: string) {
  return { agentId, close: vi.fn() };
}

const base = {
  apiKey: "k",
  modelSelection: { id: "m" },
  mode: "agent" as const,
  cwd: "/tmp",
};

afterEach(() => {
  create.mockReset();
  resume.mockReset();
  clearAgentPool();
});

describe("acquireAgent", () => {
  it("creates a fresh, non-pooled agent when session is disabled", async () => {
    create.mockResolvedValue(fakeAgent("a1"));
    const r = await acquireAgent({ ...base, session: false });
    expect(create).toHaveBeenCalledOnce();
    expect(r.resumed).toBe(false);
    expect(getPooledAgentId("s1")).toBeUndefined();
    r.release();
    expect(r.agent.close).toHaveBeenCalled(); // non-pooled agents are closed
  });

  it("creates and pools an agent for a session, and does not close it on release", async () => {
    create.mockResolvedValue(fakeAgent("a1"));
    const r = await acquireAgent({ ...base, session: true, sessionID: "s1" });
    expect(r.resumed).toBe(false);
    expect(getPooledAgentId("s1")).toBe("a1");
    r.release();
    expect(r.agent.close).not.toHaveBeenCalled(); // pooled agents persist
  });

  it("resumes the pooled agent on the next turn for the same session", async () => {
    create.mockResolvedValue(fakeAgent("a1"));
    await acquireAgent({ ...base, session: true, sessionID: "s1" });

    resume.mockResolvedValue(fakeAgent("a1"));
    const r2 = await acquireAgent({ ...base, session: true, sessionID: "s1" });
    expect(resume).toHaveBeenCalledWith("a1", expect.anything());
    expect(r2.resumed).toBe(true);
  });

  it("falls back to creating a fresh agent when resume fails", async () => {
    create.mockResolvedValueOnce(fakeAgent("a1"));
    await acquireAgent({ ...base, session: true, sessionID: "s1" });

    resume.mockRejectedValue(new Error("agent expired"));
    create.mockResolvedValueOnce(fakeAgent("a2"));
    const r = await acquireAgent({ ...base, session: true, sessionID: "s1" });
    expect(r.resumed).toBe(false);
    expect(getPooledAgentId("s1")).toBe("a2");
  });

  it("resumes an explicit agentId without session pooling", async () => {
    resume.mockResolvedValue(fakeAgent("explicit"));
    const r = await acquireAgent({ ...base, session: false, agentId: "explicit" });
    expect(resume).toHaveBeenCalledWith("explicit", expect.anything());
    expect(create).not.toHaveBeenCalled();
    expect(r.resumed).toBe(true);
  });

  it("prefers an explicit agentId over the session's pooled agent", async () => {
    create.mockResolvedValue(fakeAgent("pooled"));
    await acquireAgent({ ...base, session: true, sessionID: "s1" });
    expect(getPooledAgentId("s1")).toBe("pooled");

    resume.mockResolvedValue(fakeAgent("explicit"));
    const r = await acquireAgent({ ...base, session: true, sessionID: "s1", agentId: "explicit" });
    expect(resume).toHaveBeenCalledWith("explicit", expect.anything());
    expect(r.resumed).toBe(true);
  });

  it("falls back to creating when an explicit agentId resume fails", async () => {
    resume.mockRejectedValue(new Error("explicit agent gone"));
    create.mockResolvedValue(fakeAgent("fresh"));

    const r = await acquireAgent({ ...base, session: false, agentId: "missing" });

    expect(resume).toHaveBeenCalledWith("missing", expect.anything());
    expect(create).toHaveBeenCalledOnce();
    expect(r.resumed).toBe(false);
    expect(r.agent.agentId).toBe("fresh");
  });
});
