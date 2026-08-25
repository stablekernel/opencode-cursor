import type { Config, Plugin, ToolContext } from "@opencode-ai/plugin";
import type { Auth } from "@opencode-ai/sdk/v2";
import type { McpServerConfig } from "@cursor/sdk";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import semver from "semver";
import { resolveCursorApiKey } from "../api-key.js";
import { discoverModels, toOpencodeModels } from "../model-discovery.js";
import { defaultModelParams } from "../model-variants.js";
import { buildModelV2Map, PROVIDER_ID, providerNpm } from "./model-v2.js";
import {
	findUnshareableOAuthServers,
	type McpStatusMap,
	translateMcpServers,
} from "./mcp-config.js";
import { buildCursorTools } from "./cursor-tools.js";
import {
	getLocalVersion,
	getLatestVersion,
	clearVersionCache,
	PLUGIN_CACHE_PATH,
} from "../version-check.js";
import { removeSystemRule } from "../provider/system-rule.js";
import {
	clearLogBridge,
	pluginLog,
	setLogBridge,
} from "../provider/log-bridge.js";
import {
	writeSkillMirror,
	removeSkillMirror,
	buildSkillsCatalogue,
} from "../provider/skill-mirror.js";
import {
	resolveSkills,
	resolvePluginSkillSources,
	skillSetHash,
	type LiveSkill,
	type SkillFilterOptions,
} from "../plugin/skill-discovery.js";
import {
	clearSubagentBridge,
	setSubagentBridge,
	subagentCallChildId,
	stampTaskPartSessionId,
} from "../provider/subagent-bridge.js";
import {
	mirrorPluginTools,
	type MirroredTool,
} from "./plugin-tool-registry.js";
import {
	startPluginToolsBridge,
	type PluginToolsBridge,
} from "./plugin-tools-bridge.js";

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
	// Single registry fetch shared by both the console warning and the UI
	// version-check paths. Throttled to once per 24h via an on-disk cache.
	// Fire-and-forget: never block or fail plugin init.
	const _latestVersionPromise: Promise<string | undefined> = (async () => {
		try {
			if (process.env.CI || process.env.NO_UPDATE_NOTIFIER) return undefined;
			return await getLatestVersion();
		} catch {
			return undefined;
		}
	})();

	// Surfaces the update notice in the UI (toast). Resolved once per plugin
	// instance using the shared fetch above.
	const _versionCheckPromise: Promise<{ local: string; latest: string } | null> =
		(async () => {
			try {
				if (process.env.CI || process.env.NO_UPDATE_NOTIFIER) return null;
				const local = getLocalVersion();
				const latest = await _latestVersionPromise;
				if (!local || !latest || !semver.gt(latest, local)) return null;
				return { local, latest };
			} catch {
				return null;
			}
		})();
	let _toastShown = false;

	// The Cursor API key resolved by opencode's auth loader, captured so the
	// delegation tools (which don't receive auth directly) can reuse it. Falls
	// back to the CURSOR_API_KEY env var when the loader hasn't run.
	let capturedApiKey: string | undefined;

	// opencode client + MCP-forwarding settings captured at config time so the
	// per-turn chat.params hook can re-forward the *live* MCP server set
	// (reflecting mid-session enable/disable) rather than the startup snapshot.
	const client = input?.client;

	// Show a version update toast shortly after startup so it surfaces before
	// the user sends their first message. The 2s delay gives the TUI time to
	// initialize before we call showToast; it runs AFTER the version fetch
	// resolves so a slow network never suspends into the user's first prompt.
	void _versionCheckPromise
		.then(async (result) => {
			if (_toastShown || !result || !client) return;
			_toastShown = true;
			await new Promise<void>((r) => setTimeout(r, 2000));
			const message = `@stablekernel/opencode-cursor v${result.latest} is available (you have v${result.local}). Use the cursor_update_plugin tool to update, then restart opencode.`;
			void client.tui
				.showToast({
					body: {
						title: "Cursor plugin update available",
						message,
						variant: "warning",
						duration: 15000,
					},
				})
				.catch(() => {});
		})
		.catch(() => {});

	const directory = input?.directory;
	// Publish the opencode client + directory so the provider stream layer can
	// create a real child session for each Cursor subagent (making its `task`
	// card clickable / `ctrl+x`-navigable). Same-process handoff via a globalThis
	// registry; the provider degrades gracefully when it's absent.
	if (client) {
		setSubagentBridge({ client, directory });
		setLogBridge({ client, directory });
	}
	// Canonical working directory for the generated system-prompt rule: the
	// provider writes `.cursor/rules/opencode.mdc` under this path and dispose
	// cleans it up from the same path. The config hook threads it into the
	// provider options (respecting a user-configured `cwd` option) so write and
	// cleanup can never diverge.
	let resolvedCwd = directory ?? process.cwd();
	// Skills bundled inside installed opencode plugins ship under the plugin
	// package cache, and optionally alongside file-based plugins — resolve the
	// plugin-side sources here so the skill mirror includes them. Set to
	// undefined when any source throws so the mirror falls back to its default
	// filesystem scan instead of mirroring nothing.
	let pluginSkillSources:
		| { cacheRoot?: string; filePluginRoots?: string[] }
		| undefined;
	try {
		pluginSkillSources = resolvePluginSkillSources();
	} catch (error) {
		pluginLog("warn", "plugin skill source discovery failed", {
			error: error instanceof Error ? error.message : String(error),
			impact: "plugin-bundled skills unavailable to the Cursor agent",
		});
		pluginSkillSources = undefined;
	}
	let forwardMcp = true;
	let userMcp: Record<string, McpServerConfig> = {};
	// Whether to let opencode drive auto-compaction. Default false: the Cursor
	// agent self-compacts (preCompact hook, trigger:"auto"), so opencode's
	// compaction is redundant and is what mints a fresh agentId per compaction.
	// Opt in with `provider.cursor.options.autoCompaction: true`.
	let autoCompaction = false;
	// Skill forwarding state, mirroring the MCP forwarding pattern.
	let forwardSkills = true;
	let skillFilterOptions: SkillFilterOptions | undefined;
	let lastSkillHash = "";
	let currentSkillsCatalogue = "";
	// OAuth servers we've already warned about, so the toast fires once per
	// server rather than on every turn.
	const warnedOAuth = new Set<string>();

	// Plugin-tool bridge state: mirrored tools from other opencode plugins,
	// exposed to the Cursor agent via a local stdio MCP server. Populated by
	// the config hook; re-checked in chat.params so plugins added mid-session
	// are picked up on the next turn.
	let forwardPluginTools = true;
	let pluginToolOptions: { include?: string[]; exclude?: string[] } | undefined;
	let mirroredTools: MirroredTool[] = [];
	let pluginToolsBridge: PluginToolsBridge | undefined;
	let lastPermissionKey = "";
	let pluginToolsMcpServer: McpServerConfig | undefined;
	let pluginToolsWarned = false;

	/**
	 * Mirror other plugins' tool maps and (re)start the bridge. Returns the
	 * MCP server config to merge into the Cursor agent's `mcpServers`, or
	 * undefined when nothing is mirrored. Never throws.
	 */
	async function syncPluginTools(
		config?: Config,
	): Promise<McpServerConfig | undefined> {
		if (!forwardPluginTools) return undefined;
		try {
			const result = await mirrorPluginTools(config, input, pluginToolOptions);
			if (Object.keys(result.failed).length > 0 && !pluginToolsWarned) {
				pluginToolsWarned = true;
				pluginLog("warn", "plugin tool mirror skipped some plugins", result.failed);
			}
			if (result.tools.length === 0) {
				await pluginToolsBridge?.close();
				pluginToolsBridge = undefined;
				mirroredTools = [];
				return undefined;
			}
			// Restart the bridge when the tool set OR the permission config
			// changed (the ask gate closes over the config snapshot).
			const ids = result.tools
				.map((t) => t.id)
				.sort()
				.join("|");
			// Permission objects are plain config JSON; JSON.stringify on the
			// raw value is a stable-enough identity for change detection
			// (config order is stable within a session).
			const permKey = JSON.stringify(config?.permission ?? null);
			const currentIds = mirroredTools
				.map((t) => t.id)
				.sort()
				.join("|");
			if (
				ids !== currentIds ||
				permKey !== lastPermissionKey ||
				!pluginToolsBridge
			) {
				await pluginToolsBridge?.close();
				pluginToolsBridge = await startPluginToolsBridge({
					tools: result.tools,
					directory: input?.directory ?? process.cwd(),
					askGate: makeAskGate(config?.permission),
				});
				mirroredTools = result.tools;
				lastPermissionKey = permKey;
			}
			pluginToolsMcpServer = pluginToolsBridge?.mcpServer as
				| McpServerConfig
				| undefined;
			return pluginToolsMcpServer;
		} catch (error) {
			pluginLog("warn", "plugin tool mirror failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	/**
	 * Permission gate for mirrored tool execution, evaluated against the
	 * user's opencode `permission` config exactly like a native tool's
	 * `context.ask`:
	 *
	 *  - `allow` → resolve silently.
	 *  - `deny`  → reject (the call fails closed).
	 *  - `ask`   → reject. The interactive prompt is anchored to an opencode
	 *    session/TUI; a Cursor-originated call has no way to surface it, so —
	 *    like ask-permissioned skills — it is withheld rather than run
	 *    unattended. Users who want a tool available to Cursor set it to
	 *    `allow` (optionally scoped with a pattern).
	 */
	function makeAskGate(
		permissionConfig: unknown,
	): ToolContext["ask"] | undefined {
		return async (req) => {
			// Mirror opencode's Permission.ask loop: evaluate every requested
			// pattern (default "*"). Any deny → reject immediately; all allow →
			// run; anything else is "ask", which can't be prompted from Cursor.
			const patterns =
				Array.isArray(req.patterns) && req.patterns.length > 0
					? req.patterns
					: ["*"];
			let needsAsk = false;
			for (const pattern of patterns) {
				const action = evaluatePermissionAction(
					permissionConfig,
					req.permission,
					pattern,
				);
				if (action === "deny") {
					throw new Error(
						`permission denied for "${req.permission}" (pattern "${pattern}")`,
					);
				}
				if (action !== "allow") needsAsk = true;
			}
			if (!needsAsk) return;
			throw new Error(
				`permission for "${req.permission}" is set to "ask", which can't be prompted from the Cursor agent — set it to "allow" to use this tool`,
			);
		};
	}

	/**
	 * Resolve a permission action from the live opencode permission config,
	 * matching opencode's own `Permission.evaluate` semantics: rules are
	 * flattened in config order and the LAST rule whose permission wildcard
	 * matches `permission` AND whose pattern wildcard matches `pattern` wins;
	 * no match → "ask". Supported shapes:
	 *
	 *  - rule array (V2 ruleset): `[{ permission, pattern, action }, ...]`
	 *  - map form: `{ "pty_*": "allow" }` or `{ "pty_*": { "*": "allow" } }`
	 *    (the nested map keys are pattern wildcards)
	 */
	function evaluatePermissionAction(
		permissionConfig: unknown,
		permission: string,
		pattern: string,
	): "allow" | "deny" | "ask" {
		const wildcardMatch = (pattern: string, value: string): boolean => {
			if (pattern === "*") return true;
			if (!pattern.includes("*")) return pattern === value;
			const regex = pattern
				.replace(/[.+^${}()|[\]\\]/g, "\\$&")
				.replace(/\*/g, ".*");
			return new RegExp(`^${regex}$`).test(value);
		};
		const normalize = (value: unknown): "allow" | "deny" | "ask" | undefined =>
			value === "allow" || value === "deny" || value === "ask" ? value : undefined;
		// Mirror opencode's `expand` for pattern wildcards (permission/index.ts):
		// `~`, `~/...`, and `$HOME...` expand against the current user's home.
		const home = process.env["HOME"] || homedir();
		const expandPattern = (pattern: string): string => {
			if (pattern === "~") return home;
			if (pattern.startsWith("~/")) return home + pattern.slice(1);
			if (pattern.startsWith("$HOME/")) return home + pattern.slice(5);
			if (pattern.startsWith("$HOME")) return home + pattern.slice(5);
			return pattern;
		};

		// Flatten the config into (permission-wildcard, pattern-wildcard, action)
		// triples in config order, then take the last match — same as opencode.
		const rules: Array<{
			permission: string;
			pattern: string;
			action: "allow" | "deny" | "ask";
		}> = [];
		const pushRule = (perm: unknown, pattern: unknown, action: unknown): void => {
			const normalized = normalize(action);
			if (typeof perm !== "string" || normalized === undefined) return;
			rules.push({
				permission: perm,
				pattern: typeof pattern === "string" ? expandPattern(pattern) : "*",
				action: normalized,
			});
		};

		if (Array.isArray(permissionConfig)) {
			for (const rule of permissionConfig) {
				if (rule && typeof rule === "object") {
					const r = rule as {
						permission?: unknown;
						pattern?: unknown;
						action?: unknown;
					};
					pushRule(r.permission, r.pattern, r.action);
				}
			}
		} else if (permissionConfig && typeof permissionConfig === "object") {
			for (const [perm, value] of Object.entries(
				permissionConfig as Record<string, unknown>,
			)) {
				const direct = normalize(value);
				if (direct) {
					pushRule(perm, "*", value);
					continue;
				}
				if (value && typeof value === "object" && !Array.isArray(value)) {
					for (const [pattern, action] of Object.entries(
						value as Record<string, unknown>,
					)) {
						pushRule(perm, pattern, action);
					}
				}
			}
		}

		for (let i = rules.length - 1; i >= 0; i--) {
			const rule = rules[i]!;
			if (
				wildcardMatch(rule.permission, permission) &&
				wildcardMatch(rule.pattern, pattern)
			) {
				return rule.action;
			}
		}
		return "ask";
	}

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
					// catalog instead of the static fallback.
					//
					// `forceRefresh: true` bypasses the 24h on-disk cache so a live
					// `Cursor.models.list()` runs on every opencode startup. This is the
					// stale-while-revalidate write side: the `config` and
					// `provider.models` hooks still serve the current cache instantly (no
					// startup latency), while this refreshes it in the background so newly
					// released Cursor models surface on the next launch instead of waiting
					// up to 24h for the cache to expire. Fire-and-forget: discovery never
					// throws and must not block auth/provider load.
					void discoverModels({ apiKey, forceRefresh: true });
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
			const existingOptions = (existing.options ?? {}) as Record<string, unknown>;

			// Forward opencode's configured MCP servers to the Cursor
			// agent so it can use the same servers. Opt out via
			// `provider.cursor.options.forwardMcp: false`.
			autoCompaction = existingOptions["autoCompaction"] === true;
			forwardMcp = existingOptions["forwardMcp"] !== false;
			userMcp = (existingOptions["mcpServers"] ?? {}) as Record<
				string,
				McpServerConfig
			>;
			const baseMcpServers = forwardMcp
				? { ...userMcp, ...translateMcpServers(config.mcp) }
				: userMcp;

			// Bridge other plugins' custom tools to the Cursor agent via a
			// local stdio MCP server. Opt out with
			// `provider.cursor.options.forwardPluginTools: false`; filter with
			// `provider.cursor.options.pluginTools: { include, exclude }`.
			forwardPluginTools = existingOptions["forwardPluginTools"] !== false;
			pluginToolOptions = existingOptions["pluginTools"] as
				| { include?: string[]; exclude?: string[] }
				| undefined;
			const pluginToolsServer = await syncPluginTools(
				config as Config | undefined,
			);
			const mcpServers = pluginToolsServer
				? { ...baseMcpServers, "opencode-plugin-tools": pluginToolsServer }
				: baseMcpServers;

			// opencode forwards a model's own options.params on the normal chat
			// path, but a subagent inheriting its parent's model reaches the provider
			// with them dropped — letting Cursor's server-side `fast: true` apply.
			// Thread the defaults through provider options (per-provider, survives
			// the drop) so the provider can re-apply them as a floor.
			const modelParamDefaults: Record<string, Record<string, string>> = {};
			for (const item of models) {
				const params = defaultModelParams(item);
				if (Object.keys(params).length > 0) modelParamDefaults[item.id] = params;
			}

			// One canonical cwd for the provider's rule write and our dispose
			// cleanup: an explicit user option wins, else the plugin directory.
			const optionCwd = existingOptions["cwd"];
			resolvedCwd =
				(typeof optionCwd === "string" ? optionCwd : undefined) ??
				directory ??
				process.cwd();

			// Forward opencode's resolved skills (both project and global scope) to
			// the Cursor agent by mirroring them into `<cwd>/.cursor/skills/`. Cursor
			// discovers these natively when the `project` settings layer is loaded.
			// Opt out via `provider.cursor.options.forwardSkills: false`. Manual
			// include/exclude override via `provider.cursor.options.skills`.
			forwardSkills = existingOptions["forwardSkills"] !== false;
			const skillsOpt = existingOptions["skills"] as
				| { include?: string[]; exclude?: string[] }
				| undefined;
			skillFilterOptions = skillsOpt;

			if (forwardSkills) {
				try {
					const resolved = resolveSkills(
						resolvedCwd,
						config as Config | undefined,
						skillFilterOptions,
						pluginSkillSources,
					);
					writeSkillMirror(resolvedCwd, resolved.skills, (msg) =>
						pluginLog("warn", msg),
					);
					currentSkillsCatalogue = buildSkillsCatalogue(resolved.skills) ?? "";
					lastSkillHash = skillSetHash(resolved.skills);
					if (resolved.withheld.length > 0) {
						pluginLog("warn", "skills withheld from mirror", {
							withheld: resolved.withheld.map((w) => ({
								id: w.id,
								reason: w.reason,
							})),
						});
					}
				} catch (error) {
					pluginLog("warn", "skill mirror failed", {
						error: error instanceof Error ? error.message : String(error),
						impact: "skills unavailable to the Cursor agent this session",
					});
				}
			}

			config.provider[PROVIDER_ID] = {
				name: "Cursor",
				npm: providerNpm(),
				...existing,
				options: {
					...existingOptions,
					cwd: resolvedCwd,
					...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
					...(Object.keys(modelParamDefaults).length > 0
						? { modelParamDefaults }
						: {}),
					...(currentSkillsCatalogue
						? { skillsCatalogue: currentSkillsCatalogue }
						: {}),
				},
				models: {
					...toOpencodeModels(models, { autoCompaction }),
					...(existing.models ?? {}),
				},
			};
		},

		provider: {
			id: PROVIDER_ID,
			models: async (_provider, ctx) => {
				const apiKey = apiKeyFromAuth(ctx.auth);
				const { models } = await discoverModels({ apiKey });
				return buildModelV2Map(models, { autoCompaction });
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
			// opencode runs its own title-generation call on the same sessionID as
			// a session's real first turn, concurrently, with an unrelated (empty)
			// system prompt. Mark it ephemeral so the provider always treats it as
			// a side-call regardless of whether a pool record exists yet — without
			// this, a race between the two calls' agent-creation round-trips can
			// let the title call's fingerprint win and permanently overwrite the
			// session's pool record (see language-model.ts's `ephemeral` check).
			if (input.agent === "title") {
				output.options["ephemeral"] = true;
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
					const liveConfig = cfgRes?.data as Config | undefined;
					const liveMcp = liveConfig?.mcp;
					const status = statusRes?.data as McpStatusMap | undefined;
					if (status) {
						// Re-sync the plugin-tools bridge against the live config too,
						// so plugins added mid-session reach Cursor on the next turn.
						// (Runs here as well as in the dedicated block below so the
						// merged server set always carries the latest bridge config.)
						const liveToolsServer = await syncPluginTools(liveConfig);
						const liveServers: Record<string, McpServerConfig> = {
							...userMcp,
							...translateMcpServers(liveMcp, status),
						};
						if (liveToolsServer) {
							liveServers["opencode-plugin-tools"] = liveToolsServer;
						}
						output.options["mcpServers"] = liveServers;
						// Notify (once) about OAuth servers we can't forward: opencode
						// holds their token and it never reaches config.mcp, so the
						// Cursor agent can't connect. Only those without a shareable
						// client registration are skipped; ones with a clientId are
						// forwarded with an `auth` block for the agent's own OAuth flow.
						const unshareable = findUnshareableOAuthServers(liveMcp, status).filter(
							(name) => !warnedOAuth.has(name),
						);
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
			} else if (client && forwardPluginTools && mirroredTools.length > 0) {
				// `forwardMcp: false` still leaves the plugin-tools bridge live
				// (it's independent of opencode MCP forwarding), so re-sync it
				// against the live config and keep it in the forwarded set.
				// Guard on `mirroredTools` so installs with no plugin tools keep
				// `mcpServers` entirely absent from the per-turn output.
				try {
					const query = directory ? { query: { directory } } : undefined;
					const cfgRes = await client.config.get(query);
					const liveConfig = cfgRes?.data as Config | undefined;
					const liveToolsServer = await syncPluginTools(liveConfig);
					const liveServers: Record<string, McpServerConfig> = {
						...userMcp,
					};
					if (liveToolsServer) {
						liveServers["opencode-plugin-tools"] = liveToolsServer;
					}
					if (Object.keys(liveServers).length > 0) {
						output.options["mcpServers"] = liveServers;
					}
				} catch {
					// Keep the static snapshot; live re-sync is best-effort.
				}
			}

			// Re-sync the skill mirror from opencode's *live* state so skills
			// added/removed mid-session reach the Cursor agent on the next turn.
			// Hash the resolved skill set and skip the write when unchanged.
			if (forwardSkills) {
				if (client) {
					try {
						const query = directory ? { query: { directory } } : undefined;
						const cfgRes = await client.config.get(query);
						const liveConfig = cfgRes?.data as Config | undefined;
						// Live skill inventory from opencode (`app.skills`) — covers
						// plugin-bundled skills and any other source the filesystem
						// scan can't see. Merged at lowest priority.
						let liveSkills: LiveSkill[] | undefined;
						try {
							// SAFETY: `app.skills` is the V2 endpoint (/app/skills); the V1
							// client typings this repo imports predate it, so widen here.
							// The call is optional-chained and caught, so a host without the
							// endpoint degrades to the filesystem scan.
							const app = client.app as unknown as {
								skills?: (params?: unknown) => Promise<{ data?: unknown } | undefined>;
							};
							const skillsRes = await app.skills?.(query);
							liveSkills = skillsRes?.data as LiveSkill[] | undefined;
						} catch {
							// Live inventory is best-effort; the filesystem scan stands.
						}
						const resolved = resolveSkills(
							resolvedCwd,
							liveConfig,
							skillFilterOptions,
							{ ...pluginSkillSources, liveSkills },
						);
						const hash = skillSetHash(resolved.skills);
						if (hash !== lastSkillHash) {
							writeSkillMirror(resolvedCwd, resolved.skills, (msg) =>
								pluginLog("warn", msg),
							);
							currentSkillsCatalogue = buildSkillsCatalogue(resolved.skills) ?? "";
							lastSkillHash = hash;
						}
					} catch {
						// Keep the existing mirror; live re-sync is best-effort.
					}
				}
				// Always override the startup snapshot, including with an empty
				// string when all skills were removed or withheld.
				output.options["skillsCatalogue"] = currentSkillsCatalogue;
			}
		},

		// Stamp the child session id on the RUNNING `task` part. The provider
		// creates the child session when the Cursor subagent starts and
		// publishes call→child on the bridge registry; when opencode's
		// processor lands the task part (`message.part.updated`), patch it
		// (`part.update`, the native `ctx.metadata` equivalent) so the TUI
		// card carries `state.metadata.sessionId` from the start — matching
		// the native task tool, which publishes the id at execute time. The
		// processor emits a running-state part update for every streamed
		// tool part, so this fires early; the stamp is idempotent.
		event: async (input) => {
			const evt = input.event;
			if (evt.type !== "message.part.updated") return;
			const part = evt.properties.part;
			if (!part || part.type !== "tool" || part.tool !== "task") return;
			const childId = subagentCallChildId(part.callID);
			if (!childId) return;
			void stampTaskPartSessionId({
				sessionID: part.sessionID,
				messageID: part.messageID,
				partID: part.id,
				part,
				childId,
			});
		},

		tool: {
			cursor_update_plugin: {
				description:
					"Check if the @stablekernel/opencode-cursor plugin is up to date and update it if not. Call this when the user asks to update, upgrade, or refresh the cursor plugin. Clears the cached install so opencode fetches the latest version on next launch.",
				args: {},
				execute: async () => {
					if (process.env.CI || process.env.NO_UPDATE_NOTIFIER) {
						return {
							title: "cursor plugin (checks disabled)",
							output: "Update checks are disabled (CI or NO_UPDATE_NOTIFIER is set).",
							metadata: {
								local: undefined,
								latest: undefined,
								status: "disabled" as const,
							},
						};
					}

					const local = getLocalVersion();
					if (!local || !semver.valid(local)) {
						return {
							title: "cursor plugin (unknown version)",
							output: "Could not determine the installed plugin version.",
							metadata: { local, latest: undefined, status: "failed" as const },
						};
					}

					const latest = await getLatestVersion();
					if (!latest || !semver.valid(latest)) {
						return {
							title: "cursor plugin (registry unavailable)",
							output:
								"Could not fetch the latest version from npm. Check your network connection and try again.",
							metadata: { local, latest, status: "failed" as const },
						};
					}

					if (!semver.gt(latest, local)) {
						return {
							title: "cursor plugin (up to date)",
							output: `The plugin is up to date (v${local}).`,
							metadata: { local, latest, status: "up-to-date" as const },
						};
					}

					// Plugin is outdated — clear the opencode plugin cache so it re-fetches on next launch.
					const cachePath = PLUGIN_CACHE_PATH;
					const removeCommand =
						process.platform === "win32"
							? `rmdir /s /q "${cachePath}"`
							: `rm -rf ${cachePath}`;

					try {
						rmSync(cachePath, { recursive: true, force: true });
						clearVersionCache();
						return {
							title: "cursor plugin (updated)",
							output:
								`Plugin cache cleared (v${local} → v${latest}).\n` +
								`Restart opencode to complete the upgrade — it will fetch v${latest} on next launch.`,
							metadata: { local, latest, status: "updated" as const },
						};
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						return {
							title: "cursor plugin (cache clear failed)",
							output:
								`Failed to clear plugin cache: ${message}\n\n` +
								`To update manually, exit opencode and run:\n\n` +
								`  ${removeCommand}\n\n` +
								`then restart opencode.`,
							metadata: { local, latest, status: "failed" as const },
						};
					}
				},
			},
			cursor_refresh_models: {
				description:
					"Refresh the live Cursor model catalog now (bypasses the cache) and report the available models. The catalog also auto-refreshes on every opencode startup; use this to pick up new models mid-session. Note: to update the plugin itself (not just the model list), use the cursor_update_plugin tool.",
				args: {},
				execute: async () => {
					const result = await discoverModels({ forceRefresh: true });
					const lines = result.models.map((m) => `- ${m.id} — ${m.displayName}`);
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

		dispose: async () => {
			// Best-effort: drop the generated system-prompt rule and skill mirror
			// so they don't linger in the user's workspace / Cursor IDE after the
			// session ends. Uses the same canonical cwd the provider wrote to;
			// sentinel-guarded, so user-owned files are never deleted.
			removeSystemRule(resolvedCwd);
			removeSkillMirror(resolvedCwd);
			await pluginToolsBridge?.close();
			pluginToolsBridge = undefined;
			clearSubagentBridge();
			clearLogBridge();
		},
	};
};

export default CursorPlugin;
