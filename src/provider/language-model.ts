import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3Content,
	LanguageModelV3FinishReason,
	LanguageModelV3StreamPart,
	LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { LoadAPIKeyError } from "@ai-sdk/provider";
import type {
	AgentDefinition,
	McpServerConfig,
	SettingSource,
	AgentModeOption,
	SDKUserMessage,
} from "@cursor/sdk";
import { resolveCursorApiKey } from "../api-key.js";
import {
	latestUserMessage,
	promptToCursorMessage,
	trailingUserMessages,
	type SystemPromptMode,
} from "./message-map.js";
import { extractSystemText, resolveSystemDelivery } from "./system-rule.js";
import {
	sendAgentTurnSilently,
	streamAgentTurn,
	type CursorEvent,
} from "./agent-events.js";
import {
	cursorEventsToContent,
	cursorEventsToStream,
	type ToolDisplay,
} from "./stream-map.js";
import { resolveControls } from "./controls.js";
import {
	acquireAgent,
	dropSessionRecord,
	getSessionRecord,
} from "./session-pool.js";
import {
	classifyTurn,
	fingerprint,
	mcpServersFingerprint,
	sendIdempotencyKey,
} from "./transcript-fingerprint.js";

export interface CursorModelConfig {
	/** Provider id used for logging and the providerOptions key (e.g. "cursor"). */
	providerName: string;
	/** Explicit API key; re-resolved against the env at call time when absent. */
	apiKey?: string;
	/** Working directory the local Cursor agent operates in. */
	cwd: string;
	/** Default conversation mode; overridable per-request via providerOptions. */
	mode: AgentModeOption;
	/** Default Cursor model params (id -> value); overridable per-request. */
	params?: Record<string, string>;
	/**
	 * Per-model floor params keyed by model id, seeded by the plugin's `config`
	 * hook. Passed as {@link resolveControls}'s `defaults` for the active model.
	 */
	modelParamDefaults?: Record<string, Record<string, string>>;
	/** MCP servers forwarded to the Cursor agent from opencode's config. */
	mcpServers?: Record<string, McpServerConfig>;
	/** Cursor settings layers to load from disk (skills, rules, .cursor/mcp.json). */
	settingSources?: SettingSource[];
	/** Run the agent's tools inside Cursor's sandbox. */
	sandbox?: boolean;
	/** Cursor subagent definitions made available to the agent. */
	agents?: Record<string, AgentDefinition>;
	/**
	 * Session reuse strategy:
	 *  - `"auto"` (default): fingerprint-guarded reuse — resume the pooled Cursor
	 *    agent and send only the new message on a clean continuation, otherwise
	 *    fall back to a fresh agent + full transcript. Robust to opencode's
	 *    non-chat side calls, message edits, reverts, and compaction.
	 *  - `true`: alias for `"auto"`.
	 *  - `false`: always create a fresh agent per turn and re-send the full
	 *    transcript (the original behavior; the escape hatch).
	 */
	session?: boolean | "auto";
	/**
	 * How Cursor's internal tool activity is surfaced (see {@link ToolDisplay}).
	 * Defaults to `"blocks"`.
	 */
	toolDisplay?: ToolDisplay;
	/**
	 * How opencode's system prompt reaches the Cursor agent (see
	 * {@link SystemPromptMode}). Defaults to "rules".
	 */
	systemPrompt?: SystemPromptMode;
}

/**
 * A Vercel AI SDK `LanguageModelV3` backed by a local Cursor agent. opencode
 * loads this via the provider factory and calls `doStream` / `doGenerate`.
 * The event→stream translation lives in stream-map.ts so it can be unit tested
 * without a live agent.
 */
export class CursorLanguageModel implements LanguageModelV3 {
	readonly specificationVersion = "v3" as const;
	readonly modelId: string;
	readonly provider: string;
	// The local Cursor agent has no attachment channel, so file parts (images,
	// directories, other media) are noted as text in message-map rather than
	// fetched or attached; no URLs are resolved natively.
	readonly supportedUrls: Record<string, RegExp[]> = {};

	constructor(
		modelId: string,
		private readonly config: CursorModelConfig,
	) {
		this.modelId = modelId;
		this.provider = config.providerName;
	}

	/** Messages already emitted, so degradation warnings fire once, not per turn. */
	private readonly warned = new Set<string>();

	private warnOnce(message: string): void {
		if (this.warned.has(message)) return;
		this.warned.add(message);
		console.warn(`[${this.provider}] ${message}`);
	}

	private requireApiKey(): string {
		const apiKey = resolveCursorApiKey(this.config.apiKey);
		if (!apiKey) {
			throw new LoadAPIKeyError({
				message:
					"Cursor API key missing. Run `opencode auth login` and choose Cursor, or set CURSOR_API_KEY.",
			});
		}
		return apiKey;
	}

	private async *agentRun(
		options: LanguageModelV3CallOptions,
	): AsyncGenerator<CursorEvent> {
		// opencode delivers per-request controls (merged model options + selected
		// variant) under providerOptions keyed by our provider id. The session id is
		// injected there by the plugin's chat.params hook.
		const providerOptions = options.providerOptions?.[this.provider] as
			| Record<string, unknown>
			| undefined;
		const { mode, modelSelection } = resolveControls(
			this.modelId,
			{
				mode: this.config.mode,
				params: this.config.params,
				defaults: this.config.modelParamDefaults?.[this.modelId],
			},
			providerOptions,
		);
		if (process.env["OPENCODE_CURSOR_DEBUG"] === "1") {
			console.error(
				`[cursor:debug] model=${this.modelId} selection=${JSON.stringify(modelSelection)}`,
			);
		}
		const sessionID =
			typeof providerOptions?.["sessionID"] === "string"
				? (providerOptions["sessionID"] as string)
				: undefined;
		// MCP servers may be re-forwarded per turn by the plugin's chat.params hook
		// (reflecting live opencode enable/disable). When present, the dynamic set
		// wins over the static startup snapshot baked into config.mcpServers.
		const dynamicMcp = providerOptions?.["mcpServers"] as
			| Record<string, McpServerConfig>
			| undefined;
		const mcpServers = dynamicMcp ?? this.config.mcpServers;
		const mcpHash = mcpServersFingerprint(mcpServers);
		// `session` defaults to "auto" (fingerprint-guarded reuse); `true` is an
		// alias for "auto"; `false` keeps the per-turn-fresh full-transcript path.
		const sessionEnabled = (this.config.session ?? "auto") !== false;
		// Power users can resume a specific Cursor agent via
		// `providerOptions.cursor.agentId`; it takes precedence over session pooling.
		const explicitAgentId =
			typeof providerOptions?.["agentId"] === "string"
				? (providerOptions["agentId"] as string)
				: undefined;
		// The plugin may mark opencode's non-chat side calls (e.g. title
		// generation) so they never resume or disturb the pooled agent.
		const ephemeral = providerOptions?.["ephemeral"] === true;

		// Decide create-vs-resume and whether to pool, from the turn classification.
		const usePool = sessionEnabled && Boolean(sessionID) && !explicitAgentId;
		let resumeAgentId: string | undefined = explicitAgentId;
		let poolKey: string | undefined;
		let record:
			| { systemHash: string; userHashes: string[]; mcpHash?: string }
			| undefined;
		// Number of new trailing user messages for a multi-message interjection
		// (>= 2). Stays 0 for every other turn kind. When set, and the agent is
		// resumed, we replay just those new messages as sequential turns instead
		// of a cold full-transcript replay.
		let multiNewUserCount = 0;
		if (usePool) {
			const classification = ephemeral
				? {
						kind: "side-call" as const,
						fingerprint: fingerprint(options.prompt),
					}
				: classifyTurn(getSessionRecord(sessionID!), options.prompt);
			switch (classification.kind) {
				case "continuation":
				case "continuation-multi": {
					const prev = getSessionRecord(sessionID!);
					// A resumed agent keeps its original MCP servers, so only resume
					// when the live MCP set is unchanged; otherwise create fresh so the
					// new server set takes effect (re-pooled under the same session).
					if (prev?.mcpHash === mcpHash) {
						resumeAgentId = prev?.agentId;
					}
					poolKey = sessionID;
					record = { ...classification.fingerprint, mcpHash };
					if (classification.kind === "continuation-multi") {
						multiNewUserCount = classification.newUserCount ?? 0;
					}
					break;
				}
				case "new":
				case "divergence":
					poolKey = sessionID;
					record = { ...classification.fingerprint, mcpHash };
					break;
				case "side-call":
					// fresh ephemeral agent; pool left untouched.
					break;
			}
			if (process.env["OPENCODE_CURSOR_DEBUG"] === "1") {
				const label =
					classification.kind === "continuation"
						? "resume"
						: classification.kind === "continuation-multi"
							? `resume-multi:${multiNewUserCount}`
							: `fresh:${classification.kind}`;
				console.error(
					`[cursor:debug] turn classification=${label} session=${sessionID}`,
				);
			}
		}

		// A multi-message interjection: two-or-more user messages were queued while
		// the agent was busy, forming a contiguous user-turn tail (the classifier
		// guarantees this shape for "continuation-multi"). On a resumed agent we
		// replay just those new messages as sequential turns.
		//
		// Defensive invariant check: if the recovered tail doesn't match the
		// classifier's count (unreachable today, but one classifier refactor away
		// from real), we must NOT degrade to sending only the latest message —
		// the session record keeps the full N-message fingerprint, so messages
		// 1..N-1 would be silently lost. Instead force the cold path: clear the
		// resume id so a FRESH agent gets the FULL transcript, which matches the
		// record being written and loses nothing.
		//
		// Computed before acquireAgent so a mismatched tail can clear
		// resumeAgentId in time to affect which agent we acquire.
		let multiTurns: SDKUserMessage[] | undefined;
		if (multiNewUserCount >= 2) {
			const turns = trailingUserMessages(options.prompt, multiNewUserCount);
			if (turns.length === multiNewUserCount) {
				multiTurns = turns;
			} else {
				resumeAgentId = undefined;
			}
		}

		const latestUser = latestUserMessage(options.prompt);
		const idempotencyKey = sendIdempotencyKey(
			sessionID,
			record,
			latestUser?.text ?? JSON.stringify(options.prompt),
		);

		// In "rules" mode (default), deliver opencode's system prompt through
		// Cursor's authoritative rules channel instead of the user transcript.
		// Degrades to inline "message" delivery when the user explicitly opted
		// out of the "project" settings layer, when the rule file is user-owned,
		// or when the write fails (read-only checkout etc.).
		const delivery = resolveSystemDelivery({
			mode: this.config.systemPrompt ?? "rules",
			settingSources: this.config.settingSources,
			cwd: this.config.cwd,
			systemText: extractSystemText(options.prompt),
			warn: (message) => this.warnOnce(message),
		});
		const systemMode: SystemPromptMode = delivery.mode;
		const settingSources = delivery.settingSources;

		// Shared acquire params. The retry path reuses this verbatim (minus
		// resumeAgentId) so a fresh agent can never drift from the first attempt's
		// config (sandbox, settingSources, MCP, etc.).
		const baseAcquire = {
			apiKey: this.requireApiKey(),
			modelSelection,
			mode,
			cwd: this.config.cwd,
			...(settingSources ? { settingSources } : {}),
			...(this.config.sandbox !== undefined
				? { sandbox: this.config.sandbox }
				: {}),
			...(mcpServers ? { mcpServers } : {}),
			...(this.config.agents ? { agents: this.config.agents } : {}),
			...(poolKey ? { name: `opencode/${sessionID!.slice(-8)}` } : {}),
			...(poolKey ? { poolKey } : {}),
			...(record ? { record } : {}),
		};

		const acquired = await acquireAgent({
			...baseAcquire,
			...(resumeAgentId ? { resumeAgentId } : {}),
		});

		let yielded = false;
		let releasedOriginal = false;
		try {
			// Replay the queued messages as sequential turns: leading ones silent,
			// only the final one streamed. Note silent turns are FULL agent runs —
			// tools may execute with nothing surfaced until the last turn streams,
			// and each run is awaited serially (see sendAgentTurnSilently for the
			// trade-offs and why concatenation was rejected).
			//
			// Guard on acquired.resumed: multiTurns is computed before acquire (so a
			// mismatched tail can clear resumeAgentId), but the silent-replay path
			// only makes sense against a resumed agent. A fresh agent falls through
			// to the full-transcript replay below.
			if (acquired.resumed && multiTurns) {
				// The pool record was written optimistically with the FULL new
				// fingerprint before any send. If delivery stops partway (error or
				// abort), drop the record so the next turn classifies fresh instead
				// of resuming on top of messages the agent never received.
				let delivered = false;
				try {
					let aborted = false;
					for (let i = 0; i < multiTurns.length - 1; i++) {
						if (options.abortSignal?.aborted) {
							aborted = true;
							break;
						}
						await sendAgentTurnSilently(acquired.agent, multiTurns[i]!, {
							mode,
							abortSignal: options.abortSignal,
							idempotencyKey: sendIdempotencyKey(
								sessionID,
								{ userHashes: [...(record?.userHashes ?? []), String(i)] },
								multiTurns[i]!.text,
							),
						});
					}
					if (!aborted && !options.abortSignal?.aborted) {
						for await (const event of streamAgentTurn(
							acquired.agent,
							multiTurns[multiTurns.length - 1]!,
							{
								mode,
								abortSignal: options.abortSignal,
								idempotencyKey: sendIdempotencyKey(
									sessionID,
									{
										userHashes: [
											...(record?.userHashes ?? []),
											String(multiTurns.length - 1),
										],
									},
									multiTurns[multiTurns.length - 1]!.text,
								),
							},
						)) {
							yielded = true;
							yield event;
						}
						delivered = true;
					}
				} finally {
					if (!delivered && sessionID) dropSessionRecord(sessionID);
				}
			} else {
				// A resumed agent already remembers the prior conversation, so send
				// only the new turn; otherwise send the full transcript.
				const message = acquired.resumed
					? (latestUserMessage(options.prompt) ??
						promptToCursorMessage(options.prompt, systemMode))
					: promptToCursorMessage(options.prompt, systemMode);
				try {
					for await (const event of streamAgentTurn(acquired.agent, message, {
						mode,
						abortSignal: options.abortSignal,
						idempotencyKey,
					})) {
						yielded = true;
						yield event;
					}
				} catch (err) {
					// Resume-aware retry: a resumed agent can pass resume() yet fail the
					// actual send when Cursor's server has already expired the agent (its
					// server-side retention is shorter than our local 7-day reuse window,
					// and not documented). If nothing has been emitted downstream yet and
					// the user hasn't aborted, transparently re-create a fresh agent and
					// replay the full transcript — self-healing, no context loss. The
					// fresh agent re-pools under the same session (overwriting the dead
					// agentId) via acquireAgent's existing pooling path.
					//
					// Deliberate tradeoff: the retry fires on ANY error class (including
					// rate-limit or network failures) because Cursor's status:"error"
					// carries no machine-readable class to discriminate on. Bounded to a
					// single attempt, so the worst case is one extra create.
					if (acquired.resumed && !yielded && !options.abortSignal?.aborted) {
						if (process.env["OPENCODE_CURSOR_DEBUG"] === "1") {
							console.error(
								"[cursor:debug] resumed turn failed before emitting; retrying with a fresh agent",
							);
						}
						acquired.release();
						releasedOriginal = true;
						// A fresh create (no resumeAgentId) re-pools under the same
						// session, overwriting the dead agentId. If re-acquiring itself
						// fails (e.g. transient create error), surface that but keep the
						// original resume failure as the cause for diagnosability.
						let retry: Awaited<ReturnType<typeof acquireAgent>>;
						try {
							retry = await acquireAgent({ ...baseAcquire });
						} catch (retryErr) {
							if (retryErr instanceof Error && retryErr.cause === undefined) {
								retryErr.cause = err;
							} else if (process.env["OPENCODE_CURSOR_DEBUG"] === "1") {
								// Non-Error throw or pre-existing cause: the original resume
								// failure can't ride along as `cause`, so log it instead of
								// dropping it silently.
								console.error(
									"[cursor:debug] original resume failure (not attachable as cause):",
									err,
								);
							}
							throw retryErr;
						}
						try {
							const replay = promptToCursorMessage(options.prompt, systemMode);
							yield* streamAgentTurn(retry.agent, replay, {
								mode,
								abortSignal: options.abortSignal,
								idempotencyKey,
							});
						} finally {
							retry.release();
						}
					} else {
						throw err;
					}
				}
			}
		} finally {
			if (!releasedOriginal) acquired.release();
		}
	}

	async doStream(options: LanguageModelV3CallOptions): Promise<{
		stream: ReadableStream<LanguageModelV3StreamPart>;
	}> {
		return {
			stream: cursorEventsToStream(
				this.agentRun(options),
				this.config.toolDisplay,
			),
		};
	}

	async doGenerate(options: LanguageModelV3CallOptions): Promise<{
		content: Array<LanguageModelV3Content>;
		finishReason: LanguageModelV3FinishReason;
		usage: LanguageModelV3Usage;
		warnings: Array<never>;
	}> {
		const result = await cursorEventsToContent(
			this.agentRun(options),
			this.config.toolDisplay,
		);
		return { ...result, warnings: [] };
	}
}
