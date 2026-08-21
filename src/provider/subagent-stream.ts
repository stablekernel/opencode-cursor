import type { SubagentNestedEvent } from "./agent-events.js";
import {
	renderConversationSteps,
	resultText,
	type SubagentLiveSession,
} from "./subagent-bridge.js";

/** Keys a Cursor tool input may carry, best-title-first. */
const TITLE_KEYS = ["path", "command", "pattern", "query", "server"] as const;

/**
 * Derive a short label for a tool call, playing the role opencode's own
 * `state.title` plays — it is what the TUI renders after the tool name in the
 * subagent card's `↳ <Tool> <title>` subtitle.
 */
function toolTitle(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const record = input as Record<string, unknown>;
	for (const key of TITLE_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

/**
 * Accumulate a Cursor subagent's nested activity (text, reasoning, tool calls)
 * and flush it into the linked child session in batched markdown messages.
 *
 * The opencode public API can only add user-role messages to a child session
 * (`session.prompt({ noReply: true })`), so the transcript renders as a
 * sequence of user messages. Batching keeps the session API load low while
 * still surfacing activity live: text deltas are coalesced on a time window,
 * and tool results flush promptly so tool activity appears as it happens.
 */
export class SubagentTranscriptSink {
	/** Flush when this much time has elapsed since the last flush. */
	private static readonly FLUSH_INTERVAL_MS = 1500;

	private readonly session: SubagentLiveSession;
	private text = "";
	private reasoning = "";
	private readonly tools: string[] = [];
	private pending = false;
	private lastFlush = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private done = false;
	/** Nested call id → the running tool part written for it. */
	private readonly partHandles = new Map<
		string,
		{
			partID: string;
			callID: string;
			tool: string;
			title?: string;
			input: unknown;
			start: number;
		}
	>();
	/** Serialises tool-part writes so a result never overtakes its start. */
	private partChain: Promise<void> = Promise.resolve();
	private anonSeq = 0;

	/** Correlation key for a nested event that arrived without a call id. */
	private nestedKey(id: string): string {
		return id || `anon-${++this.anonSeq}`;
	}

	/** Enqueue a tool-part write; fire-and-forget, never throws. */
	private enqueuePart(write: () => Promise<unknown>): void {
		this.partChain = this.partChain
			.then(async () => {
				await write();
			})
			.catch(() => undefined);
	}

	constructor(session: SubagentLiveSession) {
		this.session = session;
	}

	/** The linked child session id (for stamping the task card's sessionId). */
	get childId(): string {
		return this.session.childId;
	}

	/** Feed a normalized nested subagent event into the sink. */
	push(event: SubagentNestedEvent): void {
		if (this.done) return;
		switch (event.type) {
			case "text":
				this.text += event.text;
				this.pending = true;
				break;
			case "reasoning":
				this.reasoning += event.text;
				this.pending = true;
				break;
			case "tool-start": {
				this.tools.push(`**\`${event.name}\`** ${formatArgs(event.input)}`);
				this.pending = true;
				// A real `tool` part in the child session — this is what the TUI's
				// subagent card reads for its live `↳ <Tool> <title>` subtitle.
				const key = this.nestedKey(event.id);
				const start = Date.now();
				this.enqueuePart(async () => {
					const partID = await this.session.toolPart({
						callID: key,
						tool: event.name,
						status: "running",
						title: toolTitle(event.input),
						input: event.input,
						start,
					});
					if (partID) {
						this.partHandles.set(key, {
							partID,
							callID: key,
							tool: event.name,
							title: toolTitle(event.input),
							input: event.input,
							start,
						});
					}
				});
				break;
			}
			case "tool-result": {
				this.tools.push(formatResult(event.name, event.result, event.isError));
				this.pending = true;
				// Complete the matching running part. A result with no observed
				// start (sink attached late) still gets a completed part so the
				// child session reflects every call the subagent made.
				const key = event.id || `result-${++this.anonSeq}`;
				this.enqueuePart(async () => {
					const handle = this.partHandles.get(key);
					this.partHandles.delete(key);
					await this.session.toolPart({
						callID: handle?.callID ?? key,
						tool: event.name,
						status: "completed",
						title: handle?.title,
						input: handle?.input,
						partID: handle?.partID,
						start: handle?.start ?? Date.now(),
						end: Date.now(),
					});
				});
				// Tool results flush promptly so activity appears as it happens.
				this.flushNow();
				return;
			}
		}
		this.armTimer();
	}

	/**
	 * Flush any buffered content, then append the subagent's final answer
	 * (`resultSuffix`), a render of its `conversationSteps` (its own
	 * text/thinking/tool activity), and the optional activity line, and mark
	 * the sink done. Further pushes and flushes become no-ops.
	 */
	async finalize(resultValue?: unknown, activity?: string): Promise<void> {
		if (this.done) return;
		this.done = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		const body = this.render();
		if (body) await this.session.flush(body);
		const suffix =
			typeof resultValue === "object" && resultValue !== null
				? (resultValue as Record<string, unknown>)["resultSuffix"]
				: undefined;
		if (typeof suffix === "string" && suffix) await this.session.flush(suffix);
		const steps = renderConversationSteps(resultValue);
		if (steps) await this.session.flush(steps);
		// Complete any tool calls still open — a subagent that ended without a
		// tool-result event would otherwise leave parts `running` forever. Must
		// precede session.finalize(), which closes the handle to further writes.
		await this.partChain;
		for (const [, handle] of this.partHandles) {
			await this.session.toolPart({
				callID: handle.callID,
				tool: handle.tool,
				status: "completed",
				title: handle.title,
				input: handle.input,
				partID: handle.partID,
				start: handle.start,
				end: Date.now(),
			});
		}
		this.partHandles.clear();
		if (activity) await this.session.finalize(activity);
		else await this.session.finalize();
	}

	private armTimer(): void {
		if (this.done || this.timer) return;
		const elapsed = Date.now() - this.lastFlush;
		const delay = Math.max(0, SubagentTranscriptSink.FLUSH_INTERVAL_MS - elapsed);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.flushNow();
		}, delay);
		this.timer.unref?.();
	}

	private flushNow(): void {
		if (this.done) return;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (!this.pending) return;
		const body = this.render();
		this.pending = false;
		this.lastFlush = Date.now();
		if (body) void this.session.flush(body);
	}

	/** Render the accumulated activity into a single markdown message. */
	private render(): string {
		const parts: string[] = [];
		if (this.text.trim()) parts.push(this.text.trim());
		if (this.reasoning.trim()) parts.push(`> ${this.reasoning.trim()}`);
		if (this.tools.length > 0) parts.push(this.tools.join("\n\n"));
		const body = parts.join("\n\n").trim();
		// Consume the rendered buffers so a later flush only carries new content.
		this.text = "";
		this.reasoning = "";
		this.tools.length = 0;
		return body;
	}
}

/** Render a tool call's arguments as a compact inline string. */
function formatArgs(input: unknown): string {
	let s = "";
	try {
		s = typeof input === "string" ? input : JSON.stringify(input);
	} catch {
		return "";
	}
	if (!s || s === "{}" || s === '""') return "";
	return s;
}

/** Render a tool result as a fenced block (or an error marker). */
function formatResult(name: string, result: unknown, isError: boolean): string {
	if (isError) return `**\`${name}\`** — _failed_`;
	const text = resultText(result);
	if (!text) return `**\`${name}\`** — _done_`;
	return `**\`${name}\`**\n\n\`\`\`\n${text}\n\`\`\``;
}
