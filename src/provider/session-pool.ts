import type {
	AgentDefinition,
	AgentModeOption,
	McpServerConfig,
	ModelSelection,
	SettingSource,
} from "@cursor/sdk";
import { loadAgentBackend, type AgentLike } from "./agent-backend.js";
import {
	deleteSessionStore,
	loadSessionRecords,
	saveSessionRecords,
	type StoredSessionRecord,
} from "./session-store.js";
import type { TranscriptRecord } from "./transcript-fingerprint.js";

/** sessionID -> fingerprint record, so a session reuses one Cursor agent across turns. */
const pool = new Map<string, StoredSessionRecord>();

/**
 * Lazily merge disk-persisted records into the in-memory pool (memory wins),
 * so `session: "auto"` resumes a session's Cursor agent even after an opencode
 * restart. The agent's conversation itself lives in Cursor's checkpoint store;
 * this only restores our agentId + fingerprint bookkeeping.
 */
let hydrated = false;
function hydrate(): void {
	if (hydrated) return;
	hydrated = true;
	for (const [key, record] of loadSessionRecords()) {
		if (!pool.has(key)) pool.set(key, record);
	}
}

/** Read the fingerprint record pooled for a session (undefined if none). */
export function getSessionRecord(
	sessionID: string,
): TranscriptRecord | undefined {
	hydrate();
	return pool.get(sessionID);
}

/**
 * Drop a session's pooled record so the NEXT turn classifies as "new" (fresh
 * agent + full transcript replay). Called when a multi-message replay fails or
 * aborts mid-sequence: the record was written optimistically with the full new
 * fingerprint before delivery, so leaving it in place would let a later
 * "continuation" resume on top of messages the agent never received.
 */
export function dropSessionRecord(sessionID: string): void {
	hydrate();
	if (pool.delete(sessionID)) saveSessionRecords(pool);
}

/** Test/diagnostic helpers. */
export function getPooledAgentId(sessionID: string): string | undefined {
	hydrate();
	return pool.get(sessionID)?.agentId;
}
export function clearAgentPool(): void {
	pool.clear();
	hydrated = true; // don't re-hydrate stale disk state into a cleared pool
	deleteSessionStore();
}
/** Test hook: drop in-memory state only, as if the process restarted. */
export function resetSessionPoolMemory(): void {
	pool.clear();
	hydrated = false;
}

export interface AcquireAgentParams {
	apiKey: string;
	modelSelection: ModelSelection;
	mode: AgentModeOption;
	cwd: string;
	settingSources?: SettingSource[];
	sandbox?: boolean;
	autoReview?: boolean;
	mcpServers?: Record<string, McpServerConfig>;
	agents?: Record<string, AgentDefinition>;
	name?: string;
	/**
	 * Resume this Cursor agent before falling back to a fresh create. Set for a
	 * fingerprinted "continuation" (the pooled agentId) or an explicit
	 * `providerOptions.cursor.agentId`. A failed resume degrades to create.
	 */
	resumeAgentId?: string;
	/**
	 * Pool the resulting agent under this opencode session id. When set, the
	 * agent persists across turns (release() does not close it) and `record` is
	 * stored for the next turn's classification. When undefined, no pooling and
	 * the agent is closed on release.
	 */
	poolKey?: string;
	/** Fingerprint of the current prompt, stored when `poolKey` is set. */
	record?: { systemHash: string; userHashes: string[]; mcpHash?: string };
}

export interface AcquiredAgent {
	agent: AgentLike;
	/** True when an existing agent was resumed (send only the new turn). */
	resumed: boolean;
	/** Close the agent unless it's pooled (pooled agents persist for the next turn). */
	release: () => void;
}

/**
 * Get an agent to run a turn. Attempts a resume of `resumeAgentId` when given,
 * otherwise creates a fresh agent; a failed resume degrades to a fresh create
 * (so a stale/expired pool entry becomes a correct full-transcript turn rather
 * than an error). When `poolKey` is set, the resulting agent + `record` are
 * pooled for the session and survive `release()`.
 */
export async function acquireAgent(
	params: AcquireAgentParams,
): Promise<AcquiredAgent> {
	const backend = loadAgentBackend();

	const createOptions = {
		apiKey: params.apiKey,
		model: params.modelSelection,
		mode: params.mode,
		local: {
			cwd: params.cwd,
			...(params.settingSources
				? { settingSources: params.settingSources }
				: {}),
			...(params.sandbox !== undefined
				? { sandboxOptions: { enabled: params.sandbox } }
				: {}),
			...(params.autoReview !== undefined
				? { autoReview: params.autoReview }
				: {}),
		},
		...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
		...(params.agents ? { agents: params.agents } : {}),
		...(params.name ? { name: params.name } : {}),
	};

	let agent: AgentLike | undefined;
	let resumed = false;
	if (params.resumeAgentId) {
		try {
			agent = await backend.resumeAgent(params.resumeAgentId, createOptions);
			resumed = true;
		} catch {
			// Stale/expired id: fall through to a fresh create (full replay).
		}
	}
	if (!agent) {
		agent = await backend.createAgent(createOptions);
	}

	const pooling = params.poolKey !== undefined;
	if (pooling && params.record) {
		hydrate();
		pool.set(params.poolKey!, {
			agentId: agent.agentId,
			systemHash: params.record.systemHash,
			userHashes: params.record.userHashes,
			...(params.record.mcpHash !== undefined
				? { mcpHash: params.record.mcpHash }
				: {}),
			updatedAt: Date.now(),
		});
		// Persist so session reuse survives opencode restarts (best-effort).
		saveSessionRecords(pool);
	}

	const release = () => {
		if (!pooling) {
			try {
				agent!.close();
			} catch {
				// best effort
			}
		}
	};

	return { agent, resumed, release };
}
