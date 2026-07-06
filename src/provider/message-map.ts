import { fileURLToPath } from "node:url";
import type {
	LanguageModelV3FilePart,
	LanguageModelV3Prompt,
} from "@ai-sdk/provider";
import type { SDKUserMessage } from "@cursor/sdk";

/**
 * How opencode's system prompt reaches the Cursor agent.
 *  - "rules" (default): delivered out-of-band as a Cursor project rule
 *    (see system-rule.ts) and therefore omitted from this flattened transcript.
 *  - "message": legacy — inlined as a `# System` block in the transcript.
 *    Injection-hardened Cursor models may reject this; kept for back-compat.
 *  - "omit": dropped entirely (no rule, no inline).
 */
export type SystemPromptMode = "rules" | "message" | "omit";

/**
 * Caps on inlined tool payloads in the flattened transcript. Tool outputs are
 * INCLUDED (truncated) rather than dropped so a fresh/diverged agent still sees
 * what prior tools produced, while a huge file read or search dump can't bloat
 * the replayed message unbounded.
 */
const TOOL_RESULT_CAP = 2000;
const TOOL_ARGS_CAP = 500;

function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value ?? null);
	} catch {
		return String(value);
	}
}

function truncate(text: string, cap: number): string {
	return text.length > cap
		? `${text.slice(0, cap)}…[+${text.length - cap} chars]`
		: text;
}

/**
 * Convert an AI-SDK prompt (the full conversation opencode sends on every call)
 * into a single Cursor `SDKUserMessage`.
 *
 * The Cursor agent keeps its own per-agent conversation memory, but opencode
 * re-sends the whole history each turn. To stay correct without double-counting
 * context, we create a fresh agent per turn (see language-model.ts) and flatten
 * the entire prompt into one transcript message. File attachments (images and
 * other files alike) are noted as text rather than attached natively: the
 * Cursor LOCAL SDK agent — the only backend this chat path uses — cannot accept
 * images in any form (URL images throw "URL images are only supported for cloud
 * SDK agents"; inline base64 images fail the run with an empty `status:"error"`,
 * surfacing as "Cursor run ended with status error" on an `@image` mention).
 */
export function promptToCursorMessage(
	prompt: LanguageModelV3Prompt,
	systemPrompt: SystemPromptMode = "rules",
): SDKUserMessage {
	const lines: string[] = [];

	prompt.forEach((message) => {
		switch (message.role) {
			case "system":
				// Only inline in legacy "message" mode. In "rules" mode the system
				// prompt is delivered via .cursor/rules (authoritative, not flagged);
				// in "omit" mode it is dropped.
				if (systemPrompt === "message") {
					lines.push(`# System\n${message.content}`);
				}
				break;
			case "user": {
				const text: string[] = [];
				for (const part of message.content) {
					if (part.type === "text") text.push(part.text);
					// File parts (images and other files) can't be forwarded to the
					// local Cursor agent, so note them as text instead of dropping
					// them — the agent still learns a file was referenced.
					else if (part.type === "file") text.push(fileNote(part));
				}
				lines.push(`# User\n${text.join("\n")}`);
				break;
			}
			case "assistant": {
				const text: string[] = [];
				for (const part of message.content) {
					if (part.type === "text") text.push(part.text);
					else if (part.type === "reasoning")
						text.push(`(thinking) ${part.text}`);
					else if (part.type === "tool-call")
						text.push(
							`[called ${part.toolName}(${truncate(stringify(part.input), TOOL_ARGS_CAP)})]`,
						);
					else if (part.type === "tool-result")
						text.push(
							`[result of ${part.toolName}: ${truncate(stringify(part.output), TOOL_RESULT_CAP)}]`,
						);
				}
				lines.push(`# Assistant\n${text.join("\n")}`);
				break;
			}
			case "tool": {
				for (const part of message.content) {
					if (part.type === "tool-result") {
						lines.push(
							`# Tool result (${part.toolName})\n${truncate(stringify(part.output), TOOL_RESULT_CAP)}`,
						);
					}
				}
				break;
			}
		}
	});

	return { text: lines.join("\n\n") };
}

/**
 * A short text note standing in for a file attachment that can't be forwarded
 * to the local Cursor agent.
 *
 * opencode hands `@`-mentions to the provider as file parts; `text/plain` and
 * directory mentions are already inlined as text upstream, so what reaches the
 * provider here is images and other media/binaries. The Cursor LOCAL SDK agent
 * (the only backend this chat path uses) cannot accept any of them:
 *   - `{ url }` images throw `ConfigurationError: URL images are only supported
 *     for cloud SDK agents`,
 *   - `{ data, mimeType }` inline-base64 images fail the run with an empty
 *     `status:"error"` (the "Cursor run ended with status error" a user hits on
 *     an `@image` mention — regardless of model).
 * So rather than attaching — and failing the whole turn — we note the file as
 * text. The run completes and the agent still learns a file was referenced.
 */
function fileNote(part: LanguageModelV3FilePart): string {
	const name = part.filename ?? describeSource(part.data) ?? "file";
	return `[attached file: ${name} (${part.mediaType}) — not forwarded to Cursor]`;
}

/** Matches strings with a URL scheme followed by `://` (http, https, file, …). */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

function describeSource(data: string | Uint8Array | URL): string | undefined {
	// file:// sources become filesystem paths: the agent runs locally with
	// workspace tools that operate on paths, so a path is actionable where a
	// file:// href is not.
	if (data instanceof URL)
		return data.protocol === "file:" ? fileUrlToPath(data) : data.href;
	// Only accept strings that look like a URL. AI-SDK file parts may carry
	// raw base64 in `data` (no `data:` prefix); returning that verbatim would
	// inline the entire blob into the note text.
	if (typeof data === "string" && URL_SCHEME.test(data))
		return data.startsWith("file://") ? fileUrlToPath(data) : data;
	return undefined;
}

/** Convert a file:// URL to a filesystem path, falling back to the href when invalid. */
function fileUrlToPath(url: string | URL): string {
	try {
		return fileURLToPath(url);
	} catch {
		return typeof url === "string" ? url : url.href;
	}
}

/**
 * Map one AI-SDK user turn into a Cursor `SDKUserMessage`. File parts (images
 * and other files) can't be forwarded to the local Cursor agent, so they're
 * noted as text via {@link fileNote} instead of attached natively.
 */
function userTurnToCursorMessage(
	message: Extract<LanguageModelV3Prompt[number], { role: "user" }>,
): SDKUserMessage {
	const text: string[] = [];
	for (const part of message.content) {
		if (part.type === "text") text.push(part.text);
		else if (part.type === "file") text.push(fileNote(part));
	}

	return { text: text.join("\n") };
}

/**
 * Extract only the final user turn as a Cursor message. Used when resuming a
 * pooled agent that already remembers the prior conversation, so we send just
 * the new message instead of the whole transcript. Returns `undefined` if the
 * last message isn't a user turn (caller should fall back to the full transcript).
 */
export function latestUserMessage(
	prompt: LanguageModelV3Prompt,
): SDKUserMessage | undefined {
	const last = prompt[prompt.length - 1];
	if (!last || last.role !== "user") return undefined;
	return userTurnToCursorMessage(last);
}

/**
 * Extract the last `count` CONTIGUOUS trailing user turns as Cursor messages,
 * in conversation order (oldest of the tail first, newest last). Used when
 * resuming a pooled agent after two-or-more user messages were queued while it
 * was busy: we replay just those new messages as sequential turns.
 *
 * Only the contiguous trailing run of user turns is considered; if the final
 * message isn't a user turn the result is empty. Returns fewer than `count`
 * entries when the trailing run is shorter (caller should fall back to a full
 * transcript replay when the array is empty or shorter than expected).
 */
export function trailingUserMessages(
	prompt: LanguageModelV3Prompt,
	count: number,
): SDKUserMessage[] {
	if (count <= 0) return [];
	const collected: SDKUserMessage[] = [];
	for (let i = prompt.length - 1; i >= 0 && collected.length < count; i--) {
		const message = prompt[i];
		if (!message || message.role !== "user") break;
		collected.push(userTurnToCursorMessage(message));
	}
	return collected.reverse();
}
