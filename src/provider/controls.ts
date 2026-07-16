import type { AgentModeOption, ModelSelection } from "@cursor/sdk";

/** Per-model static control defaults (from provider/model config options). */
export interface StaticControls {
  mode: AgentModeOption;
  /** Default Cursor model params (id -> value), e.g. { thinking: "high" }. */
  params?: Record<string, string>;
  /**
   * Per-model floor params, applied UNDER {@link params} and per-request options
   * (an explicit param always wins). Pins Cursor's boolean toggles, e.g.
   * `{ fast: "false" }`, when a turn arrives with no params of its own.
   */
  defaults?: Record<string, string>;
}

export interface ResolvedControls {
  mode: AgentModeOption;
  modelSelection: ModelSelection;
}

/**
 * Build a Cursor `ModelSelection` from a model id and an optional map of model
 * params (e.g. `{ thinking: "high" }`). Shared by the provider control
 * resolution and the cloud/delegate tools so param handling stays consistent.
 */
export function buildModelSelection(
  modelId: string,
  params?: Record<string, string>,
): ModelSelection {
  const paramList = Object.entries(params ?? {}).map(([id, value]) => ({ id, value }));
  return paramList.length > 0 ? { id: modelId, params: paramList } : { id: modelId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMode(value: unknown): value is AgentModeOption {
  return value === "agent" || value === "plan";
}

/**
 * Resolve the per-turn Cursor controls from static config plus opencode's
 * per-request `providerOptions.cursor` (which carries merged model `options` and
 * the selected model `variant`). Per-request values win over static defaults.
 *
 * Recognized keys in `providerOptions.cursor`:
 *  - `mode`: "agent" | "plan"
 *  - `params`: Record<string,string> of Cursor model params (e.g. { thinking: "high" })
 *  - `thinking`: string convenience, mapped to the `thinking` param if not already set
 */
export function resolveControls(
  modelId: string,
  staticControls: StaticControls,
  providerOptions: Record<string, unknown> | undefined,
): ResolvedControls {
  const po = providerOptions ?? {};

  const mode: AgentModeOption = isMode(po["mode"]) ? po["mode"] : staticControls.mode;

  const params: Record<string, string> = {
    ...(staticControls.defaults ?? {}),
    ...(staticControls.params ?? {}),
  };
  if (isRecord(po["params"])) {
    for (const [key, value] of Object.entries(po["params"])) {
      if (value != null) params[key] = String(value);
    }
  }
  if (typeof po["thinking"] === "string" && params["thinking"] === undefined) {
    params["thinking"] = po["thinking"];
  }

  return { mode, modelSelection: buildModelSelection(modelId, params) };
}
