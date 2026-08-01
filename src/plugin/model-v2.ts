import type { Model as ModelV2 } from "@opencode-ai/sdk/v2";
import type { ModelListItem } from "@cursor/sdk";
import { modelSupportsReasoning } from "../model-discovery.js";
import { resolveContextLimit, resolveCost, resolveOutputLimit } from "../model-limits.js";
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
 * Build opencode's rich runtime `Model` objects from discovered Cursor models.
 * Used by the auth-aware `provider.models()` hook. Cost and context/output
 * limits are resolved per model from the shared maps in `../model-limits.js`,
 * falling back to $0 / 200K context / 32K output for models absent from them.
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
      cost: (() => {
        const c = resolveCost(item.id);
        return { input: c.input, output: c.output, cache: { read: c.cacheRead, write: c.cacheWrite } };
      })(),
      limit: { context: resolveContextLimit(item.id), output: resolveOutputLimit(item.id) },
      status: "active",
      options: Object.keys(params).length > 0 ? { params } : {},
      headers: {},
      release_date: "",
      variants: buildModelVariants(item) as ModelV2["variants"],
    };
  }
  return out;
}
