import type { AgentModeOption, ConversationStep, InteractionUpdate } from "@cursor/sdk";
import { loadCursorSdk } from "../cursor-runtime.js";
import { buildModelSelection } from "./controls.js";

/**
 * A target repository for a cloud agent. Cursor's cloud runtime accepts an
 * array of repos; the tool surface exposes the common single-repo case.
 */
export interface CloudRepoTarget {
  url: string;
  startingRef?: string;
}

export interface CloudAgentParams {
  apiKey: string;
  /** The instruction/task for the background agent. */
  prompt: string;
  /** Target repository URL (e.g. https://github.com/owner/repo). */
  repoUrl: string;
  /** Branch/ref to start from. Defaults to the repo's default branch. */
  startingRef?: string;
  /** Cursor model id. Optional for cloud (server picks a default otherwise). */
  model?: string;
  /** Conversation mode; defaults to "agent". */
  mode?: AgentModeOption;
  /** Convenience for the Cursor `thinking` model param (e.g. "high"). */
  thinking?: string;
  /** When true, open a PR automatically once the agent finishes. */
  autoCreatePR?: boolean;
  /** Operate on the current branch instead of creating a new one. */
  workOnCurrentBranch?: boolean;
  /** Cancels the run when aborted (wired to the tool's abort signal). */
  abortSignal?: AbortSignal;
}

export interface CloudAgentBranch {
  repoUrl: string;
  branch?: string;
  prUrl?: string;
}

export interface CloudAgentResult {
  agentId: string;
  /** Terminal run status: "finished" | "error" | "cancelled". */
  status: string;
  /** The agent's final textual result, when present. */
  result?: string;
  /** First PR url found across result branches (when `autoCreatePR`). */
  prUrl?: string;
  /** Per-repo branch/PR info reported by the run. */
  branches: CloudAgentBranch[];
  durationMs?: number;
  /** Human-readable progress lines captured from status/step/summary updates. */
  progress: string[];
}

/**
 * Run a Cursor background ("cloud") agent against a remote repository and wait
 * for it to finish, returning the final status, result text, and any PR url.
 *
 * A cloud agent can run for minutes and produce a PR rather than a chat reply,
 * which maps poorly onto the synchronous provider `doStream` path — so this is
 * exposed as an opencode tool instead (see plugin/index.ts). Progress is
 * collected into `progress[]` (opencode custom tools return a single result
 * rather than a live stream) and the lifecycle is bridged through the same
 * `loadCursorSdk` plumbing the provider uses.
 */
export async function runCloudAgent(params: CloudAgentParams): Promise<CloudAgentResult> {
  const { Agent } = await loadCursorSdk();
  const modelSelection = params.model
    ? buildModelSelection(params.model, params.thinking ? { thinking: params.thinking } : undefined)
    : undefined;
  const mode: AgentModeOption = params.mode ?? "agent";

  const createOptions = {
    apiKey: params.apiKey,
    ...(modelSelection ? { model: modelSelection } : {}),
    mode,
    cloud: {
      repos: [
        {
          url: params.repoUrl,
          ...(params.startingRef ? { startingRef: params.startingRef } : {}),
        },
      ],
      ...(params.autoCreatePR !== undefined ? { autoCreatePR: params.autoCreatePR } : {}),
      ...(params.workOnCurrentBranch !== undefined
        ? { workOnCurrentBranch: params.workOnCurrentBranch }
        : {}),
    },
  };

  const progress: string[] = [];
  const agent = await Agent.create(createOptions);

  // `onDelta` carries fine-grained updates; for a cloud (background) run the
  // higher-signal progress arrives via `onStep` (whole conversation steps) and
  // `run.onDidChangeStatus`. We capture all three — whichever the runtime emits.
  const onDelta = ({ update }: { update: InteractionUpdate }) => {
    if (update.type === "summary") progress.push(`summary: ${update.summary}`);
  };

  const onStep = ({ step }: { step: ConversationStep }) => {
    progress.push(`step: ${describeStep(step)}`);
  };

  try {
    const run = await agent.send(params.prompt, { mode, onDelta, onStep });

    const off = run.onDidChangeStatus?.((status: string) => {
      progress.push(`status: ${status}`);
    });
    const onAbort = () => {
      run.cancel().catch(() => {});
    };
    params.abortSignal?.addEventListener("abort", onAbort);

    try {
      const result = await run.wait();
      const branches: CloudAgentBranch[] = (result.git?.branches ?? []).map((b) => ({
        repoUrl: b.repoUrl,
        ...(b.branch ? { branch: b.branch } : {}),
        ...(b.prUrl ? { prUrl: b.prUrl } : {}),
      }));
      const prUrl = branches.find((b) => b.prUrl)?.prUrl;
      return {
        agentId: agent.agentId,
        status: result.status,
        ...(result.result !== undefined ? { result: result.result } : {}),
        ...(prUrl ? { prUrl } : {}),
        branches,
        ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
        progress,
      };
    } finally {
      off?.();
      params.abortSignal?.removeEventListener("abort", onAbort);
    }
  } finally {
    try {
      agent.close();
    } catch {
      // best effort; cloud agents persist server-side regardless.
    }
  }
}

/** A short, log-friendly description of a conversation step for progress output. */
function describeStep(step: ConversationStep): string {
  if (step.type === "toolCall") return `toolCall:${step.message.type}`;
  return step.type;
}
