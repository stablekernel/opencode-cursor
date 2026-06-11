import type { Config } from "@opencode-ai/plugin";
import type { McpServerConfig } from "@cursor/sdk";

/** The value type of opencode's `config.mcp` map. */
type OpencodeMcp = NonNullable<Config["mcp"]>;
type OpencodeMcpEntry = OpencodeMcp[string];

/**
 * Translate opencode's configured MCP servers (`config.mcp`) into the Cursor
 * SDK's `McpServerConfig` shape so the same servers can be handed
 * to the Cursor agent via `Agent.create({ mcpServers })`.
 *
 * MCP servers are independent processes addressed by a launch spec, so opencode
 * and the Cursor agent can each connect to the same server. Disabled entries
 * (`enabled: false`) are skipped. opencode-only fields with no Cursor
 * equivalent (timeout, oauth) are dropped.
 */
export function translateMcpServers(
	mcp: Config["mcp"],
): Record<string, McpServerConfig> {
	const out: Record<string, McpServerConfig> = {};
	if (!mcp) return out;

	for (const [name, entry] of Object.entries(mcp) as Array<
		[string, OpencodeMcpEntry]
	>) {
		if (!entry || entry.enabled === false) continue;

		if (entry.type === "local") {
			const [command, ...args] = entry.command ?? [];
			if (!command) continue;
			out[name] = {
				type: "stdio",
				command,
				...(args.length > 0 ? { args } : {}),
				...(entry.environment && Object.keys(entry.environment).length > 0
					? { env: entry.environment }
					: {}),
			};
		} else if (entry.type === "remote") {
			if (!entry.url) continue;
			out[name] = {
				type: "http",
				url: entry.url,
				...(entry.headers && Object.keys(entry.headers).length > 0
					? { headers: entry.headers }
					: {}),
			};
		}
	}

	return out;
}
