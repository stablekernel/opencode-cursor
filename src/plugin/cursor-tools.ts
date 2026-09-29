import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin";
import type { ModelListItem } from "@cursor/sdk";
import { rmSync } from "node:fs";
import semver from "semver";
import { runCloudAgent } from "../provider/cloud-agent.js";
import { runDelegate } from "../provider/delegate.js";
import { linkDelegateSession } from "../provider/subagent-bridge.js";
import { discoverModels } from "../model-discovery.js";
import {
  getLocalVersion,
  getLatestVersion,
  clearVersionCache,
  PLUGIN_CACHE_PATH,
} from "../version-check.js";

const s = tool.schema;

export interface CursorToolDeps {
  /**
   * Resolve the Cursor API key (from opencode auth, captured by the plugin's
   * auth loader, or the CURSOR_API_KEY env var). Returns undefined when no key
   * is available so the tool can return a clear "needs auth" message. Async
   * because v2 resolves the stored connection per call.
   */
  resolveApiKey: () => string | undefined | Promise<string | undefined>;
  /** Default working directory for local delegation (the session worktree/cwd). */
  defaultCwd: () => string;
}

const NEEDS_AUTH =
  "No Cursor API key available. Run `opencode auth login` and choose Cursor, or set CURSOR_API_KEY.";

/**
 * Request approval for a sensitive Cursor invocation. `context.ask` is the
 * opencode mechanism a custom tool uses to gate itself; it honors the user's
 * `permission` config (allow resolves silently, ask prompts, deny rejects).
 *
 * Returns `{ ok: true }` when approved, or `{ ok: false, reason }` when the
 * request was rejected. We deliberately do not claim the rejection was a policy
 * "deny" — `context.ask` rejects on both an explicit deny and an internal
 * failure, and conflating them produces misleading messages. The gate is
 * fail-closed: any rejection (including a host that doesn't provide `ask`)
 * blocks the call rather than silently allowing it.
 */
async function requestApproval(
  context: ToolContext,
  permission: string,
  patterns: string[],
  metadata: Record<string, unknown>,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    await context.ask({ permission, patterns, always: patterns, metadata });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build the Cursor delegation tools that complement the native provider:
 *  - `cursor_cloud_agent`: run a background agent on a remote repo (optionally
 *    opening a PR) — work that maps poorly onto the synchronous provider path.
 *  - `cursor_delegate`: run a single local Cursor turn as a permission-gated,
 *    auditable tool call (for users who want Cursor as a delegate rather than
 *    as their primary model).
 *
 * Both are gated via `context.ask`, so a user `permission` policy controls them.
 */
export function buildCursorTools(deps: CursorToolDeps): Record<string, ToolDefinition> {
  return {
    cursor_cloud_agent: tool({
      description:
        "Launch a Cursor background ('cloud') agent on a remote repository. Runs autonomously " +
        "(may take minutes) and can open a pull request. Returns the cloud agent id, final " +
        "status, result, and PR url when available.",
      args: {
        prompt: s.string().describe("The task/instruction for the background agent."),
        repoUrl: s
          .string()
          .describe("Target repository URL, e.g. https://github.com/owner/repo."),
        startingRef: s
          .string()
          .optional()
          .describe("Branch or ref to start from (defaults to the repo default branch)."),
        model: s.string().optional().describe("Cursor model id (optional for cloud)."),
        mode: s.enum(["agent", "plan"]).optional().describe("Conversation mode."),
        thinking: s.string().optional().describe("Sets the model's `thinking` param (\"true\"/\"false\"); only for models that advertise it. Ignored otherwise."),
        autoCreatePR: s
          .boolean()
          .optional()
          .describe("Open a pull request automatically when finished."),
        workOnCurrentBranch: s
          .boolean()
          .optional()
          .describe("Operate on the current branch instead of creating a new one."),
      },
      execute: async (args, context) => {
        const apiKey = await deps.resolveApiKey();
        if (!apiKey) return NEEDS_AUTH;

        const approval = await requestApproval(
          context,
          "cursor_cloud_agent",
          [args.repoUrl],
          { repoUrl: args.repoUrl, autoCreatePR: args.autoCreatePR ?? false },
        );
        if (!approval.ok) {
          return `Cloud agent not approved for ${args.repoUrl}${approval.reason ? `: ${approval.reason}` : "."}`;
        }

        let result;
        try {
          result = await runCloudAgent({
            apiKey,
            prompt: args.prompt,
            repoUrl: args.repoUrl,
            ...(args.startingRef ? { startingRef: args.startingRef } : {}),
            ...(args.model ? { model: args.model } : {}),
            ...(args.mode ? { mode: args.mode } : {}),
            ...(args.thinking ? { thinking: args.thinking } : {}),
            ...(args.autoCreatePR !== undefined ? { autoCreatePR: args.autoCreatePR } : {}),
            ...(args.workOnCurrentBranch !== undefined
              ? { workOnCurrentBranch: args.workOnCurrentBranch }
              : {}),
            abortSignal: context.abort,
          });
        } catch (err) {
          return `Cloud agent failed: ${errorMessage(err)}`;
        }

        const lines = [
          `Cloud agent ${result.agentId} — ${result.status}`,
          ...(result.prUrl ? [`PR: ${result.prUrl}`] : []),
          ...(result.branches.length > 0
            ? [`Branches: ${result.branches.map((b) => b.branch ?? b.repoUrl).join(", ")}`]
            : []),
          ...(result.result ? ["", result.result] : []),
          ...(result.progress.length > 0 ? ["", "Progress:", ...result.progress] : []),
        ];

        return {
          title: `Cursor cloud agent (${result.status})`,
          output: lines.join("\n"),
          metadata: {
            agentId: result.agentId,
            status: result.status,
            prUrl: result.prUrl ?? null,
            durationMs: result.durationMs ?? null,
          },
        };
      },
    }),

    cursor_delegate: tool({
      description:
        "Delegate a single subtask to a local Cursor agent and return its result. Use to hand " +
        "off discrete work to Cursor while keeping your primary model in control. Permission-gated.",
      args: {
        prompt: s.string().describe("The subtask to delegate to Cursor."),
        model: s.string().describe("Cursor model id to run the delegation on."),
        mode: s.enum(["agent", "plan"]).optional().describe("Conversation mode."),
        thinking: s.string().optional().describe("Sets the model's `thinking` param (\"true\"/\"false\"); only for models that advertise it. Ignored otherwise."),
        cwd: s
          .string()
          .optional()
          .describe("Working directory (defaults to the session directory)."),
        additionalCwds: s
          .array(s.string())
          .optional()
          .describe("Extra workspace roots; combined with cwd into a multi-root agent workspace."),
        sandbox: s.boolean().optional().describe("Run the agent's tools in Cursor's sandbox."),
        agentId: s
          .string()
          .optional()
          .describe("Resume a specific Cursor agent id instead of starting fresh."),
      },
      execute: async (args, context) => {
        const apiKey = await deps.resolveApiKey();
        if (!apiKey) return NEEDS_AUTH;

        const approval = await requestApproval(context, "cursor_delegate", [args.model], {
          model: args.model,
          prompt: args.prompt,
        });
        if (!approval.ok) {
          return `Delegation to ${args.model} not approved${approval.reason ? `: ${approval.reason}` : "."}`;
        }

        let result;
        try {
          const baseCwd = args.cwd ?? context.directory ?? deps.defaultCwd();
          result = await runDelegate({
            apiKey,
            prompt: args.prompt,
            model: args.model,
            cwd: args.additionalCwds?.length ? [baseCwd, ...args.additionalCwds] : baseCwd,
            // Honour the user's project settings layer so delegated turns pick
            // up `.cursor/skills/` from the delegate's cwd. The delegate defaults
            // to ["project"] on its own, so this is only needed when the user
            // explicitly configured settingSources on the provider.
            settingSources: ["project"],
            ...(args.mode ? { mode: args.mode } : {}),
            ...(args.thinking ? { thinking: args.thinking } : {}),
            ...(args.sandbox !== undefined ? { sandbox: args.sandbox } : {}),
            ...(args.agentId ? { agentId: args.agentId } : {}),
            abortSignal: context.abort,
          });
        } catch (err) {
          return `Delegation failed: ${errorMessage(err)}`;
        }

        const toolNote =
          result.toolActivity.length > 0
            ? `\n\n(${result.toolActivity.length} tool call(s)` +
              `${result.toolActivity.some((t) => t.isError) ? ", some failed" : ""})`
            : "";

        // Surface the delegate's work in a child session so it's discoverable
        // in the TUI's subagent panel. Best-effort: a failed link never breaks
        // the turn. The result card itself stays a tool block (a custom tool
        // can't render a navigable `task` part), so the child session is
        // reached via the subagent panel, not by clicking the result.
        if (context.sessionID) {
          const transcript = [
            result.text || "(no text output)",
            ...(result.reasoning ? [`\n> ${result.reasoning}`] : []),
            ...(result.toolActivity.length > 0
              ? [`\n(${result.toolActivity.length} tool call(s))`]
              : []),
          ].join("\n");
          await linkDelegateSession({
            parentSessionID: context.sessionID,
            title: `Cursor delegate (${args.model})`,
            prompt: args.prompt,
            transcript,
          });
        }

        return {
          title: `Cursor delegate (${args.model})`,
          output: (result.text || "(no text output)") + toolNote,
          metadata: {
            agentId: result.agentId,
            model: args.model,
            toolCalls: result.toolActivity.length,
            usage: result.usage ?? null,
          },
        };
      },
    }),
  };
}

/**
 * Shared base of the `cursor_refresh_models` description. v1 appends a note
 * pointing at `cursor_update_plugin`; v2 (which does not register that tool)
 * appends a note pointing at `opencode plugin update` instead.
 */
export const REFRESH_DESCRIPTION_BASE =
  "Refresh the live Cursor model catalog now (bypasses the cache) and report the available models. The catalog also auto-refreshes on every opencode startup; use this to pick up new models mid-session.";

/**
 * One `cursor_refresh_models` output line, with the model's advertised
 * params appended when it has any:
 * `- grok-4.6 — Grok 4.6 [effort=low|medium|high|xhigh, fast=false|true]`.
 * Models without parameters keep the plain `- id — name` line.
 */
function modelLine(m: Pick<ModelListItem, "id" | "displayName" | "parameters">): string {
  const params = m.parameters ?? [];
  if (params.length === 0) return `- ${m.id} — ${m.displayName}`;
  const joined = params
    .map((p) => `${p.id}=${(p.values ?? []).map((v) => v.value).join("|")}`)
    .join(", ");
  return `- ${m.id} — ${m.displayName} [${joined}]`;
}

/**
 * Build the maintenance tools shared by v1 and v2:
 *  - `cursor_refresh_models`: force-refresh the model catalog.
 *  - `cursor_update_plugin`: check for and perform a plugin update.
 *
 * `deps?.resolveApiKey` (v2 passes its stored-connection path) makes the
 * refresh authenticate with the resolved key; without it (v1) the refresh
 * stays keyless and discovery falls back to CURSOR_API_KEY / cached models,
 * as before. The update tool never touches the key or session state.
 */
export function buildMaintenanceTools(
  deps?: Pick<CursorToolDeps, "resolveApiKey">,
): Record<string, ToolDefinition> {
  return {
    cursor_refresh_models: {
      description: `${REFRESH_DESCRIPTION_BASE} Note: to update the plugin itself (not just the model list), use the cursor_update_plugin tool.`,
      args: {},
      execute: async () => {
        const apiKey = deps ? await deps.resolveApiKey() : undefined;
        const result = await discoverModels({ apiKey, forceRefresh: true });
        const lines = result.models.map(modelLine);
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
  };
}
