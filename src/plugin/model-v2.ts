import type { Model as ModelV2 } from "@opencode-ai/sdk/v2";
import type { ModelListItem } from "@cursor/sdk";
import { modelSupportsReasoning, resolveAdvertisedContextLimit } from "../model-discovery.js";
import {
  NO_AUTO_COMPACTION_INPUT_LIMIT,
  reportContextLimit,
  resolveContextLimit,
  resolveCost,
  resolveOutputLimit,
} from "../model-limits.js";
import { buildModelVariants, defaultModelParams } from "../model-variants.js";

export const PROVIDER_ID = "cursor";
export const NPM_PACKAGE = "@stablekernel/opencode-cursor";

import { localProviderSpec } from "../version-check.js";

/**
 * The npm (or `file://`) specifier opencode uses to load the provider SDK.
 * Defaults to the published package, or to this checkout's provider when the
 * plugin itself is a local path (so both halves always run the same code);
 * `OPENCODE_CURSOR_PROVIDER_NPM` overrides either.
 */
export function providerNpm(fallback = NPM_PACKAGE): string {
  return process.env.OPENCODE_CURSOR_PROVIDER_NPM?.trim() || localProviderSpec() || fallback;
}

/**
 * Build opencode's rich runtime `Model` objects from discovered Cursor models.
 * Used by the auth-aware `provider.models()` hook. Context comes from the
 * model's own `context` preset when it advertises one, else the shared map;
 * cost/output come per model from the shared maps in `../model-limits.js`,
 * falling back to $0 / 32K output for models absent from them.
 */
export function buildModelV2Map(
  items: ModelListItem[],
  opts: { autoCompaction?: boolean } = {},
): Record<string, ModelV2> {
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
      cost: (() => {
        const c = resolveCost(item.id);
        return { input: c.input, output: c.output, cache: { read: c.cacheRead, write: c.cacheWrite } };
      })(),
      limit: {
        context: reportContextLimit(
          resolveAdvertisedContextLimit(item) ?? resolveContextLimit(item.id),
        ),
        ...(opts.autoCompaction
          ? {}
          : { input: NO_AUTO_COMPACTION_INPUT_LIMIT }),
        output: resolveOutputLimit(item.id),
      },
      status: "active",
      options: Object.keys(params).length > 0 ? { params } : {},
      headers: {},
      release_date: "",
      variants: buildModelVariants(item) as ModelV2["variants"],
    };
  }
  return out;
}
