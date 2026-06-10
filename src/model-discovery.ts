import type { ModelListItem } from "@cursor/sdk";
import { fingerprintApiKey, resolveCursorApiKey } from "./api-key.js";
import { readLatestModelCache, readModelCache, writeModelCache } from "./model-cache.js";
import { FALLBACK_MODELS } from "./fallback-models.js";
import { loadCursorSdk } from "./cursor-runtime.js";

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
}

/**
 * Map discovered Cursor models to opencode's provider config `models` map. The
 * Cursor SDK runs an agent (it calls tools itself), so every model is marked
 * `tool_call: true` and `temperature: false`.
 */
export function toOpencodeModels(items: ModelListItem[]): Record<string, OpencodeModelConfigEntry> {
  const out: Record<string, OpencodeModelConfigEntry> = {};
  for (const item of items) {
    out[item.id] = {
      id: item.id,
      name: item.displayName || item.id,
      attachment: true,
      reasoning: modelSupportsReasoning(item),
      temperature: false,
      tool_call: true,
    };
  }
  return out;
}
