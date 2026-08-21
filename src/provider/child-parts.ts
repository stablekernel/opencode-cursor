import { randomBytes } from "node:crypto";
import { pluginLog } from "./log-bridge.js";
import { getSubagentBridge } from "./subagent-bridge.js";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const RANDOM_LENGTH = 14;

let lastTimestamp = 0;
let counter = 0;

/**
 * Generate an opencode-compatible ascending part id.
 *
 * Mirrors `packages/opencode/src/id/id.ts:51`: a 6-byte big-endian
 * `timestamp * 0x1000 + counter` rendered as hex, followed by random base62.
 * The counter keeps ids monotonic (and unique) within a millisecond, which is
 * what makes parts sort correctly in the TUI.
 */
export function createPartID(now?: number): string {
	const timestamp = now ?? Date.now();
	if (timestamp !== lastTimestamp) {
		lastTimestamp = timestamp;
		counter = 0;
	}
	counter++;
	const value = BigInt(timestamp) * BigInt(0x1000) + BigInt(counter);
	const bytes = Buffer.alloc(6);
	for (let i = 0; i < 6; i++) {
		bytes[i] = Number((value >> BigInt(40 - 8 * i)) & BigInt(0xff));
	}
	let random = "";
	const raw = randomBytes(RANDOM_LENGTH);
	for (let i = 0; i < RANDOM_LENGTH; i++) random += BASE62[raw[i]! % 62];
	return `prt_${bytes.toString("hex")}${random}`;
}

const PART_URL = "/session/{sessionID}/message/{messageID}/part/{partID}";

/** Arguments describing one tool call to materialise in a child session. */
export interface ToolPartInput {
	sessionID: string;
	messageID: string;
	partID: string;
	callID: string;
	tool: string;
	status: "running" | "completed";
	title?: string;
	input?: unknown;
	output?: string;
	start: number;
	end?: number;
}

/**
 * Create or update a `tool` part inside a subagent's child session.
 *
 * `updatePart` is an upsert — opencode's own processor creates parts through it
 * (`session/processor.ts:242`) — so a fresh `partID` inserts and a repeated one
 * updates. This is the only way to surface Cursor subagent activity in the TUI:
 * the task card's activity subtitle is built purely from `type === "tool"`
 * parts found in the child session (`tui/routes/session/index.tsx:2227-2279`).
 *
 * The published v1 `OpencodeClient` doesn't expose `part.update`, so the
 * underlying hey-api client is reached through its runtime `_client` field.
 *
 * Best-effort — never throws, so a failed write cannot break the parent turn —
 * but always logs, because a silent failure here is indistinguishable from
 * "the subagent did nothing".
 */
export async function upsertToolPart(opts: ToolPartInput): Promise<boolean> {
	const bridge = getSubagentBridge();
	// SAFETY: the published v1 OpencodeClient type hides the hey-api runtime
	// client; `_client.request` exists at runtime (optional-chained below)
	// even though it is absent from the public types.
	const request = (
		bridge?.client as unknown as
			| {
					_client?: {
						request?: (options: Record<string, unknown>) => Promise<unknown>;
					};
			  }
			| undefined
	)?._client?.request;
	if (!bridge || !request) {
		pluginLog("debug", "subagent: tool part skipped", {
			reason: "no bridge",
			tool: opts.tool,
		});
		return false;
	}
	const state: Record<string, unknown> = {
		status: opts.status,
		input: opts.input ?? {},
		time:
			opts.status === "completed"
				? { start: opts.start, end: opts.end ?? Date.now() }
				: { start: opts.start },
	};
	if (opts.title) state["title"] = opts.title;
	if (opts.status === "completed") {
		state["output"] = opts.output ?? "";
		// The completed ToolState schema requires `metadata` (the running state
		// omits it). Missing it earns a 400: "Missing key at [state][metadata]".
		state["metadata"] = {};
	}
	try {
		const res = await request({
			method: "PATCH",
			url: PART_URL,
			path: {
				sessionID: opts.sessionID,
				messageID: opts.messageID,
				partID: opts.partID,
			},
			...(bridge.directory ? { query: { directory: bridge.directory } } : {}),
			body: {
				id: opts.partID,
				messageID: opts.messageID,
				sessionID: opts.sessionID,
				type: "tool",
				callID: opts.callID,
				tool: opts.tool,
				state,
			},
		});
		// hey-api's runtime `request` RESOLVES `{ error }` on a 4xx instead of
		// rejecting, so a rejected payload looks like success unless checked.
		if (
			typeof res === "object" &&
			res !== null &&
			"error" in res &&
			(res as { error: unknown }).error != null
		) {
			pluginLog("warn", "subagent: tool part upsert rejected", {
				tool: opts.tool,
				status: opts.status,
				error: JSON.stringify((res as { error: unknown }).error).slice(0, 300),
			});
			return false;
		}
		return true;
	} catch (err) {
		pluginLog("warn", "subagent: tool part upsert failed", {
			tool: opts.tool,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}
