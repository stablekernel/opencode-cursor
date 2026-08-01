import type { ModelListItem } from "@cursor/sdk";
import type { Config } from "@opencode-ai/plugin";
import { fingerprintApiKey, resolveCursorApiKey } from "./api-key.js";
import { resolveContextLimit, resolveCost, resolveOutputLimit } from "./model-limits.js";
import { readLatestModelCache, readModelCache, writeModelCache } from "./model-cache.js";
import { FALLBACK_MODELS } from "./fallback-models.js";
import { loadCursorSdk } from "./cursor-runtime.js";
import { buildModelVariants, defaultModelParams, type CursorVariant } from "./model-variants.js";

export type ModelSource = "live" | "cache" | "fallback";

export interface DiscoveryResult {
  models: ModelListItem[];
  source: ModelSource;
  /** Human-readable note when discovery degraded (e.g. missing key, error). */
  warning?: string;
}

export interface DiscoverOptions {
  /** Explicit key; falls back to CURSOR_API_KEY. */
  apiKey?: string;
  /** Bypass the on-disk cache and force a live `Cursor.models.list()`. */
  forceRefresh?: boolean;
}

/**
 * Discover the Cursor model catalog. Tries (in order): on-disk cache (unless
 * forced), live `Cursor.models.list()`, then the static fallback snapshot.
 * Always resolves — failures degrade to the fallback with a `warning`.
 */
export async function discoverModels(options: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const apiKey = resolveCursorApiKey(options.apiKey);
  if (!apiKey) {
    // No key here (e.g. the keyless `config` hook). Prefer the real catalog a
    // prior authed load cached, so opencode's picker shows the full list rather
    // than only the static snapshot.
    const latest = readLatestModelCache();
    if (latest && latest.length > 0) return { models: latest, source: "cache" };
    return {
      models: FALLBACK_MODELS,
      source: "fallback",
      warning:
        "No Cursor API key found. Run `opencode auth login` and choose Cursor, or set CURSOR_API_KEY. Showing fallback models.",
    };
  }

  const fingerprint = fingerprintApiKey(apiKey);

  if (!options.forceRefresh) {
    const cached = readModelCache(fingerprint);
    if (cached && cached.length > 0) {
      return { models: cached, source: "cache" };
    }
  }

  try {
    const { Cursor } = await loadCursorSdk();
    const models = await Cursor.models.list({ apiKey });
    if (models.length > 0) {
      writeModelCache(fingerprint, models);
      return { models, source: "live" };
    }
    return {
      models: FALLBACK_MODELS,
      source: "fallback",
      warning: "Cursor.models.list() returned no models; showing fallback models.",
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // A stale cache is better than nothing on a transient failure.
    const stale = readModelCache(fingerprint);
    if (stale && stale.length > 0) {
      return { models: stale, source: "cache", warning: `Live discovery failed (${detail}); using cached models.` };
    }
    return {
      models: FALLBACK_MODELS,
      source: "fallback",
      warning: `Live discovery failed (${detail}); showing fallback models.`,
    };
  }
}

/** True when a model exposes a thinking/reasoning parameter. */
export function modelSupportsReasoning(item: ModelListItem): boolean {
  return (item.parameters ?? []).some((p) => /think|reason/i.test(p.id));
}

/** Shape of a single entry in opencode's `provider.<id>.models` config map. */
export interface OpencodeModelConfigEntry {
  id: string;
  name: string;
  attachment: boolean;
  reasoning: boolean;
  temperature: boolean;
  tool_call: boolean;
  /**
   * opencode model variants (thinking levels + plan mode). They MUST be seeded
   * here: opencode discards the plugin `provider.models()` hook for providers
   * absent from its models.dev catalog, so this config map is the only channel
   * through which cursor model variants reach the picker.
   */
  variants: Record<string, CursorVariant>;
  /**
   * Default `providerOptions.cursor` for the model, merged into every request
   * unless a variant overrides it. Carries the non-reasoning boolean defaults
   * (e.g. `{ params: { fast: "false" } }`) so the provider never silently runs
   * Cursor's server-side `fast` default. See {@link defaultModelParams}.
   */
  options: { params?: Record<string, string> };
  /**
   * Per-model context/output window. opencode's config channel is the only
   * one that reaches the model registry for providers absent from
   * models.dev, so the TUI session header's context-window percentage
   * depends on this being present. Both fields are required by the schema.
   */
  limit: { context: number; output: number };
  /**
   * Per-model API pricing, USD per million tokens. Note the FLAT snake_case
   * cache keys — the config schema (`ProviderConfig` in
   * `@opencode-ai/sdk`) uses `cache_read`/`cache_write`, unlike the
   * `ModelV2` shape's nested `cache: { read, write }`.
   */
  cost: { input: number; output: number; cache_read: number; cache_write: number };
}

/**
 * Compile-time guard: the entries we write into
 * `config.provider.cursor.models` must satisfy the shape opencode's config
 * schema accepts. If opencode changes the schema (or we drift, e.g. by
 * using `cache: { read, write }` instead of `cache_read`/`cache_write`),
 * `npm run typecheck` fails here rather than silently producing a config
 * opencode discards.
 */
type AcceptedModelConfig = NonNullable<
  NonNullable<NonNullable<Config["provider"]>[string]>["models"]
>[string];
const _entryShapeGuard: AcceptedModelConfig = {} as OpencodeModelConfigEntry;
void _entryShapeGuard;

/**
 * Assignability alone is too weak for `cost`/`limit`. Excess-property checking
 * only applies to fresh object literals, and the schema's cache keys are
 * optional — so a drifted `cost: { input, output, cache: { read, write } }`
 * assigns cleanly to the accepted shape (verified: it typechecks) while
 * opencode would read `cache_read`/`cache_write` as absent. These guards
 * assert every key we emit is a key the schema actually declares.
 *
 * `never` means "no excess keys"; anything else collapses `_KeysAccepted` to
 * `never` and the `true` initializer below fails to compile.
 */
type _KeysAccepted<Ours, Accepted> = Exclude<keyof Ours, keyof Accepted> extends never ? true : never;
const _costKeyGuard: _KeysAccepted<
  OpencodeModelConfigEntry["cost"],
  NonNullable<AcceptedModelConfig["cost"]>
> = true;
void _costKeyGuard;
const _limitKeyGuard: _KeysAccepted<
  OpencodeModelConfigEntry["limit"],
  NonNullable<AcceptedModelConfig["limit"]>
> = true;
void _limitKeyGuard;

/**
 * Map discovered Cursor models to opencode's provider config `models` map. The
 * Cursor SDK runs an agent (it calls tools itself), so every model is marked
 * `tool_call: true` and `temperature: false`.
 */
export function toOpencodeModels(items: ModelListItem[]): Record<string, OpencodeModelConfigEntry> {
  const out: Record<string, OpencodeModelConfigEntry> = {};
  for (const item of items) {
    const params = defaultModelParams(item);
    const cost = resolveCost(item.id);
    out[item.id] = {
      id: item.id,
      name: item.displayName || item.id,
      attachment: true,
      reasoning: modelSupportsReasoning(item),
      temperature: false,
      tool_call: true,
      variants: buildModelVariants(item),
      options: Object.keys(params).length > 0 ? { params } : {},
      limit: {
        context: resolveContextLimit(item.id),
        output: resolveOutputLimit(item.id),
      },
      cost: {
        input: cost.input,
        output: cost.output,
        cache_read: cost.cacheRead,
        cache_write: cost.cacheWrite,
      },
    };
  }
  return out;
}
