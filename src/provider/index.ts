import type {
	EmbeddingModelV3,
	ImageModelV3,
	ProviderV3,
} from "@ai-sdk/provider";
import { NoSuchModelError } from "@ai-sdk/provider";
import type {
	AgentDefinition,
	AgentModeOption,
	McpServerConfig,
	SettingSource,
} from "@cursor/sdk";
import { resolveCursorApiKey } from "../api-key.js";
import { setPreferredTransport } from "./agent-backend.js";
import {
	CursorLanguageModel,
	type CursorModelConfig,
} from "./language-model.js";
import type { ToolDisplay } from "./stream-map.js";
import type { SystemPromptMode } from "./message-map.js";

export interface CursorProviderOptions {
	/**
	 * Cursor API key. opencode passes this from the provider's resolved auth /
	 * options. When omitted, falls back to the CURSOR_API_KEY environment
	 * variable at call time.
	 */
	apiKey?: string;
	/** Provider id, supplied by opencode as `name`. Defaults to "cursor". */
	name?: string;
	/** Working directory for the local Cursor agent. Defaults to process.cwd(). */
	cwd?: string;
	/** Default conversation mode: "agent" (default) or "plan". Overridable per-request. */
	mode?: AgentModeOption;
	/** Default Cursor model params (id -> value), e.g. { thinking: "high" }. */
	params?: Record<string, string>;
	/**
	 * Per-model floor params keyed by model id, e.g. `{ "composer-2.5": { fast:
	 * "false" } }`. Seeded by the plugin's `config` hook; applied under `params`
	 * and per-request options.
	 */
	modelParamDefaults?: Record<string, Record<string, string>>;
	/**
	 * MCP servers to make available to the Cursor agent, keyed by name. The
	 * plugin's `config` hook populates this by translating opencode's configured
	 * `config.mcp` servers, so the agent can use the same MCP servers that
	 * opencode does.
	 */
	mcpServers?: Record<string, McpServerConfig>;
	/**
	 * Cursor settings layers to load from the local filesystem ("project",
	 * "user", "all", ...). Enables the agent to pick up your Cursor skills,
	 * rules, and `.cursor/mcp.json` servers.
	 */
	settingSources?: SettingSource[];
	/** Run the agent's tools inside Cursor's sandbox. */
	sandbox?: boolean;
	/**
	 * Cursor's classifier-backed Auto review mode: gates tool calls through a
	 * classifier instead of running them unconditionally. Defaults to `false`.
	 * Best-effort tool-call gating, not a security boundary.
	 */
	autoReview?: boolean;
	/** Cursor subagent definitions (`{ description, prompt, model?, mcpServers? }`). */
	agents?: Record<string, AgentDefinition>;
	/**
	 * Session reuse strategy: `"auto"` (default) resumes the pooled Cursor agent
	 * and sends only the new message on a clean continuation, falling back to a
	 * fresh agent + full transcript on edits/reverts/compaction/side calls; `true`
	 * is an alias for `"auto"`; `false` always creates a fresh agent per turn.
	 */
	session?: boolean | "auto";
	/**
	 * How Cursor's internal tool activity (shell/read/edit/mcp/…) is surfaced:
	 *  - `"blocks"` (default): structured provider-executed `tool-call`/
	 *    `tool-result` parts so opencode renders proper tool blocks. Requires a
	 *    V3-native opencode host (1.16+).
	 *  - `"reasoning"`: compact reasoning lines; the fallback for older/non-V3
	 *    hosts (works everywhere).
	 */
	toolDisplay?: ToolDisplay;
	/**
	 * How opencode's system prompt reaches the Cursor agent:
	 *  - "rules" (default): written to `<cwd>/.cursor/rules/opencode.mdc`
	 *    (git-ignored, alwaysApply) and loaded via the `project` settings layer —
	 *    Cursor's authoritative channel, so it is not rejected as prompt injection.
	 *    Note: a project rule also applies to your own Cursor IDE in this repo, and
	 *    enabling the project layer also loads other `.cursor/` config.
	 *  - "message": legacy inline `# System` block (may be flagged as injection).
	 *  - "omit": not forwarded at all.
	 */
	systemPrompt?: SystemPromptMode;
	/**
	 * Transport for Cursor agent traffic: "http1" (in-process, Bun-safe),
	 * "http2-direct" (in-process, Node only), "sidecar" (Node child, rollback).
	 * Beats OPENCODE_CURSOR_TRANSPORT. Process-global: last provider to set it wins.
	 */
	transport?: "http1" | "http2-direct" | "sidecar";
}

/**
 * Cursor provider for the Vercel AI SDK (V3), backed by the official
 * `@cursor/sdk` local agent runtime.
 *
 * opencode loads this package by its `npm` provider config, finds the export
 * whose name starts with `create`, calls it with `{ name, apiKey, ...options }`,
 * and then calls `.languageModel(modelId)`.
 */
export function createCursor(options: CursorProviderOptions = {}): ProviderV3 {
	if (options.transport) setPreferredTransport(options.transport);
	const mcpServers =
		options.mcpServers && Object.keys(options.mcpServers).length > 0
			? options.mcpServers
			: undefined;
	const config: CursorModelConfig = {
		providerName: options.name ?? "cursor",
		apiKey: resolveCursorApiKey(options.apiKey),
		cwd: options.cwd ?? process.cwd(),
		mode: options.mode ?? "agent",
		...(options.params ? { params: options.params } : {}),
		...(options.modelParamDefaults
			? { modelParamDefaults: options.modelParamDefaults }
			: {}),
		...(mcpServers ? { mcpServers } : {}),
		...(options.settingSources
			? { settingSources: options.settingSources }
			: {}),
		...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {}),
		...(options.autoReview !== undefined
			? { autoReview: options.autoReview }
			: {}),
		...(options.agents ? { agents: options.agents } : {}),
		session: options.session ?? "auto",
		toolDisplay: options.toolDisplay ?? "blocks",
		systemPrompt: options.systemPrompt ?? "rules",
	};

	const notImplemented = (kind: string, modelId: string): never => {
		throw new NoSuchModelError({
			modelId,
			modelType: kind as "languageModel",
			message: `The Cursor provider does not support ${kind} models.`,
		});
	};

	return {
		specificationVersion: "v3",
		languageModel: (modelId: string) =>
			new CursorLanguageModel(modelId, config),
		embeddingModel: (modelId: string): EmbeddingModelV3 =>
			notImplemented("embeddingModel", modelId),
		imageModel: (modelId: string): ImageModelV3 =>
			notImplemented("imageModel", modelId),
	};
}
