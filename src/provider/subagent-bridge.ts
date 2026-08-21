import type { OpencodeClient } from "@opencode-ai/sdk";
import { createPartID, upsertToolPart } from "./child-parts.js";
import { pluginLog } from "./log-bridge.js";

/**
 * Bridge from the opencode plugin to the provider stream layer.
 *
 * A Cursor subagent runs entirely inside Cursor's process — no opencode child
 * session exists, so its `task` card is dead (not clickable, `ctrl+x down`
 * navigates nowhere). To make it native, the provider must create a REAL
 * opencode child session (`Session.parentID`) and point the task part's
 * `state.metadata.sessionId` at it.
 *
 * Two paths:
 *  - Live ({@link linkSubagentSessionLive}): the child session is created when
 *    the `task` call starts and the subagent's nested activity (text,
 *    reasoning, tool calls) is flushed into it as it arrives, making the TUI
 *    subagent view live. Used by the streaming path.
 *  - Post-completion ({@link linkSubagentSession}): the child session is
 *    created at `tool-result` time and seeded with the prompt + a rendered
 *    transcript. Used by the non-streaming path and as a fallback when no live
 *    session could be created.
 *
 * The provider stream code ({@link cursorEventsToStream}) has no opencode
 * client. The plugin does (`PluginInput.client` + `directory`). They run in the
 * same process, so the plugin publishes them here on a `globalThis` registry
 * (immune to bundler entry-point splitting) and the provider reads them lazily.
 * When the bridge is absent (provider used without the plugin, or client
 * unavailable), subagent linking is skipped and the card degrades to exactly
 * its previous non-navigable behavior.
 */
export interface SubagentBridge {
	client: OpencodeClient;
	/** Workspace directory threaded into session create/prompt calls. */
	directory?: string;
}

const BRIDGE_KEY = Symbol.for("@stablekernel/opencode-cursor:subagent-bridge");

type BridgeHolder = { [BRIDGE_KEY]?: SubagentBridge };

/** Publish the opencode client + directory for the provider to use. */
export function setSubagentBridge(bridge: SubagentBridge): void {
	(globalThis as BridgeHolder)[BRIDGE_KEY] = bridge;
}

/** Drop the bridge (plugin dispose). */
export function clearSubagentBridge(): void {
	delete (globalThis as BridgeHolder)[BRIDGE_KEY];
}

/** Read the current bridge, or `undefined` when the plugin hasn't published one. */
export function getSubagentBridge(): SubagentBridge | undefined {
	return (globalThis as BridgeHolder)[BRIDGE_KEY];
}

// ---------------------------------------------------------------------------
// Running-task registry
//
// A parent `task` tool-call id → child session id map, shared with the plugin
// the same way the bridge client is (globalThis registry). The plugin's event
// hook uses it to stamp the RUNNING task part's `state.metadata.sessionId` via
// the `part.update` endpoint — the native `task` tool publishes the child id
// at execute time through `session.updatePart`, and provider-side metadata
// channels (providerMetadata on V3 tool-call parts) cannot reach
// `state.metadata`, which is what the TUI card reads.
// ---------------------------------------------------------------------------

const CALL_REGISTRY_KEY = Symbol.for(
	"@stablekernel/opencode-cursor:subagent-calls",
);

type CallRegistry = Map<string, string>;

function callRegistry(): CallRegistry {
	const holder = globalThis as { [CALL_REGISTRY_KEY]?: CallRegistry };
	if (!holder[CALL_REGISTRY_KEY]) holder[CALL_REGISTRY_KEY] = new Map();
	return holder[CALL_REGISTRY_KEY]!;
}

/** Map a parent `task` tool-call id to the child session id created for it. */
export function registerSubagentCall(callId: string, childId: string): void {
	callRegistry().set(callId, childId);
}

/**
 * Drop the mapping once the task completes. Also invoked after a successful
 * stamp so the plugin doesn't re-stamp the same part.
 */
export function unregisterSubagentCall(callId: string): void {
	callRegistry().delete(callId);
}

/** Resolve the child session id for a parent `task` call, if registered. */
export function subagentCallChildId(callId: string): string | undefined {
	return callRegistry().get(callId);
}

/**
 * Stamp `state.metadata.sessionId` on a RUNNING task part via opencode's
 * `part.update` HTTP endpoint (PATCH /session/:sid/message/:mid/part/:pid) —
 * the exact equivalent of the native task tool's execute-time
 * `ctx.metadata({ metadata: { sessionId } })`. The `part` payload is the
 * current stored part echoed back with the metadata merged in (the endpoint
 * requires id/messageID/sessionID to match the path). Best-effort: failures
 * are swallowed so a broken link never affects the turn.
 *
 * The event's part snapshot may be stale by the time we act (the processor
 * streams running-state updates and can complete the part between events), so
 * the part is re-read from the message before the PATCH and the stamp is
 * skipped if it is no longer `running` — a full-replacement PATCH must never
 * clobber a completed/error state.
 *
 * The published v1 `OpencodeClient` doesn't expose the raw request surface
 * (`part.update` only exists on the v2 HttpApi), so the underlying hey-api
 * client is reached through its runtime `_client` field.
 */
export async function stampTaskPartSessionId(opts: {
	sessionID: string;
	messageID: string;
	partID: string;
	part: unknown;
	childId: string;
}): Promise<void> {
	const bridge = getSubagentBridge();
	if (!bridge) return skipStamp("no bridge", opts.childId);
	if (!isRecord(opts.part)) return skipStamp("part not a record", opts.childId);
	const state = isRecord(opts.part["state"]) ? opts.part["state"] : undefined;
	if (!state || state["status"] !== "running") {
		return skipStamp(`event state ${String(state?.["status"])}`, opts.childId);
	}
	const metadata = isRecord(state["metadata"]) ? { ...state["metadata"] } : {};
	// Already stamped (a previous part event for the same call): skip so a
	// stream of running-state part updates doesn't re-PATCH the same part.
	if (metadata["sessionId"] === opts.childId) return;
	metadata["sessionId"] = opts.childId;
	// SAFETY: the published v1 OpencodeClient type hides the hey-api runtime
	// client; the `_client.request` field exists at runtime (checked below via
	// optional chaining) even though it is absent from the public types.
	const rawClient = (
		bridge.client as unknown as {
			_client?: {
				request?: (options: {
					method: string;
					url: string;
					path?: Record<string, unknown>;
					query?: Record<string, unknown>;
					body?: unknown;
				}) => Promise<unknown>;
			};
		}
	)._client;
	if (!rawClient?.request)
		return skipStamp("client has no request()", opts.childId);
	try {
		// Re-read the part so the PATCH payload reflects the CURRENT state, not
		// the (possibly stale) event snapshot.
		const msgRes = await bridge.client.session.message({
			path: { id: opts.sessionID, messageID: opts.messageID },
			...(bridge.directory ? { query: { directory: bridge.directory } } : {}),
		});
		const current = (
			msgRes?.data as { parts?: unknown[] } | undefined
		)?.parts?.find((p) => isRecord(p) && p["id"] === opts.partID);
		if (!isRecord(current))
			return skipStamp("part not found on re-read", opts.childId);
		const currentState = isRecord(current["state"])
			? current["state"]
			: undefined;
		if (!currentState || currentState["status"] !== "running") {
			return skipStamp(
				`re-read state ${String(currentState?.["status"])}`,
				opts.childId,
			);
		}
		const currentMetadata = isRecord(currentState["metadata"])
			? { ...currentState["metadata"] }
			: {};
		currentMetadata["sessionId"] = opts.childId;
		await rawClient.request({
			method: "PATCH",
			url: "/session/{sessionID}/message/{messageID}/part/{partID}",
			path: {
				sessionID: opts.sessionID,
				messageID: opts.messageID,
				partID: opts.partID,
			},
			...(bridge.directory ? { query: { directory: bridge.directory } } : {}),
			body: { ...current, state: { ...currentState, metadata: currentMetadata } },
		});
		pluginLog("debug", "subagent: stamped task part", {
			childId: opts.childId,
			partID: opts.partID,
		});
	} catch (err) {
		// Best-effort: never let a failed stamp break the turn, but say so —
		// a silent no-op here is indistinguishable from "the card just isn't
		// clickable", which is exactly the failure this logging exists for.
		pluginLog("warn", "subagent: task part stamp failed", {
			childId: opts.childId,
			partID: opts.partID,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/** Record why a live stamp was skipped (see {@link stampTaskPartSessionId}). */
function skipStamp(reason: string, childId: string): void {
	pluginLog("debug", "subagent: task part stamp skipped", { reason, childId });
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function strField(v: unknown, key: string): string | undefined {
	return isRecord(v) && typeof v[key] === "string"
		? (v[key] as string)
		: undefined;
}

function numField(v: unknown, key: string): number | undefined {
	return isRecord(v) && typeof v[key] === "number"
		? (v[key] as number)
		: undefined;
}

/** Format a millisecond duration the way opencode's TUI does (ms / s / m). */
function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60000);
	const seconds = Math.floor((ms % 60000) / 1000);
	return `${minutes}m ${seconds}s`;
}

/**
 * A compact activity line ("ran 5 steps in 12.3s") built from Cursor's task
 * result. `conversationSteps` is opaquely typed, so it's reported as a step
 * count (an honest proxy) rather than claiming an exact tool-call count.
 * Returns `undefined` when neither timing nor steps are available.
 */
export function activityLine(value: unknown): string | undefined {
	const durationMs = numField(value, "durationMs");
	const steps =
		isRecord(value) && Array.isArray(value["conversationSteps"])
			? (value["conversationSteps"] as unknown[]).length
			: undefined;
	const bits: string[] = [];
	if (steps && steps > 0) bits.push(`${steps} step${steps === 1 ? "" : "s"}`);
	if (typeof durationMs === "number")
		bits.push(`in ${formatDuration(durationMs)}`);
	return bits.length > 0 ? `_Subagent ran ${bits.join(" ")}._` : undefined;
}

/**
 * Cursor's proto zero-value subagent kind. Never forward it: the TUI would
 * titlecase it to "Unspecified", and it's meaningless as an agent label.
 */
const UNSPECIFIED_KIND = "unspecified";

/**
 * Resolve a human agent label from Cursor's `subagentType` ({ kind, name? }).
 * Prefers a real `name`; falls back to a meaningful `kind`; otherwise
 * `"general"` (which the TUI renders as "General Task").
 */
export function subagentLabel(args: unknown): string {
	const sub = isRecord(args) ? args["subagentType"] : undefined;
	const name = strField(sub, "name");
	if (name) return name;
	const kind = strField(sub, "kind");
	if (kind && kind !== UNSPECIFIED_KIND) return kind;
	return "general";
}

/**
 * Render a Cursor conversation step (from the task result's `conversationSteps`)
 * into a readable markdown line. Steps are the subagent's own activity:
 * assistant text, thinking, and tool calls with args + results. Returns
 * `undefined` for steps that carry nothing renderable.
 */
function renderStep(step: unknown): string | undefined {
	if (!isRecord(step)) return undefined;
	const norm = normalizeStep(step);
	if (!norm) return dumpStep(step);
	switch (norm.kind) {
		case "assistantMessage": {
			const text = strField(norm.payload, "text");
			return text ? text : undefined;
		}
		case "thinkingMessage": {
			const text = strField(norm.payload, "text");
			return text ? `> ${text}` : undefined;
		}
		case "toolCall": {
			const { name, args, result } = toolCallInfo(norm.payload);
			let arg = "";
			try {
				const s = typeof args === "string" ? args : JSON.stringify(args);
				if (s && s !== "{}" && s !== '""') arg = ` ${s}`;
			} catch {
				// Non-serializable args; show the name only.
			}
			const head = `**\`${name}\`**${arg}`;
			const out = resultText(result);
			return out ? `${head}\n\n\`\`\`\n${out}\n\`\`\`` : head;
		}
		default:
			return dumpStep(step);
	}
}

/**
 * Last-resort rendering for a step whose shape we don't recognise. Cursor's
 * `conversationSteps` is typed as `unknown[]` and has already changed shape
 * between SDK representations, so dropping unmatched steps silently turns a
 * decoding bug into an empty transcript with no signal. Dumping the raw step
 * keeps the subagent's work visible and makes the mismatch self-evident.
 */
function dumpStep(step: unknown): string | undefined {
	try {
		const s = JSON.stringify(step);
		return s && s !== "{}" ? `\`\`\`json\n${s}\n\`\`\`` : undefined;
	} catch {
		return undefined;
	}
}

/** The three `message` oneof members of `agent.v1.ConversationStep`. */
const STEP_KINDS = ["assistantMessage", "toolCall", "thinkingMessage"] as const;

/**
 * Reduce a conversation step to `{ kind, payload }` across both shapes Cursor
 * can hand us. The task result carries raw protobuf-es `toJson()` output, where
 * a oneof serializes to a single camelCase key (`{ assistantMessage: {...} }`);
 * the SDK's public zod type instead uses `{ type, message }`. Returns
 * `undefined` when the step matches neither.
 */
function normalizeStep(
	step: Record<string, unknown>,
): { kind: string; payload: unknown } | undefined {
	const selected = oneofMember(step["message"]);
	if (selected) return { kind: selected.kind, payload: selected.value };
	const type = strField(step, "type");
	if (type) return { kind: type, payload: step["message"] };
	for (const kind of STEP_KINDS) {
		if (kind in step) return { kind, payload: step[kind] };
	}
	return undefined;
}

/**
 * Unwrap protobuf-es's runtime representation of a selected oneof member,
 * `{ case, value }`. The SDK hands us steps as `toJson()` output only when that
 * method exists (`e.toJson?.() ?? e`), so live `Message` objects reach us in
 * this form instead. Returns `undefined` for anything else.
 */
function oneofMember(
	container: unknown,
): { kind: string; value: unknown } | undefined {
	if (!isRecord(container)) return undefined;
	const kind = strField(container, "case");
	return kind ? { kind, value: container["value"] } : undefined;
}

/** Proto suffix on every `agent.v1.ToolCall` oneof member (e.g. `shellToolCall`). */
const TOOL_CALL_SUFFIX = "ToolCall";

/**
 * Resolve a tool's display name and args. `agent.v1.ToolCall` is itself a
 * oneof, so the proto JSON nests as `{ shellToolCall: { args, result } }`; the
 * zod shape flattens to `{ type, args, result }`.
 */
function toolCallInfo(payload: unknown): {
	name: string;
	args: unknown;
	result: unknown;
} {
	const rec = isRecord(payload) ? payload : undefined;
	// `agent.v1.ToolCall` is itself a oneof, so it nests the same three ways.
	const selected = oneofMember(rec?.["tool"]);
	if (selected)
		return { ...toolName(selected.kind), ...toolFields(selected.value) };
	const type = strField(rec, "type");
	if (type) return { name: type, args: rec?.["args"], result: rec?.["result"] };
	for (const [key, value] of Object.entries(rec ?? {})) {
		if (!key.endsWith(TOOL_CALL_SUFFIX)) continue;
		return { ...toolName(key), ...toolFields(value) };
	}
	return { name: "tool", args: undefined, result: undefined };
}

/** Strip the proto `ToolCall` suffix for display (`shellToolCall` → `shell`). */
function toolName(key: string): { name: string } {
	return {
		name: key.endsWith(TOOL_CALL_SUFFIX)
			? key.slice(0, -TOOL_CALL_SUFFIX.length)
			: key,
	};
}

/** Pull the `args`/`result` pair every `*ToolCall` message carries. */
function toolFields(value: unknown): { args: unknown; result: unknown } {
	const rec = isRecord(value) ? value : undefined;
	return { args: rec?.["args"], result: rec?.["result"] };
}

/**
 * Extract readable text from a Cursor tool result. Covers the proto shapes
 * (`{ stdout }`, `{ content }`) and the SDK's status/value union, falling back
 * to JSON. Output is never truncated: the child session is where the full
 * subagent transcript lives.
 */
export function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (!isRecord(result)) return "";
	if (typeof result["stdout"] === "string" && result["stdout"])
		return result["stdout"];
	if (typeof result["content"] === "string" && result["content"])
		return result["content"];
	if (result["status"] === "success" && typeof result["value"] === "string")
		return result["value"];
	const value = result["value"];
	if (isRecord(value)) {
		if (typeof value["stdout"] === "string") return value["stdout"];
		if (typeof value["fileContentAfterWrite"] === "string")
			return value["fileContentAfterWrite"];
	}
	try {
		const s = JSON.stringify(result);
		return s && s !== "{}" ? s : "";
	} catch {
		return "";
	}
}

/**
 * Render the subagent's `conversationSteps` (its own assistant text, thinking,
 * and tool calls) into a readable markdown transcript. Returns `undefined`
 * when there are no renderable steps.
 */
export function renderConversationSteps(value: unknown): string | undefined {
	if (!isRecord(value) || !Array.isArray(value["conversationSteps"]))
		return undefined;
	const rendered = (value["conversationSteps"] as unknown[])
		.map(renderStep)
		.filter((s): s is string => Boolean(s));
	return rendered.length > 0 ? rendered.join("\n\n") : undefined;
}

/**
 * Build the child-session transcript body from Cursor's task result `value`.
 * Prefers the model-authored `resultSuffix`; appends a render of
 * `conversationSteps` (the subagent's own text/thinking/tool activity) when
 * present. Returns `undefined` when there's nothing useful to post (the prompt
 * message alone still makes the session readable).
 */
function buildTranscript(value: unknown): string | undefined {
	const parts: string[] = [];
	const suffix = strField(value, "resultSuffix");
	if (suffix) parts.push(suffix);
	const steps = renderConversationSteps(value);
	if (steps) parts.push(steps);
	// Cursor's real timing/activity, surfaced where it's guaranteed visible: the
	// child session you navigate into (the collapsed one-liner is rendered by
	// opencode from child-session messages we can't synthesize).
	const activity = activityLine(value);
	if (activity) parts.push(activity);
	const body = parts.join("\n\n").trim();
	return body.length > 0 ? body : undefined;
}

/**
 * Create a REAL opencode child session for a completed Cursor subagent and seed
 * it with the originating prompt + the returned transcript (both as user-role
 * messages via `noReply` — the public API can't synthesize assistant messages).
 * Returns the child session id so the caller can set the task part's
 * `state.metadata.sessionId`, or `undefined` when the bridge is unavailable or
 * any step fails (the card then degrades to its previous, non-navigable form).
 */
export async function linkSubagentSession(opts: {
	parentSessionID: string;
	args: unknown;
	result: unknown;
}): Promise<string | undefined> {
	const bridge = getSubagentBridge();
	if (!bridge) return undefined;
	const { client, directory } = bridge;
	const query = directory ? { directory } : undefined;
	try {
		const description = strField(opts.args, "description") ?? "Subagent task";
		const agent = subagentLabel(opts.args);
		const created = await client.session.create({
			body: {
				parentID: opts.parentSessionID,
				title: `${description} (@${agent} subagent)`,
			},
			...(query ? { query } : {}),
		});
		const childId = created?.data?.id;
		if (!childId) return undefined;

		const prompt = strField(opts.args, "prompt");
		if (prompt) {
			await client.session.prompt({
				path: { id: childId },
				...(query ? { query } : {}),
				body: { noReply: true, parts: [{ type: "text", text: prompt }] },
			});
		}
		const value =
			isRecord(opts.result) && opts.result["status"] === "success"
				? opts.result["value"]
				: undefined;
		const transcript = buildTranscript(value);
		if (transcript) {
			await client.session.prompt({
				path: { id: childId },
				...(query ? { query } : {}),
				body: { noReply: true, parts: [{ type: "text", text: transcript }] },
			});
		}
		return childId;
	} catch {
		// Best-effort: a failed link must never break the turn.
		return undefined;
	}
}

/**
 * A live handle to a child session created for a Cursor subagent. The child
 * session is created up-front (when the `task` call starts) so the stream layer
 * can flush the subagent's nested activity into it as it arrives, making the
 * TUI subagent view live. All methods are best-effort: a failure is swallowed
 * and the handle degrades to a no-op so a broken link never breaks the turn.
 */
export interface SubagentLiveSession {
	/** The created child session id. */
	childId: string;
	/**
	 * Id of the seeded prompt message. Parts must hang off a real message row
	 * (the `part` table has a foreign key to `message`), and opencode exposes no
	 * endpoint that creates a message without invoking a model — so this is the
	 * only message available to attach synthesized tool parts to.
	 */
	messageID?: string;
	/**
	 * Append a rendered markdown chunk as a noReply user message. Calls are
	 * serialized through an internal promise chain so concurrent flushes post
	 * in order (no interleaving).
	 */
	flush(markdown: string): Promise<void>;
	/**
	 * Materialise a `tool` part in the child session, which is what the TUI's
	 * subagent card reads to render its live activity subtitle. Pass the
	 * returned id back as `partID` to flip the same call to `completed`.
	 * Resolves `undefined` when the write was skipped or failed.
	 */
	toolPart(opts: {
		callID: string;
		tool: string;
		status: "running" | "completed";
		title?: string;
		input?: unknown;
		output?: string;
		partID?: string;
		start: number;
		end?: number;
	}): Promise<string | undefined>;
	/**
	 * Final flush of any remaining buffered content plus an optional activity
	 * line, then mark the handle done. Further flushes become no-ops.
	 */
	finalize(activity?: string): Promise<void>;
}

/**
 * Create a child session for a Cursor subagent up-front and return a live
 * handle for streaming its activity. Seeds the originating prompt as the first
 * noReply message. Returns `undefined` when the bridge is unavailable or any
 * step fails (the caller then degrades to the post-completion link).
 */
export async function linkSubagentSessionLive(opts: {
	parentSessionID: string;
	args: unknown;
}): Promise<SubagentLiveSession | undefined> {
	const bridge = getSubagentBridge();
	if (!bridge) return undefined;
	const { client, directory } = bridge;
	const query = directory ? { directory } : undefined;
	try {
		const description = strField(opts.args, "description") ?? "Subagent task";
		const agent = subagentLabel(opts.args);
		const created = await client.session.create({
			body: {
				parentID: opts.parentSessionID,
				title: `${description} (@${agent} subagent)`,
			},
			...(query ? { query } : {}),
		});
		const childId = created?.data?.id;
		if (!childId) return undefined;

		// `noReply` short-circuits before the model loop and returns the created
		// USER message (`session/prompt.ts:1069`), despite the generated SDK
		// typing it as an AssistantMessage. Its id is what child parts hang off.
		let messageID: string | undefined;
		const prompt = strField(opts.args, "prompt");
		if (prompt) {
			const seeded = await client.session.prompt({
				path: { id: childId },
				...(query ? { query } : {}),
				body: { noReply: true, parts: [{ type: "text", text: prompt }] },
			});
			messageID = strField(
				(seeded?.data as { info?: unknown } | undefined)?.info,
				"id",
			);
		}

		let done = false;
		let chain: Promise<void> = Promise.resolve();
		const post = (text: string): Promise<void> => {
			chain = chain.then(() =>
				client.session
					.prompt({
						path: { id: childId },
						...(query ? { query } : {}),
						body: { noReply: true, parts: [{ type: "text", text }] },
					})
					.then(() => undefined)
					.catch(() => undefined),
			);
			return chain;
		};

		return {
			childId,
			messageID,
			flush: (markdown: string) => (done ? Promise.resolve() : post(markdown)),
			toolPart: async (part) => {
				if (done || !messageID) return undefined;
				const partID = part.partID ?? createPartID();
				const written = await upsertToolPart({
					sessionID: childId,
					messageID,
					partID,
					callID: part.callID,
					tool: part.tool,
					status: part.status,
					title: part.title,
					input: part.input,
					output: part.output,
					start: part.start,
					end: part.end,
				});
				return written ? partID : undefined;
			},
			finalize: async (activity?: string) => {
				if (done) return;
				done = true;
				if (activity) await post(activity);
			},
		};
	} catch {
		// Best-effort: a failed link must never break the turn.
		return undefined;
	}
}

/**
 * Create a child session for a completed `cursor_delegate` turn and seed it
 * with the originating prompt + a rendered transcript (text, reasoning, tool
 * activity) as a single noReply message. Returns the child session id, or
 * `undefined` when the bridge is unavailable or any step fails.
 *
 * Unlike the provider `task` path, a custom tool's result is a tool block, not
 * a `task` part — `metadata.sessionId` on it does NOT render a navigable card.
 * The child session is instead discoverable via the TUI's subagent panel
 * (sessions with a `parentID` surface through `/session/{id}/children`).
 */
export async function linkDelegateSession(opts: {
	parentSessionID: string;
	title: string;
	prompt: string;
	transcript: string;
}): Promise<string | undefined> {
	const bridge = getSubagentBridge();
	if (!bridge) return undefined;
	const { client, directory } = bridge;
	const query = directory ? { directory } : undefined;
	try {
		const created = await client.session.create({
			body: { parentID: opts.parentSessionID, title: opts.title },
			...(query ? { query } : {}),
		});
		const childId = created?.data?.id;
		if (!childId) return undefined;
		if (opts.prompt) {
			await client.session.prompt({
				path: { id: childId },
				...(query ? { query } : {}),
				body: { noReply: true, parts: [{ type: "text", text: opts.prompt }] },
			});
		}
		if (opts.transcript) {
			await client.session.prompt({
				path: { id: childId },
				...(query ? { query } : {}),
				body: { noReply: true, parts: [{ type: "text", text: opts.transcript }] },
			});
		}
		return childId;
	} catch {
		// Best-effort: a failed link must never break the turn.
		return undefined;
	}
}
