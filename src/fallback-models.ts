import type { ModelListItem } from "@cursor/sdk";

/**
 * A small static snapshot of well-known Cursor models, used only when live
 * discovery is unavailable (no API key, offline, or an SDK error). The live
 * `Cursor.models.list()` result always takes precedence; this just lets the
 * provider appear in opencode with sensible defaults so the user can reach the
 * login flow. Refresh the real catalog with the `cursor_refresh_models` tool.
 */
export const FALLBACK_MODELS: ModelListItem[] = [
  {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    description: "Cursor's default agent model (fallback entry).",
    parameters: [
      { id: "thinking", displayName: "Thinking", values: [{ value: "off" }, { value: "on" }] },
    ],
    variants: [
      { params: [{ id: "thinking", value: "off" }], displayName: "Composer 2.5", isDefault: true },
      { params: [{ id: "thinking", value: "on" }], displayName: "Composer 2.5" },
    ],
  },
  { id: "claude-opus-4-8", displayName: "Claude Opus 4.8 (via Cursor)" },
  { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6 (via Cursor)" },
  { id: "gpt-5.5", displayName: "GPT-5.5 (via Cursor)" },
];
