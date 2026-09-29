/**
 * opencode v2 plugin setup for the Cursor provider.
 *
 * v2 (>= 2.0.19) loads plugins via a default export with `{ id, setup }` and
 * never calls the v1 `server()` entrypoint, so the core behavior is
 * re-registered through the v2 transform/hook API:
 *
 *  - auth:    declares the Cursor API-key method plus the CURSOR_API_KEY env
 *             fallback; the key is resolved per call from the stored
 *             integration connection or env (same resolution order as v1's
 *             auth.loader → src/api-key.ts).
 *  - provider: registers the `cursor` provider backed by THIS package via the
 *             `aisdk:` package prefix — the v2 runner imports the package,
 *             calls its `create*` export (createCursor) with the merged
 *             provider/model settings as options, and asks it for a language
 *             model per request. Discovered models seed the catalog with real
 *             per-model cost (resolveCost) and defaultModelParams pinned as
 *             settings.params. `settings.cwd` pins the agent to
 *             ctx.location.directory, so the provider runs from the session
 *             directory even when the v2 runner process has another cwd. The
 *             package specifier honors OPENCODE_CURSOR_PROVIDER_NPM (same
 *             override as v1) so local checkouts can point v2 at a `file://`
 *             build instead of the published npm copy.
 *  - session: the "context" hook forwards the session id and plan mapping
 *             (the v1 `chat.params` equivalent); the "title" hook marks
 *             title generation ephemeral (v2 dispatches titles through their
 *             own hook, not the context hook).
 *  - tool:    `cursor_refresh_models` only, with the same execute body as v1,
 *             adapted to the v2 tool shape. The other v1 tools are NOT
 *             registered on v2:
 *              - `cursor_update_plugin` clears the v1 `packages/` cache
 *                layout; v2 caches plugins under `<cache>/npm/<spec>/` and
 *                updates them with `opencode plugin update`, so a v1
 *                cache-clear would report success while doing nothing.
 *              - `cursor_delegate` / `cursor_cloud_agent` are fail-closed on
 *                v1 via the per-call `ask` approval gate; v2's plugin
 *                ToolContext has no `ask`/`assert` path a plugin can drive,
 *                and nothing else in 2.0.19 enforces one, so registering them
 *                would run Cursor agents ungated. Absent = fail-closed.
 *
 * Known gaps vs v1 (documented in README): delegation tools and the update
 * tool are unavailable on v2 (see above), no live MCP forwarding, no skill
 * mirror/skills catalogue, no plugin-tools bridge, no subagent task-part
 * stamping, no update toast (v2 has no ctx.tui), no app.log bridge (v2
 * removed the write endpoint), and the `autoCompaction` provider option is
 * not honored (models are always listed with the no-auto-compaction limit).
 */
import { tool } from "@opencode-ai/plugin";
import { discoverModels } from "../model-discovery.js";
import { defaultModelParams } from "../model-variants.js";
import { PROVIDER_ID, providerNpm } from "./model-v2.js";
import {
	resolveContextLimit,
	resolveOutputLimit,
	resolveCost,
	NO_AUTO_COMPACTION_INPUT_LIMIT,
} from "../model-limits.js";
import { buildModelVariants } from "../model-variants.js";
import { buildMaintenanceTools, REFRESH_DESCRIPTION_BASE } from "./cursor-tools.js";
import { removeSystemRule } from "../provider/system-rule.js";

/**
 * The structural contract of a v2 `Provider.Info`. Only the fields this
 * setup sets are declared; structural rest fields keep the literal
 * assignable to the real (effect-branded) schema type without importing it.
 * Settings (not `options`, which v2 does not define) is the channel the v2
 * runner forwards to the package's `create*` export as options — minus the
 * runner's reserved keys (timeout/chunkTimeout/compaction/transport/fetch).
 */
export type ProviderInfoV2 = {
	readonly id: string;
	readonly name: string;
	readonly activation: "auto" | "enabled" | "disabled";
	readonly package: string;
	readonly settings?: Record<string, unknown>;
	readonly [key: string]: unknown;
};

/**
 * The structural contract of a v2 `Model.Info` (subset used by this setup).
 * `settings` seeds the request overrides the runner merges per request;
 * `variants` are option sets the picker merges into the provider options.
 * `limit.input` is optional: v1 uses the `NO_AUTO_COMPACTION_INPUT_LIMIT`
 * sentinel to suppress auto-compaction; v2 just omits the field.
 */
export type ModelInfoV2 = {
	readonly id: string;
	readonly modelID?: string;
	readonly providerID: string;
	readonly name: string;
	readonly capabilities: {
		readonly tools: boolean;
		readonly input: readonly string[];
		readonly output: readonly string[];
	};
	readonly limit: {
		readonly context: number;
		readonly input?: number;
		readonly output: number;
	};
	readonly cost: ReadonlyArray<{
		readonly input: number;
		readonly output: number;
		readonly cache: { readonly read: number; readonly write: number };
	}>;
	readonly status: "alpha" | "beta" | "deprecated" | "active";
	readonly enabled: boolean;
	readonly variants?: ReadonlyArray<{
		readonly id: string;
		readonly settings?: Record<string, unknown>;
	}>;
	readonly time: { readonly released: number };
	readonly settings?: Record<string, unknown>;
	readonly package?: string;
	readonly [key: string]: unknown;
};

/**
 * The structural contract of a v2 `Tool.Metadata` result: `Readonly<Record<string, any>>`.
 */
export type ToolMetadataV2 = Record<string, unknown>;

/**
 * The structural contract of a v2 `Tool.Result` for a tool with NO output
 * schema (all cursor_* tools): `{ content, metadata }`. `output` is
 * `never`-typed in this case — the v2 runner rejects a result carrying an
 * `output` key with "Tool result declared output without an output schema".
 */
export interface ToolResultV2 {
	readonly content: string;
	readonly metadata?: ToolMetadataV2;
}

/**
 * v2 ToolContext surface the shared tool bodies need. The real context is
 * `{ sessionID, agent, messageID, id, signal, progress }` — there is no
 * `ask`/`abort`/`directory`, hence the delegation tools stay off v2.
 */
export interface ToolContextV2 {
	readonly sessionID?: string;
	readonly agent?: string;
	readonly messageID?: string;
	readonly id?: string;
	readonly signal?: AbortSignal;
	[key: string]: unknown;
}

/**
 * The slice of the v2 plugin Context this setup uses. Kept narrow so tests
 * can pass object-literal fakes; the real ctx satisfies it structurally.
 * Keeping the used members local also keeps the published `.d.ts` free of
 * v2 SDK imports (the v2 SDK is a devDependency; consumers do not have
 * it installed, so its types must not leak into the public surface).
 */
export interface PluginContextV2 {
	readonly location: { readonly directory: string };
	/** Plugin options from the `plugins: [pkg, options]` config entry. */
	readonly options?: Record<string, unknown>;
	readonly integration: {
		readonly transform: (
			callback: (editor: {
				readonly method: {
					readonly update: (input: {
						readonly integrationID: string;
						readonly method:
							| { readonly type: "key"; readonly label?: string }
							| { readonly type: "env"; readonly names: readonly string[] };
					}) => void;
				};
			}) => void,
		) => Promise<{ dispose: () => Promise<void> }>;
		readonly connection: {
			readonly active: (
				integrationID: string,
			) => Promise<ConnectionInfoV2 | undefined>;
			readonly resolve: (
				connection: ConnectionInfoV2,
			) => Promise<CredentialValueV2 | undefined>;
		};
	};
	readonly provider: {
		readonly transform: (
			callback: (editor: {
				readonly add: (input: {
					readonly info: ProviderInfoV2;
					readonly models: readonly ModelInfoV2[];
				}) => void;
			}) => void,
		) => Promise<{ dispose: () => Promise<void> }>;
	};
	readonly session: {
		readonly hook: (
			name: "context" | "title",
			callback: (event: {
				readonly sessionID: string;
				readonly agent?: string;
				options: Record<string, unknown>;
			}) => Promise<void> | void,
			options: { readonly providerID: string },
		) => Promise<{ dispose: () => Promise<void> }>;
	};
	readonly tool: {
		readonly transform: (
			callback: (editor: {
				readonly add: (tool: {
					readonly name: string;
					readonly description: string;
					readonly input: unknown;
					readonly execute: (
						input: unknown,
						context: ToolContextV2,
					) => Promise<ToolResultV2>;
				}) => void;
			}) => void,
		) => Promise<{ dispose: () => Promise<void> }>;
	};
}

/**
 * Structural stand-in for `@opencode/client`'s generated `ConnectionInfo`
 * (the union of ConnectionCredentialInfo and ConnectionEnvInfo) — kept local
 * so the public types do not import the dev-only v2 SDK chain.
 */
export type ConnectionInfoV2 =
	| { readonly type: "credential"; readonly id: string; readonly label?: string; readonly method?: "key" | "oauth" }
	| { readonly type: "env"; readonly name: string };

/**
 * Structural stand-in for `@opencode/client`'s `Credential.Value` union
 * (Key | OAuth). Only the Key branch carries the usable key.
 */
export type CredentialValueV2 =
	| { readonly type: "key"; readonly key: string }
	| {
			readonly type: "oauth";
			readonly methodID: string;
			readonly refresh: string;
			readonly access: string;
			readonly expires: number;
	  };

type Registration = { dispose: () => Promise<void> };

/**
 * Shape one discovered Cursor model as a v2 `Model.Info`. Carries the v1
 * variant/param channels on the settings rest so the picker and per-request
 * defaults keep working: variants are the option sets the picker merges into
 * the provider options, and settings.params pins the non-reasoning boolean
 * floors (e.g. `fast: "false"`). Cost uses the same resolveCost table as v1
 * (README promises per-model cost reporting on both hosts).
 */
function toModelInfo(
	id: string,
	name: string,
	item: Parameters<typeof buildModelVariants>[0],
): ModelInfoV2 {
	const variants = buildModelVariants(item);
	const variantList = Object.entries(variants).map(([variantId, variant]) => ({
		id: variantId,
		settings: variant as Record<string, unknown>,
	}));
	// Same defaults v1 pins into each model's options.params: the non-reasoning
	// boolean floors (e.g. `fast: "false"`), NOT a reasoning variant's params.
	const params = defaultModelParams(item);
	const c = resolveCost(id);
	return {
		id,
		modelID: id,
		providerID: PROVIDER_ID,
		name,
		capabilities: {
			tools: true,
			input: ["text", "image"],
			output: ["text"],
		},
		limit: {
			context: resolveContextLimit(id),
			// v1 emits the NO_AUTO_COMPACTION_INPUT_LIMIT sentinel to suppress
			// auto-compaction; v2's limit.input is optional, so omitting it has
			// the same effect. (Honoring `autoCompaction: true` on v2 is a
			// documented gap — see README "Known v2 gaps".)
			input: NO_AUTO_COMPACTION_INPUT_LIMIT,
			output: resolveOutputLimit(id),
		},
		cost: [{ input: c.input, output: c.output, cache: { read: c.cacheRead, write: c.cacheWrite } }],
		status: "active",
		enabled: true,
		variants: variantList,
		time: { released: 0 },
		...(Object.keys(params).length > 0 ? { settings: { params } } : {}),
		package: `aisdk:${providerNpm()}`,
	};
}

export async function cursorV2Setup(
	context: PluginContextV2,
): Promise<() => Promise<void>> {
	const ctx = context;
	const registrations: Registration[] = [];

	// --- auth: declare the key method + env fallback for integration "cursor".
	registrations.push(
		await ctx.integration.transform((editor) => {
			editor.method.update({
				integrationID: PROVIDER_ID,
				method: { type: "key", label: "Cursor API Key" },
			});
			editor.method.update({
				integrationID: PROVIDER_ID,
				method: { type: "env", names: ["CURSOR_API_KEY"] },
			});
		}),
	);

	// --- resolve the stored Cursor key once, before discovery and tools.
	// v2 stores auth per integration (`opencode auth login` → connection);
	// `connection.active` returns the active connection, `resolve` its
	// credential value. Re-resolved before each tool call, so a key saved
	// mid-session is picked up without a restart.
	const storedKey = async (): Promise<string | undefined> => {
		const conn = await ctx.integration.connection.active(PROVIDER_ID).catch(() => undefined);
		if (!conn) return undefined;
		const cred = await ctx.integration.connection.resolve(conn).catch(() => undefined);
		return cred?.type === "key" ? cred.key : undefined;
	};

	// --- provider + models: one catalog built from the shared discovery helper.
	const { models } = await discoverModels({ apiKey: await storedKey() });
	const modelInfos = models.map((item) =>
		toModelInfo(item.id, item.displayName || item.id, item),
	);

	// Same canonical cwd the v1 `config` hook resolves: the plugin's location
	// directory (the session/project cwd), NOT the runner process's cwd — the
	// v2 runner is often a long-lived background service started elsewhere.
	// Handed to the provider through `settings`, the channel the v2 runner
	// spreads into the package's `create*` options (minus its reserved keys).
	const resolvedCwd = ctx.location.directory;

	registrations.push(
		await ctx.provider.transform((editor) => {
			editor.add({
				info: {
					id: PROVIDER_ID,
					name: "Cursor",
					activation: "auto",
					package: `aisdk:${providerNpm()}`,
					settings: { cwd: resolvedCwd },
				},
				models: modelInfos,
			});
		}),
	);

	// --- per-turn options: the v1 chat.params equivalent, scoped to cursor.
	registrations.push(
		await ctx.session.hook(
			"context",
			async (event) => {
				event.options.sessionID = event.sessionID;
				if (event.agent === "plan" && event.options["mode"] === undefined) {
					event.options["mode"] = "plan";
				}
			},
			{ providerID: PROVIDER_ID },
		),
	);

	// --- title generation runs through v2's own `title` hook (SessionTitle
	// extends SessionRequest and has no `agent` field, so the context hook
	// never sees it). Mark it ephemeral for the same reason as the v1
	// chat.params hook: it shares the sessionID with the session's real first
	// turn, and an un-marked side-call can win the pool-record race and
	// permanently overwrite the session's agent (language-model.ts).
	registrations.push(
		await ctx.session.hook(
			"title",
			(event) => {
				event.options["ephemeral"] = true;
				event.options.sessionID = event.sessionID;
			},
			{ providerID: PROVIDER_ID },
		),
	);

	// --- tools: v2 exposes only `cursor_refresh_models`. Same execute body as
	// v1, adapted to the v2 tool shape: inputs as StandardSchemaV1 (a zod v4
	// object carries `~standard`), and results as `{ content, metadata }` —
	// the runner rejects `output` for tools without an output schema.
	// `cursor_update_plugin`, `cursor_delegate` and `cursor_cloud_agent` are
	// NOT registered on v2 (see the file header for why) — buildMaintenanceTools
	// returns both, so only refresh survives the filter.
	const refreshTool = buildMaintenanceTools({ resolveApiKey: storedKey })[
		"cursor_refresh_models"
	];
	if (!refreshTool) throw new Error("cursor_refresh_models tool is missing");

	registrations.push(
		await ctx.tool.transform((editor) => {
			editor.add({
				name: "cursor_refresh_models",
				// Same description body as v1, but the trailing note points at
				// v2's own updater — `cursor_update_plugin` is not registered
				// here (see the file header for why), so referencing it would
				// send the model (and the user) to a tool that does not exist.
				description: `${REFRESH_DESCRIPTION_BASE} Note: to update the plugin itself (not just the model list), run opencode plugin update.`,
				// v2's Tool.ValueSchema accepts StandardSchemaV1 (a zod v4
				// object carries `~standard`), not the raw zod *shape* the v1
				// `tool()` helper stores in `args`.
				input: tool.schema.object(refreshTool.args),
				execute: async (input, context) => {
					// The v2 ToolContext has {sessionID, agent, messageID, id,
					// signal, progress} — no ask/abort/directory. The refresh
					// body touches none of them. `refreshTool.execute` resolves
					// the stored key itself (v2 deps above).
					const result = await refreshTool.execute(input as never, context as never);
					return adaptToolResult(result);
				},
			});
		}),
	);

	return async () => {
		for (const registration of registrations.splice(0)) {
			try {
				await registration.dispose();
			} catch {
				// dispose is best-effort cleanup; a failing registration must not
				// block the others.
			}
		}
		// Same best-effort cleanup as v1's dispose: drop the generated
		// system-prompt rule so it does not linger in the repo / Cursor IDE
		// after the session. Sentinel-guarded — a user-owned file is kept.
		removeSystemRule(resolvedCwd);
	};
}

/**
 * Adapt a v1 tool result (`string | { title?, output, metadata? }`) to the
 * v2 `Tool.Result` for a tool without an output schema: `{ content, metadata }`.
 * `output` must never be returned — the v2 runner rejects it with
 * "Tool result declared output without an output schema".
 */
export function adaptToolResult(result: string | { output: string; metadata?: Record<string, unknown> }): ToolResultV2 {
	if (typeof result === "string") return { content: result };
	return {
		content: result.output,
		...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
	};
}
