import type {
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import type { CursorEvent, CursorUsage } from "./agent-events.js";

/**
 * How Cursor's internal tool activity (shell/read/edit/mcp/…) is surfaced to
 * opencode:
 *  - `"reasoning"` (default): rendered as compact reasoning lines. Robust on
 *    every host — no tool-call parts cross the execution boundary.
 *  - `"blocks"`: emitted as provider-executed AI-SDK `tool-call`/`tool-result`
 *    parts so opencode renders structured tool blocks. The parts must carry
 *    BOTH `providerExecuted: true` AND `dynamic: true` — ai's `parseToolCall`
 *    (v6, `doParseToolCall`) only exempts that combination from registered-tool
 *    validation; without `dynamic` an unknown name raises `NoSuchToolError`,
 *    which opencode's `experimental_repairToolCall` rewrites into its "invalid"
 *    tool. Names are also prefixed (`cursor_…`) so they can never collide with
 *    a tool opencode has registered (`read`, `grep`, `task`, …) — a colliding
 *    name is validated against that tool's input schema instead of being
 *    treated as dynamic.
 */
export type ToolDisplay = "reasoning" | "blocks";

const FINISH_STOP: LanguageModelV3FinishReason = { unified: "stop", raw: undefined };
const FINISH_ERROR: LanguageModelV3FinishReason = { unified: "error", raw: undefined };

function safeJsonString(input: unknown): string {
  try {
    return typeof input === "string" ? input : JSON.stringify(input ?? {});
  } catch {
    return "{}";
  }
}

/**
 * Tool name as it crosses into opencode in "blocks" mode. Prefixed so it can
 * never collide with a tool opencode has registered, and sanitized because MCP
 * names contain `/` (e.g. `serena/find_symbol` → `cursor_serena_find_symbol`).
 */
function blockToolName(name: string): string {
  return `cursor_${name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/**
 * Build a provider-executed dynamic `tool-call` stream part (V3). `input` is a
 * stringified JSON object per the spec.
 */
function toolCallPart(id: string, name: string, input: unknown): LanguageModelV3StreamPart {
  return {
    type: "tool-call",
    toolCallId: id,
    toolName: blockToolName(name),
    input: safeJsonString(input),
    providerExecuted: true,
    dynamic: true,
  } as LanguageModelV3StreamPart;
}

/**
 * Build a provider-executed dynamic `tool-result` stream part. Per the V3 spec
 * (and ai v6's `runToolsTransformation`, which reads `chunk.result` /
 * `chunk.isError`) the payload goes in `result`; `result` is typed
 * `NonNullable<JSONValue>` so a missing Cursor result is coalesced to `null`
 * and cast.
 */
function toolResultPart(
  id: string,
  name: string,
  result: unknown,
  isError: boolean,
): LanguageModelV3StreamPart {
  return {
    type: "tool-result",
    toolCallId: id,
    toolName: blockToolName(name),
    result: (result ?? null) as never,
    isError,
    providerExecuted: true,
    dynamic: true,
  } as LanguageModelV3StreamPart;
}

/** Content-item equivalents of the tool parts above, for `doGenerate`. */
function toolCallContent(id: string, name: string, input: unknown): LanguageModelV3Content {
  return {
    type: "tool-call",
    toolCallId: id,
    toolName: blockToolName(name),
    input: safeJsonString(input),
    providerExecuted: true,
    dynamic: true,
  } as LanguageModelV3Content;
}
function toolResultContent(
  id: string,
  name: string,
  result: unknown,
  isError: boolean,
): LanguageModelV3Content {
  return {
    type: "tool-result",
    toolCallId: id,
    toolName: blockToolName(name),
    result: (result ?? null) as never,
    isError,
    providerExecuted: true,
    dynamic: true,
  } as LanguageModelV3Content;
}

export const EMPTY_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

export function mapUsage(usage: CursorUsage): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: usage.inputTokens,
      noCache: undefined,
      cacheRead: usage.cacheReadTokens,
      cacheWrite: usage.cacheWriteTokens,
    },
    outputTokens: { total: usage.outputTokens, text: undefined, reasoning: undefined },
  };
}

/**
 * Render Cursor's internal tool activity as a short, human-readable line.
 *
 * Cursor runs its own agent loop and executes its own tools (shell/read/edit/
 * mcp/…). We surface that activity as reasoning text — NOT as AI-SDK
 * `tool-call`/`tool-result` parts. opencode (a V3-native host) only treats
 * registered tools as callable; a provider-executed call naming a tool it
 * doesn't know (e.g. `mcp`, `shell`) is rejected as an "unavailable tool".
 * Rendering as reasoning keeps the activity visible without crossing the
 * tool-execution boundary. Tool outputs can be huge (file contents, search
 * dumps), so only the call (name + short arg summary) and error status are
 * shown — never the raw result.
 */
function formatToolCall(name: string, input: unknown): string {
  let arg = "";
  try {
    const s = typeof input === "string" ? input : JSON.stringify(input);
    if (s && s !== "{}" && s !== '""') arg = ` ${s.length > 120 ? `${s.slice(0, 120)}…` : s}`;
  } catch {
    // Non-serializable input; show the name only.
  }
  return `[tool] ${name}${arg}`;
}

/**
 * Synthetic error payload for a tool call whose completion never arrived
 * (run errored/cancelled/wedged mid-tool). Mirrors Cursor's own
 * `{status:"error"}` result union so consumers see a consistent shape.
 * Without a matching result, opencode renders the part as
 * "Tool execution aborted" and the block dangles forever.
 */
const DANGLING_TOOL_RESULT = {
  status: "error",
  error: "Cursor run ended before this tool call completed.",
};

/**
 * Translate the normalized Cursor agent events into an AI-SDK V3 stream.
 *
 * Pure with respect to the event source, so it can be tested by feeding a
 * fixed event sequence (no live agent required). Reasoning blocks are closed
 * before text begins so reasoning/text parts nest cleanly. Tool activity is
 * rendered into the reasoning channel (see {@link formatToolCall}).
 */
export function cursorEventsToStream(
  events: AsyncIterable<CursorEvent>,
  toolDisplay: ToolDisplay = "reasoning",
): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    async start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });

      let textId: string | undefined;
      let reasoningId: string | undefined;
      let reasoningCount = 0;
      let usage: LanguageModelV3Usage | undefined;
      let streamedText = false;
      // Open (unanswered) tool calls in blocks mode: id -> original tool name.
      const openToolCalls = new Map<string, string>();
      const closeDanglingToolCalls = () => {
        for (const [id, name] of openToolCalls) {
          controller.enqueue(toolResultPart(id, name, DANGLING_TOOL_RESULT, true));
        }
        openToolCalls.clear();
      };

      const closeReasoning = () => {
        if (reasoningId) {
          controller.enqueue({ type: "reasoning-end", id: reasoningId });
          reasoningId = undefined;
        }
      };
      const ensureText = () => {
        closeReasoning();
        if (!textId) {
          textId = "text-0";
          controller.enqueue({ type: "text-start", id: textId });
        }
        return textId;
      };
      const ensureReasoning = () => {
        if (!reasoningId) {
          reasoningId = `reasoning-${reasoningCount++}`;
          controller.enqueue({ type: "reasoning-start", id: reasoningId });
        }
        return reasoningId;
      };
      const reasoningLine = (text: string) => {
        controller.enqueue({ type: "reasoning-delta", id: ensureReasoning(), delta: text });
      };

      try {
        for await (const event of events) {
          switch (event.type) {
            case "text-delta":
              streamedText = true;
              controller.enqueue({ type: "text-delta", id: ensureText(), delta: event.text });
              break;
            case "reasoning-delta":
              reasoningLine(event.text);
              break;
            case "tool-call":
              if (toolDisplay === "blocks") {
                openToolCalls.set(event.id, event.name);
                controller.enqueue(toolCallPart(event.id, event.name, event.input));
              } else {
                reasoningLine(`\n${formatToolCall(event.name, event.input)}\n`);
              }
              break;
            case "tool-result":
              if (toolDisplay === "blocks") {
                openToolCalls.delete(event.id);
                controller.enqueue(
                  toolResultPart(event.id, event.name, event.result, event.isError),
                );
              } else if (event.isError) {
                reasoningLine(`[tool] ${event.name} failed\n`);
              }
              break;
            case "usage":
              usage = mapUsage(event.usage);
              break;
            case "finish":
              if (!streamedText && event.text) {
                controller.enqueue({ type: "text-delta", id: ensureText(), delta: event.text });
              }
              break;
          }
        }

        closeDanglingToolCalls();
        closeReasoning();
        if (textId) controller.enqueue({ type: "text-end", id: textId });
        controller.enqueue({ type: "finish", usage: usage ?? EMPTY_USAGE, finishReason: FINISH_STOP });
        controller.close();
      } catch (err) {
        controller.enqueue({ type: "error", error: err });
        closeDanglingToolCalls();
        closeReasoning();
        if (textId) controller.enqueue({ type: "text-end", id: textId });
        controller.enqueue({ type: "finish", usage: usage ?? EMPTY_USAGE, finishReason: FINISH_ERROR });
        controller.close();
      }
    },
  });
}

/**
 * Aggregate the normalized Cursor agent events into a non-streaming result for
 * `doGenerate`. Same event source contract as {@link cursorEventsToStream}.
 * Tool activity is folded into the reasoning text (display only).
 */
export async function cursorEventsToContent(
  events: AsyncIterable<CursorEvent>,
  toolDisplay: ToolDisplay = "reasoning",
): Promise<{
  content: Array<LanguageModelV3Content>;
  finishReason: LanguageModelV3FinishReason;
  usage: LanguageModelV3Usage;
}> {
  const content: Array<LanguageModelV3Content> = [];
  const toolParts: Array<LanguageModelV3Content> = [];
  // Open (unanswered) tool calls in blocks mode: id -> original tool name.
  const openToolCalls = new Map<string, string>();
  let text = "";
  let reasoning = "";
  let usage: LanguageModelV3Usage = EMPTY_USAGE;
  let finishReason: LanguageModelV3FinishReason = FINISH_STOP;

  try {
    for await (const event of events) {
      switch (event.type) {
        case "text-delta":
          text += event.text;
          break;
        case "reasoning-delta":
          reasoning += event.text;
          break;
        case "tool-call":
          if (toolDisplay === "blocks") {
            openToolCalls.set(event.id, event.name);
            toolParts.push(toolCallContent(event.id, event.name, event.input));
          } else {
            reasoning += `\n${formatToolCall(event.name, event.input)}\n`;
          }
          break;
        case "tool-result":
          if (toolDisplay === "blocks") {
            openToolCalls.delete(event.id);
            toolParts.push(toolResultContent(event.id, event.name, event.result, event.isError));
          } else if (event.isError) {
            reasoning += `[tool] ${event.name} failed\n`;
          }
          break;
        case "usage":
          usage = mapUsage(event.usage);
          break;
        case "finish":
          if (!text && event.text) text = event.text;
          break;
      }
    }
  } catch {
    finishReason = FINISH_ERROR;
  }

  // Close out any tool call whose completion never arrived (see DANGLING_TOOL_RESULT).
  for (const [id, name] of openToolCalls) {
    toolParts.push(toolResultContent(id, name, DANGLING_TOOL_RESULT, true));
  }
  openToolCalls.clear();

  if (reasoning) content.push({ type: "reasoning", text: reasoning });
  content.push(...toolParts);
  if (text) content.push({ type: "text", text });

  return { content, finishReason, usage };
}
