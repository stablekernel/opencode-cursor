import { afterEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const resume = vi.fn();

vi.mock("../src/cursor-runtime.js", () => ({
	loadCursorSdk: async () => ({ Agent: { create, resume } }),
}));

const { acquireAgent, clearAgentPool, getPooledAgentId, getSessionRecord } =
	await import("../src/provider/session-pool.js");

function fakeAgent(agentId: string) {
	return { agentId, close: vi.fn() };
}

const base = {
	apiKey: "k",
	modelSelection: { id: "m" },
	mode: "agent" as const,
	cwd: "/tmp",
};

const rec = { systemHash: "sys", userHashes: ["u1"] };

afterEach(() => {
	create.mockReset();
	resume.mockReset();
	clearAgentPool();
});

describe("acquireAgent", () => {
	it("creates a fresh, non-pooled agent when no poolKey is given", async () => {
		create.mockResolvedValue(fakeAgent("a1"));
		const r = await acquireAgent({ ...base });
		expect(create).toHaveBeenCalledOnce();
		expect(r.resumed).toBe(false);
		expect(getPooledAgentId("s1")).toBeUndefined();
		r.release();
		expect(r.agent.close).toHaveBeenCalled(); // non-pooled agents are closed
	});

	it("pools the agent + record under poolKey and does not close it on release", async () => {
		create.mockResolvedValue(fakeAgent("a1"));
		const r = await acquireAgent({ ...base, poolKey: "s1", record: rec });
		expect(r.resumed).toBe(false);
		expect(getPooledAgentId("s1")).toBe("a1");
		expect(getSessionRecord("s1")).toEqual({ agentId: "a1", ...rec });
		r.release();
		expect(r.agent.close).not.toHaveBeenCalled(); // pooled agents persist
	});

	it("resumes the given resumeAgentId", async () => {
		resume.mockResolvedValue(fakeAgent("a1"));
		const r = await acquireAgent({
			...base,
			resumeAgentId: "a1",
			poolKey: "s1",
			record: rec,
		});
		expect(resume).toHaveBeenCalledWith("a1", expect.anything());
		expect(r.resumed).toBe(true);
		expect(getPooledAgentId("s1")).toBe("a1");
	});

	it("falls back to creating a fresh agent when resume fails, re-pooling the new id", async () => {
		resume.mockRejectedValue(new Error("agent expired"));
		create.mockResolvedValue(fakeAgent("a2"));
		const r = await acquireAgent({
			...base,
			resumeAgentId: "stale",
			poolKey: "s1",
			record: rec,
		});
		expect(r.resumed).toBe(false);
		expect(getPooledAgentId("s1")).toBe("a2");
	});

	it("re-pools a new record under the same session (divergence)", async () => {
		create.mockResolvedValueOnce(fakeAgent("a1"));
		await acquireAgent({ ...base, poolKey: "s1", record: rec });
		expect(getPooledAgentId("s1")).toBe("a1");

		create.mockResolvedValueOnce(fakeAgent("a2"));
		const next = { systemHash: "sys", userHashes: ["u1", "u2", "edited"] };
		await acquireAgent({ ...base, poolKey: "s1", record: next });
		expect(getSessionRecord("s1")).toEqual({ agentId: "a2", ...next });
	});

	it("resumes an explicit agent without pooling (no poolKey)", async () => {
		resume.mockResolvedValue(fakeAgent("explicit"));
		const r = await acquireAgent({ ...base, resumeAgentId: "explicit" });
		expect(resume).toHaveBeenCalledWith("explicit", expect.anything());
		expect(create).not.toHaveBeenCalled();
		expect(r.resumed).toBe(true);
		expect(getSessionRecord("s1")).toBeUndefined();
		r.release();
		expect(r.agent.close).toHaveBeenCalled();
	});

	it("does not touch the pool when poolKey is omitted (side-call)", async () => {
		create.mockResolvedValueOnce(fakeAgent("a1"));
		await acquireAgent({ ...base, poolKey: "s1", record: rec });

		// A side call: fresh agent, no poolKey -> pool entry must be untouched.
		create.mockResolvedValueOnce(fakeAgent("title-gen"));
		await acquireAgent({ ...base });
		expect(getPooledAgentId("s1")).toBe("a1");
	});
});
