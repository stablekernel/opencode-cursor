import { createHash } from "node:crypto";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import type { McpServerConfig } from "@cursor/sdk";

/**
 * Per-session bookkeeping that lets the provider decide, on each turn, whether
 * it can safely resume the pooled Cursor agent (and send only the new message)
 * or must start fresh and re-send the whole transcript.
 *
 * We hash ONLY the parts opencode replays verbatim — the system prompt and the
 * user messages. We deliberately do NOT hash assistant output: opencode
 * re-serializes our streamed reply (reasoning, tool blocks) back into the next
 * prompt in a shape we can't predict byte-for-byte, so hashing it would
 * spuriously mismatch every turn and silently collapse to always-full-replay.
 * The system prompt + user-message sequence is the stable identity of a
 * conversation.
 */
export interface TranscriptRecord {
	/** Cursor agentId currently pooled for the session. */
	agentId: string;
	/** Hash of the concatenated system message content. */
	systemHash: string;
	/** Ordered hash per user message (text + a stable image token). */
	userHashes: string[];
	/**
	 * Hash of the MCP server set the pooled agent was created with. A resumed
	 * Cursor agent keeps its original MCP servers, so when this changes between
	 * turns the pool must create a fresh agent rather than resume.
	 */
	mcpHash?: string;
}

/** What kind of turn this is relative to the session's last recorded state. */
export type TurnKind =
	/** No prior record: first turn of the session. */
	| "new"
	/** System prompt differs (opencode's non-chat side call, e.g. title gen). */
	| "side-call"
	/** Prior user sequence is a strict prefix + exactly one new trailing user msg. */
	| "continuation"
	/** Prior user sequence is a strict prefix + two-or-more new trailing user messages. */
	| "continuation-multi"
	/** Edit / revert / compaction — prior prefix no longer holds. */
	| "divergence";

export interface TurnClassification {
	kind: TurnKind;
	/** Fingerprint of the CURRENT prompt, to store when (re)pooling. */
	fingerprint: { systemHash: string; userHashes: string[] };
	/**
	 * Number of new trailing user messages relative to the prior record. Set on
	 * `continuation` (always 1) and `continuation-multi` (>= 2); undefined for
	 * other kinds. Lets the caller know how many tail messages to send on resume.
	 */
	newUserCount?: number;
}

function sha(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

/**
 * Stable hash of the MCP server set handed to `Agent.create`. Keys are sorted
 * so map ordering never changes the result; empty/undefined sets hash to "".
 */
export function mcpServersFingerprint(
	servers: Record<string, McpServerConfig> | undefined,
): string {
	if (!servers) return "";
	const keys = Object.keys(servers).sort();
	if (keys.length === 0) return "";
	return sha(JSON.stringify(keys.map((k) => [k, servers[k]])));
}

/** Stable key for one user message: its text plus a token per attached image. */
function userMessageKey(
	message: Extract<LanguageModelV3Prompt[number], { role: "user" }>,
): string {
	const parts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text") parts.push(`t:${part.text}`);
		else if (part.type === "file") parts.push(`f:${part.mediaType}`);
	}
	return parts.join("\n");
}

/** Compute the system + user-message fingerprint of a prompt. */
export function fingerprint(prompt: LanguageModelV3Prompt): {
	systemHash: string;
	userHashes: string[];
} {
	const systemParts: string[] = [];
	const userHashes: string[] = [];
	for (const message of prompt) {
		if (message.role === "system") systemParts.push(message.content);
		else if (message.role === "user")
			userHashes.push(sha(userMessageKey(message)));
	}
	return { systemHash: sha(systemParts.join("\n")), userHashes };
}

/** True when `prefix` is a strict element-wise prefix of `full`. */
function isStrictPrefix(prefix: string[], full: string[]): boolean {
	if (prefix.length >= full.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (prefix[i] !== full[i]) return false;
	}
	return true;
}

/**
 * Classify the current turn against the session's last recorded fingerprint.
 *
 * Order matters:
 *  1. no record           -> "new"
 *  2. system prompt changed -> "side-call" (don't touch the pool)
 *  3. prior user hashes are a strict prefix AND exactly one new trailing user
 *     message AND the last prompt message is a user turn -> "continuation"
 *  4. prior user hashes are a strict prefix AND two-or-more new user messages
 *     forming a CONTIGUOUS user-turn tail of the prompt -> "continuation-multi"
 *     (interleaved assistant turns — e.g. an aborted reply between queued
 *     messages — disqualify, because a resumed replay of only the contiguous
 *     tail would silently drop the earlier queued message)
 *  5. otherwise            -> "divergence" (edit/revert/compaction)
 *
 * Worst case on any misclassification is a single wasted full replay that
 * self-heals on the next turn — never worse than the `session: false` default.
 */
export function classifyTurn(
	prev: TranscriptRecord | undefined,
	prompt: LanguageModelV3Prompt,
): TurnClassification {
	const fp = fingerprint(prompt);
	if (!prev) return { kind: "new", fingerprint: fp };
	if (prev.systemHash !== fp.systemHash)
		return { kind: "side-call", fingerprint: fp };

	const lastIsUser = prompt[prompt.length - 1]?.role === "user";
	const newUserCount = fp.userHashes.length - prev.userHashes.length;
	const isPrefix = isStrictPrefix(prev.userHashes, fp.userHashes);
	if (lastIsUser && isPrefix && newUserCount === 1) {
		return { kind: "continuation", fingerprint: fp, newUserCount: 1 };
	}
	// The N new messages must be the prompt's contiguous trailing user turns.
	// When an assistant turn sits between them (aborted reply between queued
	// interjections), a resumed tail-only replay would drop the earlier queued
	// message — so that shape must take the divergence full-replay path.
	const tailContiguous =
		newUserCount >= 2 &&
		prompt.length >= newUserCount &&
		prompt
			.slice(prompt.length - newUserCount)
			.every((m) => m.role === "user");
	if (lastIsUser && isPrefix && tailContiguous) {
		return { kind: "continuation-multi", fingerprint: fp, newUserCount };
	}
	return { kind: "divergence", fingerprint: fp };
}
