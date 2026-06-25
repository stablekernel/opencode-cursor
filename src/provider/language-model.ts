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
} from "@cursor/sdk";
import { resolveCursorApiKey } from "../api-key.js";
import { latestUserMessage, promptToCursorMessage } from "./message-map.js";
import { streamAgentTurn, type CursorEvent } from "./agent-events.js";
import {
	cursorEventsToContent,
	cursorEventsToStream,
	type ToolDisplay,
} from "./stream-map.js";
import { resolveControls } from "./controls.js";
import { acquireAgent, getSessionRecord } from "./session-pool.js";
import {
	classifyTurn,
	fingerprint,
	mcpServersFingerprint,
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
	// Images are passed inline as base64 data, so no URLs are fetched natively.
	readonly supportedUrls: Record<string, RegExp[]> = {};

	constructor(
		modelId: string,
		private readonly config: CursorModelConfig,
	) {
		this.modelId = modelId;
		this.provider = config.providerName;
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
			{ mode: this.config.mode, params: this.config.params },
			providerOptions,
		);
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
		if (usePool) {
			const classification = ephemeral
				? {
						kind: "side-call" as const,
						fingerprint: fingerprint(options.prompt),
					}
				: classifyTurn(getSessionRecord(sessionID!), options.prompt);
			switch (classification.kind) {
				case "continuation": {
					const prev = getSessionRecord(sessionID!);
					// A resumed agent keeps its original MCP servers, so only resume
					// when the live MCP set is unchanged; otherwise create fresh so the
					// new server set takes effect (re-pooled under the same session).
					if (prev?.mcpHash === mcpHash) {
						resumeAgentId = prev?.agentId;
					}
					poolKey = sessionID;
					record = { ...classification.fingerprint, mcpHash };
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
						: `fresh:${classification.kind}`;
				console.error(
					`[cursor:debug] turn classification=${label} session=${sessionID}`,
				);
			}
		}

		// Shared acquire params. The retry path reuses this verbatim (minus
		// resumeAgentId) so a fresh agent can never drift from the first attempt's
		// config (sandbox, settingSources, MCP, etc.).
		const baseAcquire = {
			apiKey: this.requireApiKey(),
			modelSelection,
			mode,
			cwd: this.config.cwd,
			...(this.config.settingSources
				? { settingSources: this.config.settingSources }
				: {}),
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

		// A resumed agent already remembers the prior conversation, so send only the
		// new turn; otherwise send the full transcript.
		const message = acquired.resumed
			? (latestUserMessage(options.prompt) ??
				promptToCursorMessage(options.prompt))
			: promptToCursorMessage(options.prompt);

		let yielded = false;
		let releasedOriginal = false;
		try {
			try {
				for await (const event of streamAgentTurn(acquired.agent, message, {
					mode,
					abortSignal: options.abortSignal,
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
				if (
					acquired.resumed &&
					!yielded &&
					!options.abortSignal?.aborted
				) {
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
						}
						throw retryErr;
					}
					try {
						const replay = promptToCursorMessage(options.prompt);
						yield* streamAgentTurn(retry.agent, replay, {
							mode,
							abortSignal: options.abortSignal,
						});
					} finally {
						retry.release();
					}
				} else {
					throw err;
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
