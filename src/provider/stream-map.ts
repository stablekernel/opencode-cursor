import type {
	LanguageModelV3Content,
	LanguageModelV3FinishReason,
	LanguageModelV3StreamPart,
	LanguageModelV3Usage,
} from "@ai-sdk/provider";
import type { CursorEvent, CursorUsage } from "./agent-events.js";

/**
 * How Cursor's internal tool activity (shell/read/edit/mcp/…) is surfaced to
 * opencode:
 *  - `"blocks"` (default): emitted as provider-executed AI-SDK
 *    `tool-call`/`tool-result` parts so opencode renders structured tool
 *    blocks. Requires a V3-native opencode host (1.16+). The parts must carry
 *    BOTH `providerExecuted: true` AND `dynamic: true` — ai's `parseToolCall`
 *    (v6, `doParseToolCall`) only exempts that combination from registered-tool
 *    validation; without `dynamic` an unknown name raises `NoSuchToolError`,
 *    which opencode's `experimental_repairToolCall` rewrites into its "invalid"
 *    tool. Names are also prefixed (`cursor_…`) so they can never collide with
 *    a tool opencode has registered (`read`, `grep`, `task`, …) — a colliding
 *    name is validated against that tool's input schema instead of being
 *    treated as dynamic.
 */
export type ToolDisplay = "reasoning" | "blocks";

const FINISH_STOP: LanguageModelV3FinishReason = {
	unified: "stop",
	raw: undefined,
};
const FINISH_ERROR: LanguageModelV3FinishReason = {
	unified: "error",
	raw: undefined,
};

function safeJsonString(input: unknown): string {
	try {
		return typeof input === "string" ? input : JSON.stringify(input ?? {});
	} catch {
		return "{}";
	}
}

/**
 * Tool name as it crosses into opencode in "blocks" mode. Prefixed so it can
 * never collide with a tool opencode has registered, and sanitized because MCP
 * names contain `/` (e.g. `serena/find_symbol` → `cursor_serena_find_symbol`).
 */
function blockToolName(name: string): string {
	return `cursor_${name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/**
 * A blocks-mode tool part. `tool-call` / `tool-result` are structurally
 * identical in `LanguageModelV3StreamPart` (streaming) and
 * `LanguageModelV3Content` (`doGenerate`), so the builders below produce one
 * shape that both consumers cast to their respective union.
 */
type BlockToolPart = LanguageModelV3StreamPart;

/**
 * Build a provider-executed dynamic `tool-call`. The name is `cursor_`-prefixed
 * so it can't collide with a tool opencode has registered; `input` is a
 * stringified JSON object per the V3 spec.
 */
function toolCallObj(id: string, name: string, input: unknown): BlockToolPart {
	return {
		type: "tool-call",
		toolCallId: id,
		toolName: blockToolName(name),
		input: safeJsonString(input),
		providerExecuted: true,
		dynamic: true,
	} as BlockToolPart;
}

/**
 * Build a provider-executed dynamic `tool-result`. Per the V3 spec (and ai v6's
 * `runToolsTransformation`, which reads `chunk.result` / `chunk.isError`) the
 * payload goes in `result`; `result` is typed `NonNullable<JSONValue>` so a
 * missing Cursor result is coalesced to `null` and cast.
 */
function toolResultObj(
	id: string,
	name: string,
	result: unknown,
	isError: boolean,
): BlockToolPart {
	return {
		type: "tool-result",
		toolCallId: id,
		toolName: blockToolName(name),
		result: (result ?? null) as never,
		isError,
		providerExecuted: true,
		dynamic: true,
	} as BlockToolPart;
}

/** Cursor's file-edit tool surfaces with this name (its `toolCall.type`). */
const EDIT_TOOL_NAME = "edit";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

/** Extract the edit target path from Cursor's edit tool-call args (`{ path }`). */
function editFilePath(input: unknown): string {
	return isRecord(input) && typeof input["path"] === "string"
		? input["path"]
		: "";
}

/**
 * If `result` is a successful Cursor edit result carrying a unified diff, return
 * its `diffString`; otherwise null (caller falls back to a safe generic block).
 * Cursor shape: `{ status:"success", value:{ diffString?, linesAdded?, linesRemoved? } }`.
 */
function editDiffString(result: unknown): string | null {
	if (!isRecord(result) || result["status"] !== "success") return null;
	const value = result["value"];
	if (!isRecord(value)) return null;
	const diff = value["diffString"];
	return typeof diff === "string" && diff.length > 0 ? diff : null;
}

/**
 * Reconstruct opencode `edit` `{oldString,newString}` from a unified diff:
 * removed (`-`) lines → oldString, added (`+`) lines → newString (file/hunk
 * headers skipped). Faithful for a single hunk; approximate (concatenated)
 * across multiple hunks. Used only to satisfy opencode's edit input schema — the
 * call is provider-executed, so these strings are never applied to disk; the
 * rendered diff comes from `metadata.diff`.
 */
function reconstructEditStrings(diff: string): {
	oldString: string;
	newString: string;
} {
	const oldLines: string[] = [];
	const newLines: string[] = [];
	for (const line of diff.split("\n")) {
		if (
			line.startsWith("---") ||
			line.startsWith("+++") ||
			line.startsWith("@@") ||
			line.startsWith("Index:") ||
			line.startsWith("===")
		) {
			continue;
		}
		if (line.startsWith("-")) oldLines.push(line.slice(1));
		else if (line.startsWith("+")) newLines.push(line.slice(1));
	}
	return { oldString: oldLines.join("\n"), newString: newLines.join("\n") };
}

/**
 * Build the opencode-native `edit` `tool-call` payload for a completed Cursor
 * edit. Emitted under the registered name `edit` (so opencode's diff viewer
 * renders) with a schema-valid `{filePath, oldString, newString}` input. Still
 * carries `providerExecuted` + `dynamic` so a host without a registered `edit`
 * tool degrades to a dynamic generic block instead of erroring.
 */
function editCallFields(
	id: string,
	filePath: string,
	diff: string,
): BlockToolPart {
	const { oldString, newString } = reconstructEditStrings(diff);
	return {
		type: "tool-call",
		toolCallId: id,
		toolName: EDIT_TOOL_NAME,
		input: safeJsonString({ filePath, oldString, newString }),
		providerExecuted: true,
		dynamic: true,
	} as BlockToolPart;
}

/**
 * Build the opencode-native `edit` `tool-result` payload. opencode's processor
 * folds a tool-result's payload into `state.{title,metadata,output}`; the Edit
 * renderer's diff viewer keys on `metadata.diff`.
 */
function editResultFields(
	id: string,
	filePath: string,
	diff: string,
	result: unknown,
): BlockToolPart {
	const value = isRecord(result) ? result["value"] : undefined;
	const added =
		isRecord(value) && typeof value["linesAdded"] === "number"
			? value["linesAdded"]
			: undefined;
	const removed =
		isRecord(value) && typeof value["linesRemoved"] === "number"
			? value["linesRemoved"]
			: undefined;
	const counts =
		added !== undefined || removed !== undefined
			? ` (+${added ?? 0}/-${removed ?? 0})`
			: "";
	return {
		type: "tool-result" as const,
		toolCallId: id,
		toolName: EDIT_TOOL_NAME,
		result: {
			title: filePath,
			metadata: { diff, diagnostics: {} },
			output: `Edit applied${counts}.`,
		} as never,
		isError: false,
		providerExecuted: true,
		dynamic: true,
	} as BlockToolPart;
}

/**
 * Per-turn blocks-mode tool bookkeeping, shared by the streaming and
 * `doGenerate` paths:
 *  - `openToolCalls`: non-edit calls awaiting their result (id → original name).
 *  - `pendingEdits`: edit calls held until their result, which carries the diff
 *    needed to emit a schema-valid native `edit` call (id → filePath).
 */
interface BlockToolState {
	openToolCalls: Map<string, string>;
	pendingEdits: Map<string, string>;
}

function newBlockToolState(): BlockToolState {
	return { openToolCalls: new Map(), pendingEdits: new Map() };
}

/** Parts to emit for a blocks-mode `tool-call` event (edits are buffered). */
function blockToolCallParts(
	id: string,
	name: string,
	input: unknown,
	state: BlockToolState,
): BlockToolPart[] {
	if (name === EDIT_TOOL_NAME) {
		// Hold the edit call until its result (which carries the diff).
		state.pendingEdits.set(id, editFilePath(input));
		return [];
	}
	state.openToolCalls.set(id, name);
	return [toolCallObj(id, name, input)];
}

/** Parts to emit for a blocks-mode `tool-result` event. */
function blockToolResultParts(
	id: string,
	name: string,
	result: unknown,
	isError: boolean,
	state: BlockToolState,
): BlockToolPart[] {
	if (state.pendingEdits.has(id)) {
		const filePath = state.pendingEdits.get(id)!;
		state.pendingEdits.delete(id);
		const diff = isError ? null : editDiffString(result);
		if (diff && filePath) {
			// Native edit: opencode renders its built-in diff viewer.
			return [
				editCallFields(id, filePath, diff),
				editResultFields(id, filePath, diff, result),
			];
		}
		// No usable diff (error / unexpected shape): safe generic fallback.
		return [
			toolCallObj(id, EDIT_TOOL_NAME, { path: filePath }),
			toolResultObj(id, EDIT_TOOL_NAME, result, isError),
		];
	}
	state.openToolCalls.delete(id);
	return [toolResultObj(id, name, result, isError)];
}

/**
 * Parts that close out any tool call whose completion never arrived (run
 * errored/cancelled mid-tool) so blocks never dangle as "Tool execution
 * aborted". Clears the state.
 */
function blockDanglingParts(state: BlockToolState): BlockToolPart[] {
	const parts: BlockToolPart[] = [];
	for (const [id, name] of state.openToolCalls) {
		parts.push(toolResultObj(id, name, DANGLING_TOOL_RESULT, true));
	}
	state.openToolCalls.clear();
	// Edits whose result never arrived: safe generic block + synthetic error
	// (no diff available to build a native edit).
	for (const [id, filePath] of state.pendingEdits) {
		parts.push(toolCallObj(id, EDIT_TOOL_NAME, { path: filePath }));
		parts.push(toolResultObj(id, EDIT_TOOL_NAME, DANGLING_TOOL_RESULT, true));
	}
	state.pendingEdits.clear();
	return parts;
}

export const EMPTY_USAGE: LanguageModelV3Usage = {
	inputTokens: {
		total: undefined,
		noCache: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

export function mapUsage(usage: CursorUsage): LanguageModelV3Usage {
	return {
		inputTokens: {
			total: usage.inputTokens,
			noCache: undefined,
			cacheRead: usage.cacheReadTokens,
			cacheWrite: usage.cacheWriteTokens,
		},
		outputTokens: {
			total: usage.outputTokens,
			text: undefined,
			reasoning: undefined,
		},
	};
}

/**
 * Render Cursor's internal tool activity as a short, human-readable line.
 *
 * Cursor runs its own agent loop and executes its own tools (shell/read/edit/
 * mcp/…). We surface that activity as reasoning text — NOT as AI-SDK
 * `tool-call`/`tool-result` parts. opencode (a V3-native host) only treats
 * registered tools as callable; a provider-executed call naming a tool it
 * doesn't know (e.g. `mcp`, `shell`) is rejected as an "unavailable tool".
 * Rendering as reasoning keeps the activity visible without crossing the
 * tool-execution boundary. Tool outputs can be huge (file contents, search
 * dumps), so only the call (name + short arg summary) and error status are
 * shown — never the raw result.
 */
function formatToolCall(name: string, input: unknown): string {
	let arg = "";
	try {
		const s = typeof input === "string" ? input : JSON.stringify(input);
		if (s && s !== "{}" && s !== '""')
			arg = ` ${s.length > 120 ? `${s.slice(0, 120)}…` : s}`;
	} catch {
		// Non-serializable input; show the name only.
	}
	return `[tool] ${name}${arg}`;
}

/**
 * Synthetic error payload for a tool call whose completion never arrived
 * (run errored/cancelled/wedged mid-tool). Mirrors Cursor's own
 * `{status:"error"}` result union so consumers see a consistent shape.
 * Without a matching result, opencode renders the part as
 * "Tool execution aborted" and the block dangles forever.
 */
const DANGLING_TOOL_RESULT = {
	status: "error",
	error: "Cursor run ended before this tool call completed.",
};

/**
 * Translate the normalized Cursor agent events into an AI-SDK V3 stream.
 *
 * Pure with respect to the event source, so it can be tested by feeding a
 * fixed event sequence (no live agent required). Reasoning blocks are closed
 * before text begins so reasoning/text parts nest cleanly. Tool activity is
 * surfaced per {@link ToolDisplay} (default `"blocks"`): structured tool parts,
 * or reasoning lines when `"reasoning"` (see {@link formatToolCall}).
 */
export function cursorEventsToStream(
	events: AsyncIterable<CursorEvent>,
	toolDisplay: ToolDisplay = "blocks",
): ReadableStream<LanguageModelV3StreamPart> {
	return new ReadableStream<LanguageModelV3StreamPart>({
		async start(controller) {
			controller.enqueue({ type: "stream-start", warnings: [] });

			let textId: string | undefined;
			let textCount = 0;
			let reasoningId: string | undefined;
			let reasoningCount = 0;
			let usage: LanguageModelV3Usage | undefined;
			let streamedText = false;
			// Blocks-mode tool bookkeeping (open non-edit calls + buffered edits).
			const toolState = newBlockToolState();
			const closeDanglingToolCalls = () => {
				for (const part of blockDanglingParts(toolState)) {
					controller.enqueue(part);
				}
			};

			const closeReasoning = () => {
				if (reasoningId) {
					controller.enqueue({ type: "reasoning-end", id: reasoningId });
					reasoningId = undefined;
				}
			};
			// Close the open text part when reasoning resumes: hosts position a part
			// where it STARTED, so appending later text to an earlier part would
			// render the final answer above the reasoning that preceded it.
			const closeText = () => {
				if (textId) {
					controller.enqueue({ type: "text-end", id: textId });
					textId = undefined;
				}
			};
			const ensureText = () => {
				closeReasoning();
				if (!textId) {
					textId = `text-${textCount++}`;
					controller.enqueue({ type: "text-start", id: textId });
				}
				return textId;
			};
			const ensureReasoning = () => {
				closeText();
				if (!reasoningId) {
					reasoningId = `reasoning-${reasoningCount++}`;
					controller.enqueue({ type: "reasoning-start", id: reasoningId });
				}
				return reasoningId;
			};
			const reasoningLine = (text: string) => {
				controller.enqueue({
					type: "reasoning-delta",
					id: ensureReasoning(),
					delta: text,
				});
			};

			try {
				for await (const event of events) {
					switch (event.type) {
						case "text-delta":
							streamedText = true;
							controller.enqueue({
								type: "text-delta",
								id: ensureText(),
								delta: event.text,
							});
							break;
						case "reasoning-delta":
							reasoningLine(event.text);
							break;
						case "tool-call":
							if (toolDisplay === "blocks") {
								for (const part of blockToolCallParts(
									event.id,
									event.name,
									event.input,
									toolState,
								)) {
									controller.enqueue(part);
								}
							} else {
								reasoningLine(`\n${formatToolCall(event.name, event.input)}\n`);
							}
							break;
						case "tool-result":
							if (toolDisplay === "blocks") {
								for (const part of blockToolResultParts(
									event.id,
									event.name,
									event.result,
									event.isError,
									toolState,
								)) {
									controller.enqueue(part);
								}
							} else if (event.isError) {
								reasoningLine(`[tool] ${event.name} failed\n`);
							}
							break;
						case "usage":
							usage = mapUsage(event.usage);
							break;
						case "finish":
							if (!streamedText && event.text) {
								controller.enqueue({
									type: "text-delta",
									id: ensureText(),
									delta: event.text,
								});
							}
							break;
					}
				}

				closeDanglingToolCalls();
				closeReasoning();
				closeText();
				controller.enqueue({
					type: "finish",
					usage: usage ?? EMPTY_USAGE,
					finishReason: FINISH_STOP,
				});
				controller.close();
			} catch (err) {
				controller.enqueue({ type: "error", error: err });
				closeDanglingToolCalls();
				closeReasoning();
				closeText();
				controller.enqueue({
					type: "finish",
					usage: usage ?? EMPTY_USAGE,
					finishReason: FINISH_ERROR,
				});
				controller.close();
			}
		},
	});
}

/**
 * Aggregate the normalized Cursor agent events into a non-streaming result for
 * `doGenerate`. Same event source contract as {@link cursorEventsToStream}
 * (consumed via `for await`). Tool activity is surfaced per {@link ToolDisplay}
 * (default `"blocks"`): structured tool parts (see {@link blockToolCallParts} /
 * {@link blockToolResultParts}), or folded into the reasoning text when
 * `"reasoning"`.
 */
export async function cursorEventsToContent(
	events: AsyncIterable<CursorEvent>,
	toolDisplay: ToolDisplay = "blocks",
): Promise<{
	content: Array<LanguageModelV3Content>;
	finishReason: LanguageModelV3FinishReason;
	usage: LanguageModelV3Usage;
}> {
	const content: Array<LanguageModelV3Content> = [];
	const toolParts: Array<LanguageModelV3Content> = [];
	// Blocks-mode tool bookkeeping (open non-edit calls + buffered edits).
	const toolState = newBlockToolState();
	let text = "";
	let reasoning = "";
	let usage: LanguageModelV3Usage = EMPTY_USAGE;
	let finishReason: LanguageModelV3FinishReason = FINISH_STOP;

	try {
		for await (const event of events) {
			switch (event.type) {
				case "text-delta":
					text += event.text;
					break;
				case "reasoning-delta":
					reasoning += event.text;
					break;
				case "tool-call":
					if (toolDisplay === "blocks") {
						for (const part of blockToolCallParts(
							event.id,
							event.name,
							event.input,
							toolState,
						)) {
							toolParts.push(part as LanguageModelV3Content);
						}
					} else {
						reasoning += `\n${formatToolCall(event.name, event.input)}\n`;
					}
					break;
				case "tool-result":
					if (toolDisplay === "blocks") {
						for (const part of blockToolResultParts(
							event.id,
							event.name,
							event.result,
							event.isError,
							toolState,
						)) {
							toolParts.push(part as LanguageModelV3Content);
						}
					} else if (event.isError) {
						reasoning += `[tool] ${event.name} failed\n`;
					}
					break;
				case "usage":
					usage = mapUsage(event.usage);
					break;
				case "finish":
					if (!text && event.text) text = event.text;
					break;
			}
		}
	} catch {
		finishReason = FINISH_ERROR;
	}

	// Close out any tool call whose completion never arrived (see DANGLING_TOOL_RESULT).
	for (const part of blockDanglingParts(toolState)) {
		toolParts.push(part as LanguageModelV3Content);
	}

	if (reasoning) content.push({ type: "reasoning", text: reasoning });
	content.push(...toolParts);
	if (text) content.push({ type: "text", text });

	return { content, finishReason, usage };
}
