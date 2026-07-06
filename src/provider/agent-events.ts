import type { AgentModeOption, SDKUserMessage } from "@cursor/sdk";
import type { AgentLike, AgentRunLike } from "./agent-backend.js";

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
  | { type: "finish"; text?: string };

export interface StreamAgentTurnOptions {
  mode: AgentModeOption;
  abortSignal?: AbortSignal;
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

  const push = (event: CursorEvent) => {
    queue.push(event);
    wake?.();
    wake = undefined;
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
        if (update.usage) push({ type: "usage", usage: update.usage as CursorUsage });
        break;
    }
  };

  const runHolder: { run?: AgentRunLike } = {};
  const onAbort = () => {
    void Promise.resolve(runHolder.run?.cancel()).catch(() => {});
  };
  options.abortSignal?.addEventListener("abort", onAbort);

  const sendTurn = (): Promise<AgentRunLike> =>
    sendWithBusyRetry(agent, message, { mode: options.mode, onDelta }, debug);

  // Kick off the turn. Resolve text from run.wait() for models that don't emit
  // incremental text deltas.
  void sendTurn()
    .then(async (run) => {
      runHolder.run = run;
      const result = await run.wait();
      if (debug) {
        console.error(
          `[cursor:debug] updates=${JSON.stringify(counts)} status=${result.status} resultLen=${(result.result ?? "").length}`,
        );
      }
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
      failure = err;
      if (debug) console.error(`[cursor:debug] send failed: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      finished = true;
      wake?.();
      wake = undefined;
    });

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
    options.abortSignal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Send a message on an agent, retrying once with the SDK's documented recovery
 * path on `AgentBusyError`. A previous opencode/CLI crash (or a second instance
 * racing on the same agent store) can leave a persisted run wedged; the SDK then
 * rejects new sends with `AgentBusyError`. `local.force` expires the wedged run
 * instead of failing the turn. Shared by streaming and silent sends.
 */
async function sendWithBusyRetry(
  agent: AgentLike,
  message: SDKUserMessage,
  sendOptions: {
    mode: AgentModeOption;
    onDelta?: (args: { update: { type: string } & Record<string, any> }) => void;
  },
  debug: boolean,
): Promise<AgentRunLike> {
  try {
    return await agent.send(message, sendOptions);
  } catch (err) {
    if (err instanceof Error && err.name === "AgentBusyError") {
      if (debug) console.error("[cursor:debug] agent busy; retrying send with local.force");
      return agent.send(message, { ...sendOptions, local: { force: true } });
    }
    throw err;
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
 *  - Usage undercount: no onDelta means the `turn-ended` usage update is never
 *    observed, so opencode slightly undercounts tokens on multi-message turns.
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
): Promise<void> {
  // Already aborted: don't start a turn just to cancel it.
  if (options.abortSignal?.aborted) return;
  const debug = process.env.OPENCODE_CURSOR_DEBUG === "1";
  const runHolder: { run?: AgentRunLike } = {};
  const onAbort = () => {
    void Promise.resolve(runHolder.run?.cancel()).catch(() => {});
  };
  options.abortSignal?.addEventListener("abort", onAbort);
  try {
    const run = await sendWithBusyRetry(agent, message, { mode: options.mode }, debug);
    runHolder.run = run;
    // The signal may have fired while send() was in flight (before runHolder
    // was populated, so onAbort had nothing to cancel); cancel now.
    if (options.abortSignal?.aborted) void Promise.resolve(run.cancel()).catch(() => {});
    const result = await run.wait();
    if (result.status !== "finished") {
      // Our own abort cancelled the run mid-flight: expected, not a failure.
      // The caller's abort check stops the multi-send sequence and drops the
      // session record, so this partial turn is never counted as delivered.
      if (options.abortSignal?.aborted) return;
      // Anything else ("error", an external "cancelled", unknown states) means
      // the message was NOT delivered; treating it as success would leave the
      // session record claiming the agent saw a message it never received.
      throw new Error(
        `Cursor run ended with status "${result.status}"${result.result ? `: ${result.result}` : ""}`,
      );
    }
  } finally {
    options.abortSignal?.removeEventListener("abort", onAbort);
  }
}
