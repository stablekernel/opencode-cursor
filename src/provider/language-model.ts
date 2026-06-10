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
import { acquireAgent } from "./session-pool.js";

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
	/** MCP servers forwarded to the Cursor agent (e.g. opencode's Serena). */
	mcpServers?: Record<string, McpServerConfig>;
	/** Cursor settings layers to load from disk (skills, rules, .cursor/mcp.json). */
	settingSources?: SettingSource[];
	/** Run the agent's tools inside Cursor's sandbox. */
	sandbox?: boolean;
	/** Cursor subagent definitions made available to the agent. */
	agents?: Record<string, AgentDefinition>;
	/**
	 * Reuse one Cursor agent per opencode session (resume across turns, sending
	 * only the new message). Off by default; the default per-turn-fresh path
	 * re-sends the full transcript and is robust to opencode's non-chat calls.
	 */
	session?: boolean;
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
		const useSession = this.config.session === true && Boolean(sessionID);
		// Power users can resume a specific Cursor agent via
		// `providerOptions.cursor.agentId`; it takes precedence over session pooling.
		const explicitAgentId =
			typeof providerOptions?.["agentId"] === "string"
				? (providerOptions["agentId"] as string)
				: undefined;

		const acquired = await acquireAgent({
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
			...(this.config.mcpServers ? { mcpServers: this.config.mcpServers } : {}),
			...(this.config.agents ? { agents: this.config.agents } : {}),
			...(useSession ? { name: `opencode/${sessionID!.slice(-8)}` } : {}),
			...(explicitAgentId ? { agentId: explicitAgentId } : {}),
			sessionID,
			session: useSession,
		});

		// A resumed agent already remembers the prior conversation, so send only the
		// new turn; otherwise send the full transcript.
		const message = acquired.resumed
			? (latestUserMessage(options.prompt) ??
				promptToCursorMessage(options.prompt))
			: promptToCursorMessage(options.prompt);

		try {
			yield* streamAgentTurn(acquired.agent, message, {
				mode,
				abortSignal: options.abortSignal,
			});
		} finally {
			acquired.release();
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
