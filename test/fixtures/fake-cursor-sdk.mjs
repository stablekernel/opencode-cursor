/**
 * Fake @cursor/sdk used by sidecar tests. The sidecar child loads this module
 * (via OPENCODE_CURSOR_SDK_PATH) instead of the real SDK so client<->child
 * behavior can be verified end-to-end without network or credentials.
 *
 * Message-text driven behaviors:
 *   "busy"  -> send() rejects with AgentBusyError unless local.force is set
 *   "hang"  -> run.wait() never resolves (until cancel(), which resolves cancelled)
 *   other   -> emits one text-delta "echo:<text>" update, wait() -> done:<text>
 */

function makeAgent(agentId, options) {
  return {
    agentId,
    model: options?.model,
    send: async (message, sendOptions) => {
      const text = typeof message?.text === "string" ? message.text : "";
      if (text === "busy" && !sendOptions?.local?.force) {
        const err = new Error("agent is busy");
        err.name = "AgentBusyError";
        throw err;
      }
      sendOptions?.onDelta?.({ update: { type: "text-delta", text: `echo:${text}` } });
      if (text === "hang") {
        let resolveWait;
        const waited = new Promise((resolve) => {
          resolveWait = resolve;
        });
        return {
          wait: () => waited,
          cancel: () => {
            resolveWait({ status: "cancelled" });
          },
        };
      }
      return {
        wait: async () => ({ status: "finished", result: `done:${text}` }),
        cancel: () => {},
      };
    },
    close: () => {},
  };
}

export const Agent = {
  create: async (options) => makeAgent("agent-created", options),
  resume: async (agentId, options) => {
    if (agentId === "missing") {
      const err = new Error(`agent ${agentId} not found`);
      err.name = "AgentNotFoundError";
      throw err;
    }
    return makeAgent(agentId, options);
  },
};
