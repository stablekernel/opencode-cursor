import type { Model as ModelV2 } from "@opencode-ai/sdk/v2";
import type { ModelListItem } from "@cursor/sdk";
import { modelSupportsReasoning } from "../model-discovery.js";
import { buildModelVariants, defaultModelParams } from "../model-variants.js";

export const PROVIDER_ID = "cursor";
export const NPM_PACKAGE = "@stablekernel/opencode-cursor";

/**
 * The npm specifier opencode uses to load the provider SDK. Defaults to the
 * published package name; can be overridden with a `file://...` URL (which
 * opencode imports directly, skipping a registry install) via
 * `OPENCODE_CURSOR_PROVIDER_NPM` — useful for local development and CI before
 * the package is published.
 */
export function providerNpm(): string {
  return process.env.OPENCODE_CURSOR_PROVIDER_NPM?.trim() || NPM_PACKAGE;
}

/**
 * Per-model default context window limits (tokens), keyed by model id prefix.
 * Values from cursor.com/docs/account/pricing/request-based-legacy. The
 * "Max context" (1M for frontier models) requires Max Mode and is NOT used
 * here — the plugin can't detect Max Mode, so the default window is the
 * honest limit to display.
 *
 * Longest prefix wins: `claude-opus-4-8` (300K) beats `claude-opus-4` (200K).
 */
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "claude-sonnet-4": 200_000,
  "claude-sonnet-4-5": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-sonnet-5": 200_000,
  "claude-opus-4-5": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-opus-4-7": 300_000,
  "claude-opus-4-8": 300_000,
  "claude-opus-5": 300_000,
  "claude-haiku-4-5": 200_000,
  "claude-fable-5": 300_000,
  "gpt-5": 272_000,
  "gpt-5-mini": 272_000,
  "gpt-5.1": 272_000,
  "gpt-5.2": 272_000,
  "gpt-5.3-codex": 272_000,
  "gpt-5.4": 272_000,
  "gpt-5.5": 272_000,
  "gpt-5.6-luna": 272_000,
  "gpt-5.6-sol": 272_000,
  "gpt-5.6-terra": 272_000,
  "gemini-2.5-flash": 200_000,
  "gemini-3-flash": 200_000,
  "gemini-3.1-pro": 200_000,
  "gemini-3.5-flash": 200_000,
  "gemini-3.6-flash": 200_000,
  "grok-4.5": 256_000,
  "glm-5.2": 200_000,
  "composer-2": 200_000,
  "composer-2.5": 200_000,
  "auto-smart": 200_000,
};

const DEFAULT_CONTEXT_LIMIT = 200_000;

/**
 * Resolve a model's context window by longest-prefix match against
 * {@link MODEL_CONTEXT_LIMITS}. Falls back to 200K for unknown models.
 */
export function resolveContextLimit(modelId: string): number {
  let best: number | undefined;
  let bestLen = 0;
  for (const [prefix, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (modelId.startsWith(prefix) && prefix.length > bestLen) {
      best = limit;
      bestLen = prefix.length;
    }
  }
  return best ?? DEFAULT_CONTEXT_LIMIT;
}

/**
 * Build opencode's rich runtime `Model` objects from discovered Cursor models.
 * Used by the auth-aware `provider.models()` hook. Fields opencode does not get
 * from the Cursor catalog are filled with safe defaults (zero cost — Cursor
 * bills separately; generous context limits).
 */
export function buildModelV2Map(items: ModelListItem[]): Record<string, ModelV2> {
  const out: Record<string, ModelV2> = {};
  for (const item of items) {
    const params = defaultModelParams(item);
    out[item.id] = {
      id: item.id,
      providerID: PROVIDER_ID,
      api: { id: item.id, url: "", npm: providerNpm() },
      name: item.displayName || item.id,
      capabilities: {
        temperature: false,
        reasoning: modelSupportsReasoning(item),
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: resolveContextLimit(item.id), output: 32_000 },
      status: "active",
      options: Object.keys(params).length > 0 ? { params } : {},
      headers: {},
      release_date: "",
      variants: buildModelVariants(item) as ModelV2["variants"],
    };
  }
  return out;
}
