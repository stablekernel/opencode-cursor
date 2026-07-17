import {
  tool,
  type PluginInput,
  type ToolContext,
  type ToolDefinition,
} from "@opencode-ai/plugin";
import { runCloudAgent } from "../provider/cloud-agent.js";
import { PROVIDER_ID } from "./model-v2.js";

const s = tool.schema;

export interface CursorToolDeps {
  /** opencode client used to create and prompt parent-linked child sessions. */
  client: PluginInput["client"];
  /**
   * Resolve the Cursor API key (from opencode auth, captured by the plugin's
   * auth loader, or the CURSOR_API_KEY env var). Returns undefined when no key
   * is available so the tool can return a clear "needs auth" message.
   */
  resolveApiKey: () => string | undefined;
  /** Default working directory for local delegation (the session worktree/cwd). */
  defaultCwd: () => string;
  /** Register Cursor controls for the next provider turn in a child session. */
  setDelegateControls: (sessionID: string, controls: CursorDelegateControls) => void;
  /** Remove controls after the child provider turn settles. */
  clearDelegateControls: (sessionID: string) => void;
}

export interface CursorDelegateControls {
  mode: "agent" | "plan";
  cwd: string;
  thinking?: string;
  sandbox?: boolean;
  agentId?: string;
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

function delegateTitle(prompt: string): string {
  const preview = prompt.replace(/\s+/g, " ").trim().slice(0, 80);
  return `Cursor delegate: ${preview || "task"}`;
}

/**
 * Await a promise but reject early if `signal` aborts. When abort wins the
 * race, a value that arrives afterward is routed to `onLateValue` so the caller
 * can dispose of a resource (e.g. abort a child session that was created after
 * we already gave up waiting).
 */
function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onLateValue?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Delegation aborted"));
    };

    if (signal.aborted) {
      // Already aborted: reject now, but still consume the in-flight promise so
      // a resource it produces is disposed and its rejection stays handled.
      void promise.then(
        (value) => onLateValue?.(value),
        () => {},
      );
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        if (settled) {
          onLateValue?.(value);
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
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
        "Delegate a single subtask to a local Cursor agent and return its result. Runs in a " +
        "parent-linked opencode child session, so Cursor's live tool activity is visible and " +
        "navigable in the subagent UI and the session remains available afterward. Use to hand " +
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

        const directory = args.cwd ?? context.directory ?? deps.defaultCwd();
        let childSessionID: string | undefined;
        const onAbort = () => {
          if (!childSessionID) return;
          void Promise.resolve(
            deps.client.session.abort({
              path: { id: childSessionID },
              query: { directory },
            }),
          ).catch(() => {});
        };
        context.abort.addEventListener("abort", onAbort);

        try {
          if (context.abort.aborted) throw new Error("Delegation aborted");

          const creating = deps.client.session.create({
            body: {
              parentID: context.sessionID,
              title: delegateTitle(args.prompt),
            },
            query: { directory },
          });
          // If abort wins the race, the child may still be created after we
          // reject. It was never prompted, so there is nothing to abort — delete
          // it so no empty orphan session lingers in the parent's session tree.
          const created = await awaitWithAbort(creating, context.abort, (late) => {
            if (!late.data?.id) return;
            void Promise.resolve(
              deps.client.session.delete({
                path: { id: late.data.id },
                query: { directory },
              }),
            ).catch(() => {});
          });
          if (!created.data) {
            throw new Error(`Could not create child session: ${errorMessage(created.error)}`);
          }
          childSessionID = created.data.id;
          deps.setDelegateControls(childSessionID, {
            mode: args.mode ?? "agent",
            cwd: directory,
            ...(args.thinking ? { thinking: args.thinking } : {}),
            ...(args.sandbox !== undefined ? { sandbox: args.sandbox } : {}),
            ...(args.agentId ? { agentId: args.agentId } : {}),
          });

          const prompting = deps.client.session.prompt({
            path: { id: childSessionID },
            query: { directory },
            body: {
              model: { providerID: PROVIDER_ID, modelID: args.model },
              ...(args.mode === "plan" ? { agent: "plan" } : {}),
              tools: { cursor_delegate: false },
              parts: [{ type: "text", text: args.prompt }],
            },
          });
          const prompted = await awaitWithAbort(prompting, context.abort);
          if (!prompted.data) {
            throw new Error(`Child session failed: ${errorMessage(prompted.error)}`);
          }

          const text = prompted.data.parts.reduce(
            (output, part) => (part.type === "text" ? output + part.text : output),
            "",
          );

          return {
            title: `Cursor delegate (${args.model})`,
            output: text || "(no text output)",
            metadata: {
              childSessionID,
              model: args.model,
              status: "finished",
              usage: prompted.data.info.tokens ?? null,
            },
          };
        } catch (err) {
          return `Delegation failed: ${errorMessage(err)}`;
        } finally {
          context.abort.removeEventListener("abort", onAbort);
          if (childSessionID) deps.clearDelegateControls(childSessionID);
        }
      },
    }),
  };
}
