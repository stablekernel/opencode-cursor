import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin";
import { runCloudAgent } from "../provider/cloud-agent.js";
import { runDelegate } from "../provider/delegate.js";

const s = tool.schema;

export interface CursorToolDeps {
  /**
   * Resolve the Cursor API key (from opencode auth, captured by the plugin's
   * auth loader, or the CURSOR_API_KEY env var). Returns undefined when no key
   * is available so the tool can return a clear "needs auth" message.
   */
  resolveApiKey: () => string | undefined;
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
        thinking: s.string().optional().describe("Thinking level, e.g. 'high'."),
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
        const apiKey = deps.resolveApiKey();
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
        thinking: s.string().optional().describe("Thinking level, e.g. 'high'."),
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
        const apiKey = deps.resolveApiKey();
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
