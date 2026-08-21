import { afterEach, describe, expect, it, vi } from "vitest";
import { createPartID, upsertToolPart } from "../src/provider/child-parts.js";
import {
	clearSubagentBridge,
	setSubagentBridge,
} from "../src/provider/subagent-bridge.js";

afterEach(() => clearSubagentBridge());

type RawRequest = (options: Record<string, unknown>) => Promise<unknown>;

/** Publish a bridge whose raw client records every request it receives. */
function fakeBridge(impl?: RawRequest) {
	const request = vi.fn<RawRequest>(impl ?? (async () => ({})));
	setSubagentBridge({
		client: { _client: { request } } as never,
		directory: "/w",
	});
	return request;
}

/** The options object handed to the raw client for call `index`. */
function requestAt(
	request: ReturnType<typeof fakeBridge>,
	index: number,
): Record<string, unknown> {
	const call = request.mock.calls[index];
	if (!call) throw new Error(`no request at index ${index}`);
	return call[0];
}

describe("createPartID", () => {
	it("matches opencode's ascending part id format", () => {
		// packages/opencode/src/id/id.ts:51 — prefix + "_" + 6 hex bytes + 14 base62.
		// Verified against a real row: prt_fd90281ed001Zwm05cey7wh2ym
		expect(createPartID()).toMatch(/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
	});

	it("stays ordered and unique within a single millisecond", () => {
		const ids = Array.from({ length: 50 }, () => createPartID(1786052248042));
		expect([...ids].sort()).toEqual(ids);
		expect(new Set(ids).size).toBe(50);
	});
});

describe("upsertToolPart", () => {
	it("PATCHes a running tool part carrying a title", async () => {
		const request = fakeBridge();
		const ok = await upsertToolPart({
			sessionID: "ses_c",
			messageID: "msg_1",
			partID: createPartID(),
			callID: "c1",
			tool: "read",
			status: "running",
			title: "CHANGELOG.md",
			input: { path: "CHANGELOG.md" },
			start: 5,
		});
		expect(ok).toBe(true);
		const call = requestAt(request, 0);
		expect(call["method"]).toBe("PATCH");
		expect(call["url"]).toBe(
			"/session/{sessionID}/message/{messageID}/part/{partID}",
		);
		expect(call["body"]).toMatchObject({
			type: "tool",
			tool: "read",
			state: { status: "running", title: "CHANGELOG.md", time: { start: 5 } },
		});
	});

	it("sends path params the endpoint validates against the body", async () => {
		const request = fakeBridge();
		const partID = createPartID();
		await upsertToolPart({
			sessionID: "ses_c",
			messageID: "msg_1",
			partID,
			callID: "c1",
			tool: "bash",
			status: "completed",
			title: "git status",
			output: "clean",
			start: 1,
			end: 2,
		});
		// handlers/session.ts:403-409 rejects the request unless these match.
		const call = requestAt(request, 0);
		expect(call["path"]).toEqual({
			sessionID: "ses_c",
			messageID: "msg_1",
			partID,
		});
		expect(call["body"]).toMatchObject({
			id: partID,
			messageID: "msg_1",
			sessionID: "ses_c",
			state: { status: "completed", output: "clean", time: { start: 1, end: 2 } },
		});
	});

	// The completed ToolState schema REQUIRES state.metadata (the running state
	// does not) — omitting it got a 400 from a live v1.18.18 server, which
	// hey-api reports as a resolved `{ error }` rather than a rejection.
	it("sends state.metadata on a completed part, and fails on an {error} response", async () => {
		const request = fakeBridge(async () => ({
			error: { name: "BadRequest", data: { message: "Missing key" } },
		}));
		const ok = await upsertToolPart({
			sessionID: "ses_c",
			messageID: "msg_1",
			partID: createPartID(),
			callID: "c1",
			tool: "read",
			status: "completed",
			output: "",
			start: 1,
			end: 2,
		});
		expect(ok).toBe(false);
		const call = requestAt(request, 0);
		expect(
			(call["body"] as { state: Record<string, unknown> }).state["metadata"],
		).toEqual({});
	});

	it("returns false and never throws when the request fails", async () => {
		fakeBridge(async () => {
			throw new Error("boom");
		});
		await expect(
			upsertToolPart({
				sessionID: "s",
				messageID: "m",
				partID: createPartID(),
				callID: "c",
				tool: "read",
				status: "running",
				start: 0,
			}),
		).resolves.toBe(false);
	});

	it("returns false when no bridge is published", async () => {
		const ok = await upsertToolPart({
			sessionID: "s",
			messageID: "m",
			partID: createPartID(),
			callID: "c",
			tool: "read",
			status: "running",
			start: 0,
		});
		expect(ok).toBe(false);
	});
});
