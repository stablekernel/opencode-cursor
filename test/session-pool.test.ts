import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Sandbox the on-disk session store away from the user's real cache dir.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "cursor-pool-test-"));

const create = vi.fn();
const resume = vi.fn();

vi.mock("../src/cursor-runtime.js", () => ({
	loadCursorSdk: async () => ({ Agent: { create, resume } }),
}));

const {
	acquireAgent,
	clearAgentPool,
	dropSessionRecord,
	getPooledAgentId,
	getSessionRecord,
	resetSessionPoolMemory,
	withSessionLock,
} = await import("../src/provider/session-pool.js");
const { classifyTurn, fingerprint } = await import(
	"../src/provider/transcript-fingerprint.js"
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
		expect(getSessionRecord("s1")).toMatchObject({ agentId: "a1", ...rec });
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

	it("persists mcpHash in the pooled record when provided", async () => {
		create.mockResolvedValue(fakeAgent("a1"));
		await acquireAgent({
			...base,
			poolKey: "s1",
			record: { ...rec, mcpHash: "mcp-v1" },
		});
		expect(getSessionRecord("s1")).toMatchObject({
			agentId: "a1",
			...rec,
			mcpHash: "mcp-v1",
		});
	});

	it("re-pools a new record under the same session (divergence)", async () => {
		create.mockResolvedValueOnce(fakeAgent("a1"));
		await acquireAgent({ ...base, poolKey: "s1", record: rec });
		expect(getPooledAgentId("s1")).toBe("a1");

		create.mockResolvedValueOnce(fakeAgent("a2"));
		const next = { systemHash: "sys", userHashes: ["u1", "u2", "edited"] };
		await acquireAgent({ ...base, poolKey: "s1", record: next });
		expect(getSessionRecord("s1")).toMatchObject({ agentId: "a2", ...next });
	});

	it("survives a process restart: records rehydrate from disk", async () => {
		create.mockResolvedValue(fakeAgent("a1"));
		await acquireAgent({
			...base,
			poolKey: "s1",
			record: { ...rec, mcpHash: "mcp-v1" },
		});

		// Simulate an opencode restart: in-memory pool gone, disk store intact.
		resetSessionPoolMemory();
		expect(getSessionRecord("s1")).toMatchObject({
			agentId: "a1",
			...rec,
			mcpHash: "mcp-v1",
		});
	});

	it("prefers in-memory state over stale disk state when both exist", async () => {
		create.mockResolvedValueOnce(fakeAgent("a1"));
		await acquireAgent({ ...base, poolKey: "s1", record: rec });

		// Restart, rehydrate, then advance the conversation in-memory.
		resetSessionPoolMemory();
		create.mockResolvedValueOnce(fakeAgent("a2"));
		const next = { systemHash: "sys", userHashes: ["u1", "u2"] };
		await acquireAgent({ ...base, poolKey: "s1", record: next });
		expect(getSessionRecord("s1")).toMatchObject({ agentId: "a2", ...next });
	});

	it("clearAgentPool wipes the disk store too", async () => {
		create.mockResolvedValue(fakeAgent("a1"));
		await acquireAgent({ ...base, poolKey: "s1", record: rec });
		clearAgentPool();
		resetSessionPoolMemory(); // would rehydrate if the file survived
		expect(getSessionRecord("s1")).toBeUndefined();
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

	it("dropSessionRecord removes the record from memory and disk", async () => {
		create.mockResolvedValue(fakeAgent("a1"));
		await acquireAgent({ ...base, poolKey: "s1", record: rec });
		expect(getSessionRecord("s1")).toBeDefined();

		dropSessionRecord("s1");
		expect(getSessionRecord("s1")).toBeUndefined();

		// The delete must persist: rehydration from disk must not resurrect it.
		resetSessionPoolMemory();
		expect(getSessionRecord("s1")).toBeUndefined();
	});

	it("does not touch the pool when poolKey is omitted (side-call)", async () => {
		create.mockResolvedValueOnce(fakeAgent("a1"));
		await acquireAgent({ ...base, poolKey: "s1", record: rec });

		// A side call: fresh agent, no poolKey -> pool entry must be untouched.
		create.mockResolvedValueOnce(fakeAgent("title-gen"));
		await acquireAgent({ ...base });
		expect(getPooledAgentId("s1")).toBe("a1");
	});

	it("passes autoReview through to the agent's local options", async () => {
		const created: unknown[] = [];
		create.mockImplementation(async (opts) => {
			created.push(opts);
			return fakeAgent("a1");
		});
		await acquireAgent({ ...base, autoReview: true });
		expect(
			(created[0] as { local?: { autoReview?: boolean } }).local?.autoReview,
		).toBe(true);
	});
});

describe("withSessionLock", () => {
	/** A promise you can resolve/reject from the outside. */
	function deferred<T>() {
		let resolve!: (value: T) => void;
		let reject!: (err: unknown) => void;
		const promise = new Promise<T>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		return { promise, resolve, reject };
	}

	it("serializes concurrent calls for the same sessionID", async () => {
		const order: string[] = [];
		const first = deferred<void>();

		const p1 = withSessionLock("s1", async () => {
			order.push("first-start");
			await first.promise;
			order.push("first-end");
		});
		const p2 = withSessionLock("s1", async () => {
			order.push("second-start");
			order.push("second-end");
		});

		// Give the microtask queue a chance to run anything that isn't gated
		// on `first`. If the lock didn't serialize, "second-start" would
		// already be here.
		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual(["first-start"]);

		first.resolve();
		await Promise.all([p1, p2]);
		expect(order).toEqual([
			"first-start",
			"first-end",
			"second-start",
			"second-end",
		]);
	});

	it("runs calls for different sessionIDs fully concurrently", async () => {
		const order: string[] = [];
		const a = deferred<void>();

		const p1 = withSessionLock("s1", async () => {
			order.push("s1-start");
			await a.promise;
			order.push("s1-end");
		});
		const p2 = withSessionLock("s2", async () => {
			order.push("s2-start");
			order.push("s2-end");
		});

		await p2;
		// s2 must have completed even though s1 is still blocked on `a`.
		expect(order).toEqual(["s1-start", "s2-start", "s2-end"]);

		a.resolve();
		await p1;
		expect(order).toEqual(["s1-start", "s2-start", "s2-end", "s1-end"]);
	});

	it("does not let an error in one call block the next call for the same key", async () => {
		const order: string[] = [];
		await expect(
			withSessionLock("s1", async () => {
				order.push("first");
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		await withSessionLock("s1", async () => {
			order.push("second");
		});
		expect(order).toEqual(["first", "second"]);
	});

	it("runs immediately, unserialized, when sessionID is undefined", async () => {
		const order: string[] = [];
		const p1 = withSessionLock(undefined, async () => {
			order.push("a-start");
			await Promise.resolve();
			order.push("a-end");
		});
		const p2 = withSessionLock(undefined, async () => {
			order.push("b");
		});
		await Promise.all([p1, p2]);
		// No lock for undefined sessionID: "b" runs before "a" finishes.
		expect(order).toEqual(["a-start", "b", "a-end"]);
	});

	it("propagates the return value of the wrapped function", async () => {
		const result = await withSessionLock("s1", async () => 42);
		expect(result).toBe(42);
	});
});

describe("withSessionLock + classifyTurn + acquireAgent (title-gen race regression)", () => {
	// Reproduces the bug this fix closes: opencode forks a title-generation
	// call on the exact same sessionID as a session's real first turn,
	// concurrently, with an unrelated (empty) system prompt. Before the pool's
	// classify-then-acquire span was serialized per session, both calls could
	// see "no prior record" and both write to the pool; whichever finished
	// last silently and permanently overwrote the other's entry.
	const realPrompt = [
		{ role: "system" as const, content: "Real system prompt" },
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: "hello" }],
		},
	];
	const titlePrompt = [
		{
			role: "user" as const,
			content: [
				{
					type: "text" as const,
					text: "Generate a title for this conversation:\n",
				},
			],
		},
	];

	it("serializes the classify+acquire span so the side-call never corrupts the real turn's pool record", async () => {
		const realFp = fingerprint(realPrompt);
		const titleFp = fingerprint(titlePrompt);
		expect(realFp.systemHash).not.toBe(titleFp.systemHash);

		let titleSawPriorRecord: unknown;
		let titleClassification: string | undefined;

		create.mockResolvedValueOnce(fakeAgent("a1"));
		create.mockResolvedValueOnce(fakeAgent("title-gen"));

		// Fire both "turns" concurrently — neither is awaited before the other
		// starts, mirroring the real race between opencode's forked title call
		// and the actual chat turn.
		const real = withSessionLock("s1", async () => {
			const classification = classifyTurn(getSessionRecord("s1"), realPrompt);
			return acquireAgent({
				...base,
				poolKey: "s1",
				record: classification.fingerprint,
			});
		});
		const title = withSessionLock("s1", async () => {
			titleSawPriorRecord = getSessionRecord("s1");
			const classification = classifyTurn(
				getSessionRecord("s1"),
				titlePrompt,
			);
			titleClassification = classification.kind;
			if (classification.kind === "side-call") {
				return acquireAgent({ ...base });
			}
			// If this branch were ever hit, it would reproduce the bug: a
			// misclassified side-call re-pooling on top of the real turn.
			return acquireAgent({
				...base,
				poolKey: "s1",
				record: classification.fingerprint,
			});
		});

		await Promise.all([real, title]);

		// The lock guarantees the title call's classify only runs after the
		// real call's pool write has landed, so it correctly sees the real
		// turn's record and classifies as a side-call.
		expect(titleSawPriorRecord).toMatchObject({ agentId: "a1", ...realFp });
		expect(titleClassification).toBe("side-call");
		expect(getPooledAgentId("s1")).toBe("a1");
		expect(getSessionRecord("s1")).toMatchObject({
			agentId: "a1",
			...realFp,
		});
	});
});
