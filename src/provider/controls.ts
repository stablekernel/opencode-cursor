import type { AgentModeOption, ModelListItem, ModelSelection } from "@cursor/sdk";
import { isBooleanParam, paramValues, REASONING_PARAM } from "../model-variants.js";

type ModelParameters = NonNullable<ModelListItem["parameters"]>;

/** Per-model static control defaults (from provider/model config options). */
export interface StaticControls {
  mode: AgentModeOption;
  /** Default Cursor model params (id -> value), e.g. { effort: "high" }. */
  params?: Record<string, string>;
  /**
   * Per-model floor params, applied UNDER {@link params} and per-request options
   * (an explicit param always wins). Pins Cursor's boolean toggles, e.g.
   * `{ fast: "false" }`, when a turn arrives with no params of its own.
   */
  defaults?: Record<string, string>;
  /** The model's advertised params, when known; lets a `thinking` level reach the param the model actually reads. */
  parameters?: ModelParameters;
}

export interface ResolvedControls {
  mode: AgentModeOption;
  modelSelection: ModelSelection;
  /** Param adjustments the user should know about (log once, not per turn). */
  warnings: string[];
}

/**
 * Build a Cursor `ModelSelection` from a model id and an optional map of model
 * params (e.g. `{ effort: "high" }`). Shared by the provider control
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
 *  - `params`: Record<string,string> of Cursor model params (e.g. { effort: "high" })
 *  - `thinking`: string convenience, mapped to the `thinking` param if not already set.
 *    When the model's params are known and `thinking` can't carry the value, it moves
 *    to the model's reasoning-level param (e.g. grok's `effort`): Cursor silently
 *    ignores params a model doesn't accept (#119).
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

  const warnings = reconcileThinking(modelId, params, staticControls.parameters);
  return { mode, modelSelection: buildModelSelection(modelId, params), warnings };
}

function reconcileThinking(
  modelId: string,
  params: Record<string, string>,
  parameters: ModelParameters | undefined,
): string[] {
  const value = params["thinking"];
  if (value === undefined || !parameters) return [];
  const thinking = parameters.find((p) => p.id === "thinking");
  if (thinking && paramValues(thinking).includes(value)) return [];

  const why = thinking
    ? `${modelId}'s \`thinking\` param only accepts ${paramValues(thinking).join("|")}`
    : `${modelId} has no \`thinking\` param`;
  const levels = parameters.filter(
    (p) => p.id !== "thinking" && REASONING_PARAM.test(p.id) && paramValues(p).length > 0 && !isBooleanParam(paramValues(p)),
  );
  const level = levels[0];
  if (!level) return [`${why}; Cursor will ignore \`thinking: ${value}\`.`];
  const explicit = levels.find((p) => params[p.id] !== undefined);
  if (explicit) {
    delete params["thinking"];
    return [`${why}; ignored \`thinking: ${value}\` because \`${explicit.id}: ${params[explicit.id]}\` is set.`];
  }
  const accepted = paramValues(level);
  // opencode's standard top tier is "xhigh"; some Cursor models spell it "extra-high".
  const wire = accepted.includes(value)
    ? value
    : value === "xhigh" && accepted.includes("extra-high")
      ? "extra-high"
      : undefined;
  if (!wire) {
    return [`${why}; Cursor will ignore \`thinking: ${value}\`. Use ${level.id}=${accepted.join("|")}.`];
  }
  delete params["thinking"];
  params[level.id] = wire;
  return [`${why}; sent \`${level.id}: ${wire}\` instead.`];
}
