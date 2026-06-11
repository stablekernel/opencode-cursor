import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import type { SDKImage, SDKUserMessage } from "@cursor/sdk";

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
 * the entire prompt into one transcript message. Images from the final user
 * turn are attached natively so multimodal models can see them.
 */
export function promptToCursorMessage(
	prompt: LanguageModelV3Prompt,
): SDKUserMessage {
	const lines: string[] = [];
	const images: SDKImage[] = [];

	prompt.forEach((message, index) => {
		const isLast = index === prompt.length - 1;
		switch (message.role) {
			case "system":
				lines.push(`# System\n${message.content}`);
				break;
			case "user": {
				const text: string[] = [];
				for (const part of message.content) {
					if (part.type === "text") text.push(part.text);
					else if (
						part.type === "file" &&
						part.mediaType.startsWith("image/")
					) {
						const image = fileToImage(part.data, part.mediaType);
						// Only attach images natively for the final user turn; earlier ones
						// are referenced by transcript order.
						if (isLast && image) images.push(image);
						text.push("[image attached]");
					}
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

	const out: SDKUserMessage = { text: lines.join("\n\n") };
	if (images.length > 0) out.images = images;
	return out;
}

function fileToImage(
	data: string | Uint8Array | URL,
	mediaType: string,
): SDKImage | undefined {
	if (data instanceof URL) return { url: data.toString() };
	if (typeof data === "string") {
		// Either a URL or already-base64 encoded data.
		if (/^https?:\/\//i.test(data)) return { url: data };
		return { data, mimeType: mediaType };
	}
	if (data instanceof Uint8Array) {
		return { data: Buffer.from(data).toString("base64"), mimeType: mediaType };
	}
	return undefined;
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

	const text: string[] = [];
	const images: SDKImage[] = [];
	for (const part of last.content) {
		if (part.type === "text") text.push(part.text);
		else if (part.type === "file" && part.mediaType.startsWith("image/")) {
			const image = fileToImage(part.data, part.mediaType);
			if (image) images.push(image);
			text.push("[image attached]");
		}
	}

	const out: SDKUserMessage = { text: text.join("\n") };
	if (images.length > 0) out.images = images;
	return out;
}
