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
 * names contain `/` (e.g. `myserver/find_symbol` → `cursor_myserver_find_symbol`).
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
 * Build a provider-executed dynamic `tool-call` under an EXACT (already-final)
 * tool name. `input` is a stringified JSON object per the V3 spec. Both
 * `providerExecuted` and `dynamic` are set so ai's `parseToolCall` accepts the
 * part without registered-tool validation, and a host that hasn't registered
 * the named tool degrades to a generic dynamic block instead of erroring.
 */
function nativeToolCall(
	id: string,
	toolName: string,
	input: unknown,
): BlockToolPart {
	return {
		type: "tool-call",
		toolCallId: id,
		toolName,
		input: safeJsonString(input),
		providerExecuted: true,
		dynamic: true,
	} as BlockToolPart;
}

/**
 * Build a provider-executed dynamic `tool-result` under an EXACT tool name. Per
 * the V3 spec (and ai v6's `runToolsTransformation`, which reads
 * `chunk.result` / `chunk.isError`) the payload goes in `result`; `result` is
 * typed `NonNullable<JSONValue>` so a missing payload is coalesced to `null`.
 */
function nativeToolResult(
	id: string,
	toolName: string,
	result: unknown,
	isError: boolean,
): BlockToolPart {
	return {
		type: "tool-result",
		toolCallId: id,
		toolName,
		result: (result ?? null) as never,
		isError,
		providerExecuted: true,
		dynamic: true,
	} as BlockToolPart;
}

/**
 * Build a generic `tool-call` for a Cursor tool with no native opencode
 * counterpart. The name is `cursor_`-prefixed so it can't collide with a tool
 * opencode has registered.
 */
function toolCallObj(id: string, name: string, input: unknown): BlockToolPart {
	return nativeToolCall(id, blockToolName(name), input);
}

/** Build a generic (`cursor_`-prefixed) `tool-result`. */
function toolResultObj(
	id: string,
	name: string,
	result: unknown,
	isError: boolean,
): BlockToolPart {
	return nativeToolResult(id, blockToolName(name), result, isError);
}

/** Cursor's file-edit tool surfaces with this name (its `toolCall.type`). */
const EDIT_TOOL_NAME = "edit";

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

/** Unwrap a Cursor `{ status:"success", value }` result to its `value`. */
function successValue(result: unknown): unknown {
	return isRecord(result) && result["status"] === "success"
		? result["value"]
		: undefined;
}

/** The `{title, metadata, output}` shape opencode folds into a tool part's state. */
interface FoldedResult {
	title: string;
	metadata: Record<string, unknown>;
	output: string;
}

/**
 * Maps a Cursor tool's call/result onto an opencode tool so opencode renders
 * something nicer than a raw-JSON block. Mirrors the `edit` mapping: parts are
 * emitted `providerExecuted` + `dynamic`, so the call is never executed on disk
 * and a host that hasn't registered the tool degrades to a generic dynamic
 * block.
 *
 *  - `tool` is opencode's REGISTERED tool name when there's a native renderer to
 *    reuse (`bash`, `read`, `websearch`, …). Omit it for "format-only" adapters
 *    (`readLints`, `delete`): the part stays a `cursor_*` block, but `result`
 *    still folds the payload into a clean `output` string so opencode's generic
 *    renderer shows formatted text instead of dumped JSON.
 *  - `input` translates Cursor's arg keys to the names opencode's renderer reads
 *    (e.g. Cursor `path` → opencode `filePath`).
 *  - `result` folds a SUCCESSFUL Cursor result `value` into `{title, metadata,
 *    output}`; returning `null` falls back to a generic block (unexpected shape).
 */
interface NativeToolAdapter {
	tool?: string;
	input(args: unknown): Record<string, unknown>;
	result(value: unknown, args: unknown): FoldedResult | null;
}

/**
 * Flatten a Cursor MCP result `value` (`{ content: [{ text: { text } }, …] }`)
 * into plain text. Returns `null` when `value` isn't MCP-shaped, so callers can
 * fall back to the raw payload. An MCP `content` array that holds no text
 * (e.g. only images) yields a `"[image]"`-style placeholder rather than `null`.
 */
function flattenMcpContent(value: unknown): string | null {
	if (!isRecord(value) || !Array.isArray(value["content"])) return null;
	const parts = (value["content"] as unknown[]).flatMap((item) => {
		const text = isRecord(item) ? strField(item["text"], "text") : undefined;
		if (text !== undefined) return [text];
		if (isRecord(item) && isRecord(item["image"])) return ["[image]"];
		return [];
	});
	return parts.join("\n");
}

/**
 * Fold a generic (non-adapter) Cursor result into a clean `output` string IF
 * it's an MCP result; otherwise `null` so the raw payload is passed through.
 * This stops every MCP tool (web search, custom servers, …) from dumping the
 * nested `{content:[{text:{text}}]}` JSON into the block.
 */
function mcpFold(result: unknown): FoldedResult | null {
	const text = flattenMcpContent(successValue(result));
	if (text === null) return null;
	return { title: "", metadata: {}, output: text };
}

/** Cursor MCP call args nest the real tool input under `args.args`. */
function mcpInputArgs(args: unknown): unknown {
	return isRecord(args) ? args["args"] : undefined;
}

/** Map a Cursor MCP `providerIdentifier` to a websearch provider label key. */
function webSearchProvider(args: unknown): string | undefined {
	const id = (strField(args, "providerIdentifier") ?? "").toLowerCase();
	if (id.includes("exa")) return "exa";
	if (id.includes("parallel")) return "parallel";
	return undefined;
}

/** A Cursor MCP tool whose name looks like a web search (`web_search`, …). */
function isWebSearchName(name: string): boolean {
	return /web[_-]?search/i.test(name);
}

/**
 * Cursor web search arrives as an MCP tool; map it onto opencode's native
 * `websearch` renderer (query subtitle + result body). The query lives in the
 * nested MCP input (`args.args.query`); the result is MCP `content`.
 */
const WEBSEARCH_ADAPTER: NativeToolAdapter = {
	tool: "websearch",
	input: (args) => {
		const query = strField(mcpInputArgs(args), "query");
		return query !== undefined ? { query } : {};
	},
	result: (value, args) => {
		const provider = webSearchProvider(args);
		return {
			title: "",
			metadata: provider ? { provider } : {},
			output: flattenMcpContent(value) ?? "",
		};
	},
};

/**
 * Resolve a Cursor tool name (+ call args) to an adapter, or `undefined` for a
 * plain `cursor_*` block. `edit` is handled separately (its native call input
 * depends on the diff in the result).
 */
function resolveAdapter(
	name: string,
	_input: unknown,
): NativeToolAdapter | undefined {
	const exact = NATIVE_ADAPTERS[name];
	if (exact) return exact;
	if (isWebSearchName(name)) return WEBSEARCH_ADAPTER;
	return undefined;
}

/** Cursor todo status (`inProgress`) → opencode todo status (`in_progress`). */
function mapTodoStatus(status: unknown): string {
	if (status === "inProgress") return "in_progress";
	return typeof status === "string" ? status : "pending";
}

/** Normalize Cursor `updateTodos` args into opencode `todowrite` todos. */
function mapTodos(args: unknown): Array<{ content: string; status: string }> {
	const todos =
		isRecord(args) && Array.isArray(args["todos"]) ? args["todos"] : [];
	return (todos as unknown[]).flatMap((t) =>
		isRecord(t) && typeof t["content"] === "string"
			? [
					{
						content: t["content"] as string,
						status: mapTodoStatus(t["status"]),
					},
				]
			: [],
	);
}

/**
 * Cursor tool name → opencode native tool adapter. Cursor tools without a
 * natural opencode counterpart (`delete`, `mcp`, `semSearch`, `readLints`,
 * `generateImage`, `createPlan`, `recordScreen`, `task`) are intentionally
 * absent and fall through to generic `cursor_*` blocks. `edit` is handled
 * separately (its native call input depends on the diff in the result).
 */
const NATIVE_ADAPTERS: Record<string, NativeToolAdapter> = {
	// Cursor `shell` → opencode `bash` (console renderer).
	shell: {
		tool: "bash",
		input: (args) => ({ command: strField(args, "command") ?? "" }),
		result: (value, args) => {
			if (!isRecord(value)) return null;
			const command = strField(args, "command") ?? "";
			const stdout = strField(value, "stdout") ?? "";
			const stderr = strField(value, "stderr") ?? "";
			const exit = numField(value, "exitCode");
			const body = [stdout, stderr].filter((s) => s.length > 0).join("\n");
			const output =
				exit !== undefined && exit !== 0
					? `${body}${body ? "\n" : ""}(exit ${exit})`
					: body;
			return {
				title: command,
				metadata: { command, output, exit: exit ?? 0 },
				output,
			};
		},
	},
	// Cursor `read` → opencode `read`.
	read: {
		tool: "read",
		input: (args) => ({ filePath: strField(args, "path") ?? "" }),
		result: (value, args) => {
			const content = strField(value, "content");
			if (content === undefined) return null;
			const filePath = strField(args, "path") ?? "";
			const totalLines = numField(value, "totalLines");
			return {
				title: filePath,
				metadata: {
					preview: content.split("\n").slice(0, 20).join("\n"),
					loaded: [] as string[],
					...(totalLines !== undefined ? { totalLines } : {}),
				},
				output: content,
			};
		},
	},
	// Cursor `write` → opencode `write` (renders input.content as the new file).
	write: {
		tool: "write",
		input: (args) => ({
			filePath: strField(args, "path") ?? "",
			content: strField(args, "fileText") ?? "",
		}),
		result: (value, args) => {
			const filePath = strField(args, "path") ?? "";
			const lines = numField(value, "linesCreated");
			const output =
				lines !== undefined
					? `Wrote ${lines} line${lines === 1 ? "" : "s"}.`
					: "Wrote file successfully.";
			return {
				title: filePath,
				metadata: { diagnostics: {}, filepath: filePath, exists: false },
				output,
			};
		},
	},
	// Cursor `glob` → opencode `glob`.
	glob: {
		tool: "glob",
		input: (args) => {
			const pattern = strField(args, "globPattern") ?? "";
			const dir = strField(args, "targetDirectory");
			return dir ? { pattern, path: dir } : { pattern };
		},
		result: (value) => {
			if (!isRecord(value) || !Array.isArray(value["files"])) return null;
			const files = (value["files"] as unknown[]).filter(
				(f): f is string => typeof f === "string",
			);
			const truncated =
				value["clientTruncated"] === true || value["ripgrepTruncated"] === true;
			return {
				title: "",
				metadata: { count: files.length, truncated },
				output: files.length > 0 ? files.join("\n") : "No files found",
			};
		},
	},
	// Cursor `grep` → opencode `grep` (flatten matches into ripgrep-style text).
	grep: {
		tool: "grep",
		input: (args) => {
			const out: Record<string, unknown> = {
				pattern: strField(args, "pattern") ?? "",
			};
			const p = strField(args, "path");
			if (p) out["path"] = p;
			const g = strField(args, "glob");
			if (g) out["include"] = g;
			return out;
		},
		result: (value) => {
			if (!isRecord(value)) return null;
			const unions: unknown[] = [];
			const ws = value["workspaceResults"];
			if (isRecord(ws)) unions.push(...Object.values(ws));
			if (value["activeEditorResult"] !== undefined)
				unions.push(value["activeEditorResult"]);
			const lines: string[] = [];
			let total = 0;
			let current = "";
			for (const u of unions) {
				if (!isRecord(u)) continue;
				const output = u["output"];
				if (
					u["type"] === "content" &&
					isRecord(output) &&
					Array.isArray(output["matches"])
				) {
					for (const m of output["matches"] as unknown[]) {
						if (!isRecord(m)) continue;
						const file = strField(m, "file") ?? "";
						const line = numField(m, "lineNumber");
						const text = strField(m, "line") ?? "";
						if (current !== file) {
							if (current) lines.push("");
							current = file;
							lines.push(`${file}:`);
						}
						lines.push(
							line !== undefined ? `  Line ${line}: ${text}` : `  ${text}`,
						);
						total++;
					}
				} else if (
					u["type"] === "files" &&
					isRecord(output) &&
					Array.isArray(output["files"])
				) {
					for (const f of output["files"] as unknown[]) {
						if (typeof f === "string") {
							lines.push(f);
							total++;
						}
					}
				}
			}
			return {
				title: "",
				metadata: { matches: total, truncated: false },
				output:
					total > 0
						? [
								`Found ${total} match${total === 1 ? "" : "es"}`,
								"",
								...lines,
							].join("\n")
						: "No matches found",
			};
		},
	},
	// Cursor `ls` → opencode `list` (flatten the directory tree into paths).
	ls: {
		tool: "list",
		input: (args) => ({ path: strField(args, "path") ?? "" }),
		result: (value) => {
			if (!isRecord(value)) return null;
			const root = value["directoryTreeRoot"];
			if (!isRecord(root)) return null;
			const out: string[] = [];
			const walk = (node: Record<string, unknown>) => {
				const base = strField(node, "absPath") ?? "";
				const files = Array.isArray(node["childrenFiles"])
					? node["childrenFiles"]
					: [];
				for (const f of files) {
					const name = strField(f, "name");
					if (name) out.push(`${base}/${name}`);
				}
				const dirs = Array.isArray(node["childrenDirs"])
					? node["childrenDirs"]
					: [];
				for (const d of dirs) {
					if (!isRecord(d)) continue;
					out.push(`${strField(d, "absPath") ?? ""}/`);
					walk(d);
				}
			};
			walk(root);
			return {
				title: strField(root, "absPath") ?? "",
				metadata: {},
				output: out.length > 0 ? out.join("\n") : "(empty)",
			};
		},
	},
	// Cursor `updateTodos` → opencode `todowrite` (todo checklist renderer).
	updateTodos: {
		tool: "todowrite",
		input: (args) => ({ todos: mapTodos(args) }),
		result: (_value, args) => {
			const todos = mapTodos(args);
			const done = todos.filter((t) => t.status === "completed").length;
			return {
				title: `${done}/${todos.length}`,
				metadata: { todos },
				output: `Updated ${todos.length} todo${todos.length === 1 ? "" : "s"}.`,
			};
		},
	},
	// Cursor `task` (subagent) → opencode `task` (agent card: name + description).
	// Non-clickable here — the subagent ran inside Cursor, not as an opencode
	// child session — but the native card reads far better than raw JSON.
	task: {
		tool: "task",
		input: (args) => {
			const description = strField(args, "description") ?? "";
			const sub = isRecord(args) ? args["subagentType"] : undefined;
			const subagent =
				strField(sub, "name") ?? strField(sub, "kind") ?? undefined;
			return subagent
				? { description, subagent_type: subagent }
				: { description };
		},
		result: (value, args) => {
			const description = strField(args, "description") ?? "";
			const suffix = strField(value, "resultSuffix");
			const background = isRecord(value) && value["isBackground"] === true;
			return {
				title: description,
				metadata: background ? { background: true } : {},
				output: suffix ?? "Subagent task completed.",
			};
		},
	},
	// Cursor `readLints` has no opencode counterpart — format-only: render the
	// diagnostics as a readable list instead of dumping the nested JSON.
	readLints: {
		input: (args) => {
			const paths =
				isRecord(args) && Array.isArray(args["paths"]) ? args["paths"] : [];
			return { paths };
		},
		result: (value) => {
			const files =
				isRecord(value) && Array.isArray(value["fileDiagnostics"])
					? (value["fileDiagnostics"] as unknown[])
					: [];
			const lines: string[] = [];
			let total = 0;
			for (const file of files) {
				if (!isRecord(file)) continue;
				const diags = Array.isArray(file["diagnostics"])
					? (file["diagnostics"] as unknown[])
					: [];
				if (diags.length === 0) continue;
				lines.push(`${strField(file, "path") ?? ""}`);
				for (const d of diags) {
					if (!isRecord(d)) continue;
					const severity = strField(d, "severity") ?? "info";
					const start = isRecord(d["range"]) ? d["range"]["start"] : undefined;
					const line = numField(start, "line");
					const char = numField(start, "character");
					const loc =
						line !== undefined
							? ` L${line + 1}${char !== undefined ? `:${char + 1}` : ""}`
							: "";
					lines.push(`  ${severity}${loc}: ${strField(d, "message") ?? ""}`);
					total++;
				}
			}
			return {
				title:
					total > 0
						? `${total} problem${total === 1 ? "" : "s"}`
						: "No problems",
				metadata: { count: total },
				output: total > 0 ? lines.join("\n") : "No problems found.",
			};
		},
	},
	// Cursor `delete` has no opencode counterpart — format-only: a one-line
	// confirmation instead of `{"fileSize":N}`.
	delete: {
		input: (args) => ({ path: strField(args, "path") ?? "" }),
		result: (value, args) => {
			const path = strField(args, "path") ?? "";
			const size = numField(value, "fileSize");
			return {
				title: path,
				metadata: {},
				output:
					size !== undefined
						? `Deleted ${path} (${size} bytes).`
						: `Deleted ${path}.`,
			};
		},
	},
};

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
 *  - `open`: non-edit calls awaiting their result. Stores the FINAL emitted tool
 *    name (native, e.g. `bash`, or generic `cursor_*`), the native adapter (if
 *    any) used to fold the result, and the original Cursor args (some adapters
 *    build their result from the call args, e.g. `write`/`updateTodos`).
 *  - `pendingEdits`: edit calls held until their result, which carries the diff
 *    needed to emit a schema-valid native `edit` call (id → filePath).
 */
interface OpenToolCall {
	toolName: string;
	adapter?: NativeToolAdapter;
	args: unknown;
}

interface BlockToolState {
	open: Map<string, OpenToolCall>;
	pendingEdits: Map<string, string>;
}

function newBlockToolState(): BlockToolState {
	return { open: new Map(), pendingEdits: new Map() };
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
	const adapter = resolveAdapter(name, input);
	if (adapter) {
		// Adapter mapping: native registered tool (`adapter.tool`) when there's a
		// renderer to reuse, else a `cursor_*` block whose result is still folded
		// into clean output (format-only adapters).
		const toolName = adapter.tool ?? blockToolName(name);
		state.open.set(id, { toolName, adapter, args: input });
		return [nativeToolCall(id, toolName, adapter.input(input))];
	}
	// No adapter: generic prefixed block.
	const toolName = blockToolName(name);
	state.open.set(id, { toolName, args: input });
	return [nativeToolCall(id, toolName, input)];
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
	const open = state.open.get(id);
	state.open.delete(id);
	const toolName = open?.toolName ?? blockToolName(name);
	if (open?.adapter && !isError) {
		const value = successValue(result);
		if (value !== undefined) {
			const folded = open.adapter.result(value, open.args);
			if (folded) return [nativeToolResult(id, toolName, folded, false)];
		}
	}
	if (!isError) {
		// No adapter (or it declined): if this is an MCP result, fold its `content`
		// into readable text so the block isn't a raw JSON dump.
		const folded = mcpFold(result);
		if (folded) return [nativeToolResult(id, toolName, folded, false)];
	}
	// Generic block / error / unexpected shape: emit the raw Cursor result under
	// the (already-resolved) tool name.
	return [nativeToolResult(id, toolName, result, isError)];
}

/**
 * Parts that close out any tool call whose completion never arrived (run
 * errored/cancelled mid-tool) so blocks never dangle as "Tool execution
 * aborted". Clears the state.
 */
function blockDanglingParts(state: BlockToolState): BlockToolPart[] {
	const parts: BlockToolPart[] = [];
	for (const [id, open] of state.open) {
		parts.push(nativeToolResult(id, open.toolName, DANGLING_TOOL_RESULT, true));
	}
	state.open.clear();
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
								const parts = blockToolCallParts(
									event.id,
									event.name,
									event.input,
									toolState,
								);
								// Edit calls buffer until their result (no parts yet) — keep
								// the open narration part alive across the gap. Every other
								// tool emits immediately, so close open text/reasoning first
								// so post-tool narration lands in a later part (hosts position
								// parts where they START).
								if (parts.length > 0) {
									closeText();
									closeReasoning();
								}
								for (const part of parts) {
									controller.enqueue(part);
								}
							} else {
								reasoningLine(`\n${formatToolCall(event.name, event.input)}\n`);
							}
							break;
						case "tool-result":
							if (toolDisplay === "blocks") {
								const parts = blockToolResultParts(
									event.id,
									event.name,
									event.result,
									event.isError,
									toolState,
								);
								if (parts.length > 0) {
									closeText();
									closeReasoning();
								}
								for (const part of parts) {
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
