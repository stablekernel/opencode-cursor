import type { SubagentNestedEvent } from "./agent-events.js";
import {
	renderConversationSteps,
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
 * Accumulate a Cursor subagent's nested activity (text, reasoning) and flush
 * it into the linked child session as a single growing transcript message.
 *
 * The opencode public API can only add user-role messages to a child session
 * (`session.prompt({ noReply: true })`), and posting each buffer snapshot as a
 * new message fragments a flowing paragraph across many messages. Instead the
 * live session grows the seeded message's text part in place (`flush` takes
 * the FULL cumulative transcript each time), so the child session renders as
 * prompt + one live-updating message. Tool activity is deliberately NOT
 * rendered as markdown — the TUI's subagent card already shows it live via
 * the `tool` parts this sink writes (`tool-start`/`tool-result`).
 *
 * Batching keeps the PATCH load low while still surfacing activity live:
 * text deltas are coalesced on a time window.
 */
export class SubagentTranscriptSink {
	/** Flush when this much time has elapsed since the last flush. */
	private static readonly FLUSH_INTERVAL_MS = 1500;

	private readonly session: SubagentLiveSession;
	private text = "";
	private reasoning = "";
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
				// Tool activity renders via the child session's `tool` parts, not
				// markdown in the transcript — writing both duplicates it in the
				// subagent pane.
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
				break;
			}
		}
		this.armTimer();
	}

	/**
	 * Merge the subagent's final answer (`resultSuffix`), a render of its
	 * `conversationSteps` (its own text/thinking/tool activity), and the
	 * optional activity line into the cumulative transcript, flush once, and
	 * mark the sink done. Further pushes and flushes become no-ops.
	 */
	async finalize(resultValue?: unknown, activity?: string): Promise<void> {
		if (this.done) return;
		this.done = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		const suffix =
			typeof resultValue === "object" && resultValue !== null
				? (resultValue as Record<string, unknown>)["resultSuffix"]
				: undefined;
		if (typeof suffix === "string" && suffix) this.text += `\n\n${suffix}`;
		const steps = renderConversationSteps(resultValue);
		if (steps) this.text += `\n\n${steps}`;
		if (activity) this.text += `\n\n${activity}`;
		if (this.text.trim() || this.reasoning.trim()) {
			this.pending = false;
			await this.session.flush(this.render());
		}
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
		await this.session.finalize();
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

	/**
	 * Render the FULL cumulative transcript (everything pushed so far, plus
	 * finalize additions). `flush` replaces the growing message's text with
	 * this, so each flush carries the whole transcript, not just new content.
	 */
	private render(): string {
		const parts: string[] = [];
		if (this.text.trim()) parts.push(this.text.trim());
		if (this.reasoning.trim()) parts.push(`> ${this.reasoning.trim()}`);
		return parts.join("\n\n").trim();
	}
}
