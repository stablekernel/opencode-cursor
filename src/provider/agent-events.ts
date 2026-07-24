import type { AgentModeOption, SDKUserMessage } from "@cursor/sdk";
import type { AgentLike, AgentRunLike, AgentSendOptions } from "./agent-backend.js";
import { classifyError } from "./error-classify.js";

/** Token usage as reported by Cursor's `turn-ended` update. */
export interface CursorUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Normalized events bridged from the Cursor SDK's push callbacks. */
export type CursorEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "tool-result"; id: string; name: string; result: unknown; isError: boolean }
  | { type: "usage"; usage: CursorUsage }
  | { type: "reasoning-complete"; durationMs?: number }
  | { type: "compaction" }
  | { type: "finish"; text?: string };

export interface StreamAgentTurnOptions {
  mode: AgentModeOption;
  abortSignal?: AbortSignal;
  /** Dedupe key forwarded to every (re)send of this turn. */
  idempotencyKey?: string;
  /**
   * Usage accumulated by preceding silent replay turns. When set, yielded
   * `usage` events carry `usageBase + turn-ended` sums so the visible turn's
   * reported usage includes everything spent replaying earlier messages.
   */
  usageBase?: CursorUsage;
}

/** Sum two usage reports (either may be absent). */
export function addUsage(a?: CursorUsage, b?: CursorUsage): CursorUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/**
 * Human-readable name for a Cursor tool call. Most Cursor tools carry their
 * name in `toolCall.type` (shell/read/edit/…), but an MCP tool call has
 * `type: "mcp"` with the real tool in `args.toolName` (and server in
 * `args.providerIdentifier`) — surface that instead of the literal "mcp".
 */
function toolDisplayName(toolCall: ({ type?: string } & Record<string, any>) | undefined): string {
  if (!toolCall) return "tool";
  if (toolCall.type === "mcp") {
    const name = toolCall.args?.toolName;
    const server = toolCall.args?.providerIdentifier;
    if (name) return server ? `${server}/${name}` : String(name);
    return "mcp";
  }
  return toolCall.type ?? "tool";
}

/**
 * Stream a single turn on an already-acquired Cursor agent and yield normalized
 * events. The agent's lifecycle (create/resume/close) is owned by the caller
 * (see session-pool.ts) so it can be reused across turns. The SDK streams via
 * `onDelta` callbacks; we bridge those into a pull-based async generator so both
 * `doStream` and `doGenerate` can consume them.
 */
export async function* streamAgentTurn(
  agent: AgentLike,
  message: SDKUserMessage,
  options: StreamAgentTurnOptions,
): AsyncGenerator<CursorEvent> {
  const queue: CursorEvent[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  let failure: unknown;

  // Opt-in stderr tracing of what the live agent emits (set OPENCODE_CURSOR_DEBUG=1).
  const debug = process.env.OPENCODE_CURSOR_DEBUG === "1";
  const counts: Record<string, number> = {};

  // Stall watchdog: if no event arrives within stallMs, cancel the wedged run
  // and force-resend once (pre-first-event only). `0` disables.
  const stallMs = Number(process.env.OPENCODE_CURSOR_STALL_MS ?? 60_000);
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let forced = false;
  let anyEvent = false;

  const push = (event: CursorEvent) => {
    anyEvent = true;
    queue.push(event);
    wake?.();
    wake = undefined;
    armWatchdog();
  };

  const armWatchdog = () => {
    if (stallMs <= 0 || finished) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      void onStall();
    }, stallMs);
    stallTimer.unref?.();
  };

  const onDelta = ({ update }: { update: { type: string } & Record<string, any> }) => {
    if (debug) counts[update.type] = (counts[update.type] ?? 0) + 1;
    switch (update.type) {
      case "text-delta":
        push({ type: "text-delta", text: update.text });
        break;
      case "thinking-delta":
        push({ type: "reasoning-delta", text: update.text });
        break;
      case "thinking-completed":
        push({ type: "reasoning-complete", durationMs: update.thinkingDurationMs as number | undefined });
        break;
      case "summary-started":
      case "summary":
      case "summary-completed":
        push({ type: "compaction" });
        break;
      case "tool-call-started":
        push({
          type: "tool-call",
          id: String(update.callId),
          name: toolDisplayName(update.toolCall),
          input: update.toolCall?.args ?? {},
        });
        break;
      case "tool-call-completed": {
        const tool = update.toolCall ?? {};
        const result = tool.result;
        // MCP failures often arrive as {status:"success", value:{isError:true}}
        // (the MCP-protocol error flag), not as a top-level status error.
        const mcpError = tool.type === "mcp" && result?.value?.isError === true;
        push({
          type: "tool-result",
          id: String(update.callId),
          name: toolDisplayName(tool),
          result: result ?? null,
          isError: result?.status === "error" || mcpError,
        });
        break;
      }
      case "turn-ended":
        if (update.usage) {
          const summed = addUsage(options.usageBase, update.usage as CursorUsage);
          if (summed) push({ type: "usage", usage: summed });
        }
        break;
    }
  };

  const runHolder: { run?: AgentRunLike } = {};
  const onAbort = () => {
    // Clear the stall timer so an armed watchdog can't fire a force-resend of
    // an aborted turn (abort during the pre-first-event wait would otherwise
    // still trip onStall).
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = undefined;
    void Promise.resolve(runHolder.run?.cancel()).catch(() => {});
  };
  options.abortSignal?.addEventListener("abort", onAbort);

  // Kick off the turn. Resolve text from run.wait() for models that don't emit
  // incremental text deltas. `runGen` disambiguates run invocations: when the
  // watchdog cancels a wedged run and starts a fresh one, the stale run's
  // completion handlers must NOT finish the stream (a new run is in flight).
  let runGen = 0;
  const startRun = (force: boolean): void => {
    const gen = ++runGen;
    void sendWithRecovery(
      agent,
      message,
      {
        mode: options.mode,
        onDelta,
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        ...(force ? { local: { force: true } } : {}),
      },
      debug,
    )
      .then(async (run) => {
        runHolder.run = run;
        const result = await run.wait();
        if (debug) {
          console.error(
            `[cursor:debug] updates=${JSON.stringify(counts)} status=${result.status} resultLen=${(result.result ?? "").length}`,
          );
        }
        // Superseded by a watchdog force-resend: this run is abandoned.
        if (gen !== runGen || finished) return;
        if (result.status === "error") {
          // Surface the failure instead of finishing silently — a silent stop
          // leaves opencode showing dangling tool calls with no explanation.
          throw new Error(
            `Cursor run ended with status "error"${result.result ? `: ${result.result}` : ""}`,
          );
        }
        // A cancelled run finishes without fabricating final text.
        push({ type: "finish", ...(result.status === "cancelled" ? {} : { text: result.result }) });
      })
      .catch((err) => {
        if (gen !== runGen) return;
        failure = err;
        if (debug) console.error(`[cursor:debug] send failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        // Only the live run finishes the stream; a superseded (cancelled-for-
        // resend) run leaves `finished` untouched so the resend can complete.
        if (gen !== runGen) return;
        finished = true;
        if (stallTimer) clearTimeout(stallTimer);
        wake?.();
        wake = undefined;
      });
  };

  const onStall = async (): Promise<void> => {
    if (finished) return;
    // The turn was aborted: don't resend or surface a spurious stall error.
    if (options.abortSignal?.aborted) return;
    const failTerminal = async (message: string): Promise<void> => {
      // Cancel the wedged server run (best-effort) so it isn't orphaned in a
      // RUNNING state, then surface the stall as a terminal failure.
      try {
        await runHolder.run?.cancel();
      } catch {
        /* best effort */
      }
      failure = new Error(message);
      finished = true;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = undefined;
      wake?.();
      wake = undefined;
    };
    if (anyEvent) {
      // A stall AFTER partial output is terminal: force-resending would
      // re-emit the already-yielded prefix. Cancel the wedged run and surface
      // the stall instead.
      await failTerminal(`Cursor run stalled (no events for ${stallMs}ms)`);
      return;
    }
    if (forced) {
      await failTerminal(`Cursor run stalled twice (no events for ${stallMs}ms)`);
      return;
    }
    forced = true;
    if (debug) console.error("[cursor:debug] stream stalled; cancelling and resending with local.force");
    try {
      await runHolder.run?.cancel();
    } catch {
      /* best effort */
    }
    armWatchdog();
    startRun(true);
  };

  armWatchdog();
  startRun(false);

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (finished) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    // Drain anything queued right before completion.
    while (queue.length > 0) yield queue.shift()!;
    if (failure) throw failure;
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    options.abortSignal?.removeEventListener("abort", onAbort);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bounded backoff for retryable send failures (ms per attempt). */
const RETRY_BACKOFF_MS = [500, 1500] as const;

/**
 * Send a message on an agent with typed recovery (see error-classify.ts):
 *  - agent-busy: a previous crash left a persisted run wedged — resend once
 *    with `local.force` to expire it (SDK-documented recovery).
 *  - rate-limit / network: bounded exponential backoff on the SAME agent; the
 *    shared idempotencyKey makes the resend a server-side dedupe, not a dup.
 *  - everything else: rethrow (auth/config fail fast upstream; unknown is
 *    handled by the caller's fresh-replay path).
 */
export async function sendWithRecovery(
  agent: AgentLike,
  message: SDKUserMessage,
  sendOptions: AgentSendOptions,
  debug: boolean,
): Promise<AgentRunLike> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await agent.send(message, sendOptions);
    } catch (err) {
      const classified = classifyError(err);
      if (classified.kind === "agent-busy") {
        if (debug) console.error("[cursor:debug] agent busy; retrying send with local.force");
        return agent.send(message, { ...sendOptions, local: { force: true } });
      }
      if (
        (classified.kind === "rate-limit" || classified.kind === "network") &&
        attempt < RETRY_BACKOFF_MS.length
      ) {
        if (debug)
          console.error(
            `[cursor:debug] ${classified.kind}; retrying send in ${RETRY_BACKOFF_MS[attempt]}ms`,
          );
        await sleep(RETRY_BACKOFF_MS[attempt]!);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Send a single turn on an already-acquired agent WITHOUT streaming anything
 * back. Used to replay the leading messages of a multi-message interjection
 * (two-or-more user messages queued while the agent was busy): messages
 * `1..N-1` are sent silently and awaited, and only the final message streams
 * via {@link streamAgentTurn}. This mirrors opencode's own model, where
 * interjected messages fold into a single visible turn.
 *
 * Honors `options.abortSignal`: an abort cancels the in-flight run so the
 * caller can stop before sending the next queued message.
 *
 * Known trade-offs of silent turns being FULL agent runs:
 *  - Tool invisibility: the agent may execute tools (shell, edits, MCP) during
 *    a silent turn with zero streamed output or tool display — the user sees
 *    nothing until the final message streams. Accepted because interjections
 *    are typically short course-corrections, and opencode itself folds
 *    interjected messages into one visible turn.
 *  - Serial latency: each silent turn is awaited to completion before the next
 *    send, so an N-message interjection costs N sequential agent runs.
 *
 * Concatenating the queued messages into one Cursor message was rejected for
 * message fidelity: each interjection must land as a distinct user turn in the
 * agent's conversation memory (mirroring opencode's transcript), so the model
 * sees the same message boundaries the user created and later fingerprint
 * classification stays aligned turn-for-turn.
 */
export async function sendAgentTurnSilently(
  agent: AgentLike,
  message: SDKUserMessage,
  options: StreamAgentTurnOptions,
): Promise<CursorUsage | undefined> {
  // Already aborted: don't start a turn just to cancel it.
  if (options.abortSignal?.aborted) return undefined;
  const debug = process.env.OPENCODE_CURSOR_DEBUG === "1";
  const runHolder: { run?: AgentRunLike } = {};
  // Capture only the turn-ended usage; a silent turn streams nothing else.
  let usage: CursorUsage | undefined;
  const onDelta = ({ update }: { update: { type: string } & Record<string, any> }) => {
    if (update.type === "turn-ended" && update.usage) usage = update.usage as CursorUsage;
  };
  const onAbort = () => {
    void Promise.resolve(runHolder.run?.cancel()).catch(() => {});
  };
  options.abortSignal?.addEventListener("abort", onAbort);
  try {
    const run = await sendWithRecovery(
      agent,
      message,
      { mode: options.mode, onDelta, ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) },
      debug,
    );
    runHolder.run = run;
    // The signal may have fired while send() was in flight (before runHolder
    // was populated, so onAbort had nothing to cancel); cancel now.
    if (options.abortSignal?.aborted) void Promise.resolve(run.cancel()).catch(() => {});
    const result = await run.wait();
    if (result.status !== "finished") {
      // Our own abort cancelled the run mid-flight: expected, not a failure.
      // The caller's abort check stops the multi-send sequence and drops the
      // session record, so this partial turn is never counted as delivered.
      if (options.abortSignal?.aborted) return undefined;
      // Anything else ("error", an external "cancelled", unknown states) means
      // the message was NOT delivered; treating it as success would leave the
      // session record claiming the agent saw a message it never received.
      throw new Error(
        `Cursor run ended with status "${result.status}"${result.result ? `: ${result.result}` : ""}`,
      );
    }
    return usage;
  } finally {
    options.abortSignal?.removeEventListener("abort", onAbort);
  }
}
