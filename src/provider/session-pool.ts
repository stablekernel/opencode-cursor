import type {
  AgentDefinition,
  AgentModeOption,
  McpServerConfig,
  ModelSelection,
  SettingSource,
} from "@cursor/sdk";
import { loadAgentBackend, type AgentLike } from "./agent-backend.js";

/** sessionID -> Cursor agentId, so a session reuses one Cursor agent across turns. */
const pool = new Map<string, string>();

/** Test/diagnostic helpers. */
export function getPooledAgentId(sessionID: string): string | undefined {
  return pool.get(sessionID);
}
export function clearAgentPool(): void {
  pool.clear();
}

export interface AcquireAgentParams {
  apiKey: string;
  modelSelection: ModelSelection;
  mode: AgentModeOption;
  cwd: string;
  settingSources?: SettingSource[];
  sandbox?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  agents?: Record<string, AgentDefinition>;
  name?: string;
  /** opencode session id; required for pooling. */
  sessionID?: string;
  /** When true (and sessionID present) reuse/resume one agent per session. */
  session: boolean;
  /**
   * Resume a specific Cursor agent by id. Takes precedence over session
   * pooling; lets power users continue an explicit agent (e.g. one returned by
   * a prior tool call) rather than the session's auto-managed one.
   */
  agentId?: string;
}

export interface AcquiredAgent {
  agent: AgentLike;
  /** True when an existing pooled agent was resumed (send only the new turn). */
  resumed: boolean;
  /** Close the agent unless it's pooled (pooled agents persist for the next turn). */
  release: () => void;
}

/**
 * Get an agent to run a turn: resume the session's pooled agent when possible,
 * otherwise create a fresh one. Resume failures fall back to creation, so a
 * stale/expired pool entry degrades to a correct fresh turn rather than an error.
 */
export async function acquireAgent(params: AcquireAgentParams): Promise<AcquiredAgent> {
  const backend = loadAgentBackend();

  const createOptions = {
    apiKey: params.apiKey,
    model: params.modelSelection,
    mode: params.mode,
    local: {
      cwd: params.cwd,
      ...(params.settingSources ? { settingSources: params.settingSources } : {}),
      ...(params.sandbox !== undefined ? { sandboxOptions: { enabled: params.sandbox } } : {}),
    },
    ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
    ...(params.agents ? { agents: params.agents } : {}),
    ...(params.name ? { name: params.name } : {}),
  };

  const pooling = params.session && Boolean(params.sessionID);
  const pooledId = pooling ? pool.get(params.sessionID!) : undefined;
  // An explicit agentId wins over the session's pooled agent.
  const resumeId = params.agentId ?? pooledId;

  let agent: AgentLike | undefined;
  let resumed = false;
  if (resumeId) {
    try {
      agent = await backend.resumeAgent(resumeId, createOptions);
      resumed = true;
    } catch {
      // A stale/expired id degrades to a fresh agent; drop a matching pool entry.
      if (pooledId && resumeId === pooledId) pool.delete(params.sessionID!);
    }
  }
  if (!agent) {
    agent = await backend.createAgent(createOptions);
  }

  if (pooling) pool.set(params.sessionID!, agent.agentId);

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
