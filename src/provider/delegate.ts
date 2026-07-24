import type { AgentModeOption } from "@cursor/sdk";
import type { CursorUsage } from "./agent-events.js";
import { streamAgentTurn } from "./agent-events.js";
import { resolveControls } from "./controls.js";
import { acquireAgent } from "./session-pool.js";

export interface DelegateParams {
	apiKey: string;
	/** The subtask to delegate to the Cursor agent. */
	prompt: string;
	/** Cursor model id to run the delegation on. */
	model: string;
	/** Conversation mode; defaults to "agent". */
	mode?: AgentModeOption;
	/** Convenience for the Cursor `thinking` model param (e.g. "high"). */
	thinking?: string;
	/** Working directory the local agent operates in. */
	cwd: string;
	/** Run the agent's tools inside Cursor's sandbox. */
	sandbox?: boolean;
	/** Resume a specific Cursor agent by id instead of creating a fresh one. */
	agentId?: string;
	/** Cancels the run when aborted (wired to the tool's abort signal). */
	abortSignal?: AbortSignal;
}

export interface DelegateToolActivity {
	name: string;
	isError: boolean;
}

export interface DelegateResult {
	agentId: string;
	text: string;
	reasoning: string;
	toolActivity: DelegateToolActivity[];
	usage?: CursorUsage;
}

/**
 * Run a single delegated turn on a fresh (or explicitly resumed) local Cursor
 * agent and aggregate the outcome into a plain result. This backs the opt-in
 * `cursor_delegate` tool, which gives users a permission-gated boundary around
 * Cursor (the provider path runs Cursor's own loop without per-call gating).
 *
 * Reuses the provider's `acquireAgent` + `streamAgentTurn` plumbing; the turn
 * is consumed eagerly here because a tool returns a single result rather than a
 * live stream.
 */
export async function runDelegate(
	params: DelegateParams,
): Promise<DelegateResult> {
	const { mode, modelSelection } = resolveControls(
		params.model,
		{
			mode: params.mode ?? "agent",
			...(params.thinking ? { params: { thinking: params.thinking } } : {}),
		},
		undefined,
	);

	const acquired = await acquireAgent({
		apiKey: params.apiKey,
		modelSelection,
		mode,
		cwd: params.cwd,
		...(params.sandbox !== undefined ? { sandbox: params.sandbox } : {}),
		...(params.agentId ? { resumeAgentId: params.agentId } : {}),
	});

	const text: string[] = [];
	const reasoning: string[] = [];
	const toolActivity: DelegateToolActivity[] = [];
	let usage: CursorUsage | undefined;

	try {
		for await (const event of streamAgentTurn(
			acquired.agent,
			{ text: params.prompt },
			{
				mode,
				...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
			},
		)) {
			switch (event.type) {
				case "text-delta":
					text.push(event.text);
					break;
				case "reasoning-delta":
					reasoning.push(event.text);
					break;
				case "tool-call":
					toolActivity.push({ name: event.name, isError: false });
					break;
				case "tool-result":
					if (event.isError)
						toolActivity.push({ name: event.name, isError: true });
					break;
				case "usage":
					usage = event.usage;
					break;
				case "reasoning-complete":
				case "compaction":
					break;
				case "finish":
					// The aggregated result text; prefer it when deltas were absent.
					if (event.text && text.length === 0) text.push(event.text);
					break;
			}
		}
	} finally {
		acquired.release();
	}

	return {
		agentId: acquired.agent.agentId,
		text: text.join(""),
		reasoning: reasoning.join(""),
		toolActivity,
		...(usage ? { usage } : {}),
	};
}
