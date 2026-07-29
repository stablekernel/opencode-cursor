import type { OpencodeClient } from "@opencode-ai/sdk";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogBridge {
	client: OpencodeClient;
	/** Workspace directory forwarded on each log call. */
	directory?: string;
}

const BRIDGE_KEY = Symbol.for("@stablekernel/opencode-cursor:log-bridge");

type BridgeHolder = { [BRIDGE_KEY]?: LogBridge };

/** Publish the opencode client + directory for the provider to log through. */
export function setLogBridge(bridge: LogBridge): void {
	(globalThis as BridgeHolder)[BRIDGE_KEY] = bridge;
}

/** Drop the bridge (plugin dispose). */
export function clearLogBridge(): void {
	delete (globalThis as BridgeHolder)[BRIDGE_KEY];
}

/** Read the current bridge, or `undefined` when the plugin hasn't published one. */
export function getLogBridge(): LogBridge | undefined {
	return (globalThis as BridgeHolder)[BRIDGE_KEY];
}

const SERVICE = "opencode-cursor";

/**
 * Structured log emission for the provider layer, which has no direct access
 * to the opencode client. Routes through `client.app.log()` (see
 * `plugins.mdx`) when the plugin has published a bridge via
 * {@link setLogBridge}; otherwise falls back to `console.*` so the provider
 * still surfaces diagnostics when used standalone (tests, scripts, or the
 * provider package without the plugin).
 *
 * Best-effort: a failed `app.log` call (e.g. server unavailable) is swallowed
 * rather than thrown, matching every other fire-and-forget client call in
 * this plugin.
 */
export function pluginLog(
	level: LogLevel,
	message: string,
	extra?: Record<string, unknown>,
): void {
	const bridge = getLogBridge();
	if (bridge) {
		void bridge.client.app
			.log({
				body: {
					service: SERVICE,
					level,
					message,
					...(extra ? { extra } : {}),
				},
				...(bridge.directory ? { query: { directory: bridge.directory } } : {}),
			})
			.catch(() => {});
		return;
	}
	const line = extra
		? `[${SERVICE}] ${message} ${JSON.stringify(extra)}`
		: `[${SERVICE}] ${message}`;
	switch (level) {
		case "debug":
			console.debug(line);
			break;
		case "info":
			console.info(line);
			break;
		case "warn":
			console.warn(line);
			break;
		case "error":
			console.error(line);
			break;
	}
}
