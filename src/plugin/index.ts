import type { Config, Plugin } from "@opencode-ai/plugin";
import type { Auth } from "@opencode-ai/sdk/v2";
import type { McpServerConfig } from "@cursor/sdk";
import { resolveCursorApiKey } from "../api-key.js";
import { discoverModels, toOpencodeModels } from "../model-discovery.js";
import { buildModelV2Map, PROVIDER_ID, providerNpm } from "./model-v2.js";
import {
	findUnshareableOAuthServers,
	type McpStatusMap,
	translateMcpServers,
} from "./mcp-config.js";
import { buildCursorTools } from "./cursor-tools.js";

function apiKeyFromAuth(auth: Auth | undefined): string | undefined {
	return auth?.type === "api" ? auth.key : undefined;
}

/**
 * opencode plugin that adds a "Cursor" provider backed by the official Cursor
 * SDK (`@cursor/sdk`).
 *
 * - `auth`: registers an API-key login for Cursor and a `loader` that feeds the
 *   key into the AI-SDK provider factory. The key is validated on first use
 *   (model discovery / first call), not at login — see the note on `methods`.
 * - `config`: registers the provider (npm package + discovered/fallback models)
 *   so it shows up in opencode immediately.
 * - `provider.models`: auth-aware live model discovery via `Cursor.models.list`.
 * - `tool.cursor_refresh_models`: force-refresh the model catalog.
 */
export const CursorPlugin: Plugin = async (input) => {
	// The Cursor API key resolved by opencode's auth loader, captured so the
	// delegation tools (which don't receive auth directly) can reuse it. Falls
	// back to the CURSOR_API_KEY env var when the loader hasn't run.
	let capturedApiKey: string | undefined;

	// opencode client + MCP-forwarding settings captured at config time so the
	// per-turn chat.params hook can re-forward the *live* MCP server set
	// (reflecting mid-session enable/disable) rather than the startup snapshot.
	const client = input?.client;
	const directory = input?.directory;
	let forwardMcp = true;
	let userMcp: Record<string, McpServerConfig> = {};
	// OAuth servers we've already warned about, so the toast fires once per
	// server rather than on every turn.
	const warnedOAuth = new Set<string>();

	return {
		auth: {
			provider: PROVIDER_ID,
			loader: async (getAuth) => {
				const apiKey = resolveCursorApiKey(
					apiKeyFromAuth(await getAuth().catch(() => undefined)),
				);
				if (apiKey) {
					capturedApiKey = apiKey;
					// The `config` hook (which seeds opencode's model picker) runs without
					// a key. Warm the catalog cache here — the loader is the hook that
					// reliably has the key — so the next launch seeds the full live
					// catalog instead of the static fallback. Fire-and-forget: discovery
					// never throws and must not block auth/provider load.
					void discoverModels({ apiKey });
				}
				return apiKey ? { apiKey } : {};
			},
			// A single API-key method. opencode always shows its built-in "Enter your
			// API key" prompt for `type: "api"`, so we intentionally do NOT declare
			// custom `prompts` (that asks for the key a second time) or an `authorize`
			// callback. opencode only passes `authorize` the *custom-prompt* inputs —
			// never the built-in key — so validating the key in `authorize` would
			// force that redundant extra prompt. Instead the key is validated on first
			// use (model discovery / the first call both surface a bad key clearly).
			methods: [{ type: "api", label: "Cursor API Key" }],
		},

		config: async (config) => {
			const { models } = await discoverModels({});
			config.provider ??= {};
			const existing = config.provider[PROVIDER_ID] ?? {};
			const existingOptions = (existing.options ?? {}) as Record<
				string,
				unknown
			>;

			// Forward opencode's configured MCP servers to the Cursor
			// agent so it can use the same servers. Opt out via
			// `provider.cursor.options.forwardMcp: false`.
			forwardMcp = existingOptions["forwardMcp"] !== false;
			userMcp = (existingOptions["mcpServers"] ?? {}) as Record<
				string,
				McpServerConfig
			>;
			const mcpServers = forwardMcp
				? { ...userMcp, ...translateMcpServers(config.mcp) }
				: userMcp;

			config.provider[PROVIDER_ID] = {
				name: "Cursor",
				npm: providerNpm(),
				...existing,
				options: {
					...existingOptions,
					...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
				},
				models: { ...toOpencodeModels(models), ...(existing.models ?? {}) },
			};
		},

		provider: {
			id: PROVIDER_ID,
			models: async (_provider, ctx) => {
				const apiKey = apiKeyFromAuth(ctx.auth);
				const { models } = await discoverModels({ apiKey });
				return buildModelV2Map(models);
			},
		},

		// Bridge opencode's session id to the provider: it lands in
		// providerOptions.cursor.sessionID, which the provider reads to pool/resume a
		// Cursor agent per session (when the `session` option is enabled).
		//
		// Also map opencode's plan AGENT to Cursor's plan mode. This hook fires
		// after opencode merges the selected variant into `output.options`, so an
		// explicit mode from the `plan` variant (or model options) wins — the
		// agent-based default only applies when no mode was set.
		"chat.params": async (input, output) => {
			if (input.model?.providerID !== PROVIDER_ID) return;
			output.options = {
				...(output.options ?? {}),
				sessionID: input.sessionID,
			};
			if (input.agent === "plan" && output.options["mode"] === undefined) {
				output.options["mode"] = "plan";
			}

			// Dynamically re-forward MCP servers from opencode's *live* state so
			// mid-session enable/disable reaches the Cursor agent (the config hook
			// only snapshots the set once, at startup). `client.mcp.status()` is the
			// runtime truth (connected/disabled/...) and `client.config.get()`
			// supplies the launch specs. On any failure we leave the static snapshot
			// (already baked into the provider options) in place.
			if (forwardMcp && client) {
				try {
					const query = directory ? { query: { directory } } : undefined;
					const [cfgRes, statusRes] = await Promise.all([
						client.config.get(),
						client.mcp.status(query),
					]);
					const liveMcp = (cfgRes?.data as Config | undefined)?.mcp;
					const status = statusRes?.data as McpStatusMap | undefined;
					if (status) {
						output.options["mcpServers"] = {
							...userMcp,
							...translateMcpServers(liveMcp, status),
						};
						// Notify (once) about OAuth servers we can't forward: opencode
						// holds their token and it never reaches config.mcp, so the
						// Cursor agent can't connect. Only those without a shareable
						// client registration are skipped; ones with a clientId are
						// forwarded with an `auth` block for the agent's own OAuth flow.
						const unshareable = findUnshareableOAuthServers(
							liveMcp,
							status,
						).filter((name) => !warnedOAuth.has(name));
						if (unshareable.length > 0) {
							for (const name of unshareable) warnedOAuth.add(name);
							const plural = unshareable.length > 1;
							void client.tui
								.showToast({
									body: {
										title: "Cursor MCP",
										message: `Skipped OAuth MCP server${plural ? "s" : ""}: ${unshareable.join(", ")}. opencode's token can't be shared with the Cursor agent; configure an OAuth clientId to forward ${plural ? "them" : "it"}.`,
										variant: "warning",
									},
								})
								.catch(() => {});
						}
					}
				} catch {
					// Keep the static snapshot; live forwarding is best-effort.
				}
			}
		},

		tool: {
			cursor_refresh_models: {
				description:
					"Refresh the live Cursor model catalog (bypasses the 24h cache) and report the available models.",
				args: {},
				execute: async () => {
					const result = await discoverModels({ forceRefresh: true });
					const lines = result.models.map(
						(m) => `- ${m.id} — ${m.displayName}`,
					);
					const header =
						result.source === "live"
							? `Refreshed ${result.models.length} Cursor models (live):`
							: `Could not fetch live models (${result.source}). ${result.warning ?? ""}`.trim();
					return {
						title: `Cursor models (${result.source})`,
						output: [header, ...lines].join("\n"),
						metadata: { source: result.source, count: result.models.length },
					};
				},
			},
			// Delegation tools that complement the provider: a cloud/background agent
			// and a permission-gated local delegate. They resolve the Cursor key from
			// the auth loader (captured above) or CURSOR_API_KEY.
			...buildCursorTools({
				resolveApiKey: () => resolveCursorApiKey(capturedApiKey),
				defaultCwd: () => input?.directory ?? process.cwd(),
			}),
		},
	};
};

export default CursorPlugin;
