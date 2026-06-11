import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	deleteSessionStore,
	loadSessionRecords,
	saveSessionRecords,
	type StoredSessionRecord,
} from "../src/provider/session-store.js";

function record(
	agentId: string,
	updatedAt: number,
	extra?: Partial<StoredSessionRecord>,
): StoredSessionRecord {
	return {
		agentId,
		systemHash: "sys",
		userHashes: ["u1"],
		updatedAt,
		...extra,
	};
}

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
	process.env.XDG_CACHE_HOME = mkdtempSync(
		join(tmpdir(), "cursor-store-test-"),
	);
});

describe("session store", () => {
	it("round-trips records, including mcpHash", () => {
		const now = Date.now();
		const map = new Map([
			["s1", record("a1", now, { mcpHash: "mcp-v1" })],
			["s2", record("a2", now)],
		]);
		saveSessionRecords(map, now);
		const loaded = loadSessionRecords(now);
		expect(loaded.get("s1")).toMatchObject({
			agentId: "a1",
			mcpHash: "mcp-v1",
		});
		expect(loaded.get("s2")).toMatchObject({ agentId: "a2" });
	});

	it("prunes entries older than the TTL on load", () => {
		const now = Date.now();
		const map = new Map([
			["fresh", record("a1", now - 1 * DAY)],
			["stale", record("a2", now - 8 * DAY)],
		]);
		saveSessionRecords(map, now - 8 * DAY); // bypass save-side pruning for "stale"
		// Re-save with both to exercise load-side pruning at `now`.
		saveSessionRecords(map, now - 1 * DAY);
		const loaded = loadSessionRecords(now);
		expect(loaded.has("fresh")).toBe(true);
		expect(loaded.has("stale")).toBe(false);
	});

	it("caps stored entries to the most recently used", () => {
		const now = Date.now();
		const map = new Map<string, StoredSessionRecord>();
		for (let i = 0; i < 250; i++) {
			map.set(`s${i}`, record(`a${i}`, now - i));
		}
		saveSessionRecords(map, now);
		const loaded = loadSessionRecords(now);
		expect(loaded.size).toBe(200);
		expect(loaded.has("s0")).toBe(true); // newest kept
		expect(loaded.has("s249")).toBe(false); // oldest dropped
	});

	it("returns empty on a missing store", () => {
		expect(loadSessionRecords().size).toBe(0);
	});

	it("returns empty on a corrupt store and skips malformed entries", () => {
		const dir = join(process.env.XDG_CACHE_HOME!, "opencode-cursor");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "session-pool.json"), "not json", "utf8");
		expect(loadSessionRecords().size).toBe(0);

		const now = Date.now();
		writeFileSync(
			join(dir, "session-pool.json"),
			JSON.stringify({
				sessions: {
					good: record("a1", now),
					bad: { agentId: 42, updatedAt: "nope" },
				},
			}),
			"utf8",
		);
		const loaded = loadSessionRecords(now);
		expect(loaded.has("good")).toBe(true);
		expect(loaded.has("bad")).toBe(false);
	});

	it("deleteSessionStore removes the file", () => {
		const now = Date.now();
		saveSessionRecords(new Map([["s1", record("a1", now)]]), now);
		deleteSessionStore();
		expect(loadSessionRecords(now).size).toBe(0);
	});
});
