import type { Config } from "@opencode-ai/plugin";
import type { McpServerConfig } from "@cursor/sdk";

/** The value type of opencode's `config.mcp` map. */
type OpencodeMcp = NonNullable<Config["mcp"]>;
type OpencodeMcpEntry = OpencodeMcp[string];

/**
 * Live MCP server status, keyed by server name, as reported by opencode's
 * `client.mcp.status()`. Only the `status` field is consumed; `"connected"`
 * means the server is currently usable. Mirrors the SDK's `McpStatus` union
 * without importing it (keeps this module dependency-light).
 */
export type McpStatusMap = Record<string, { status?: string } | undefined>;

/** opencode runtime statuses that mean a server still needs OAuth to connect. */
const NEEDS_AUTH_STATUS = new Set(["needs_auth", "needs_client_registration"]);

/** The OAuth client registration on a remote entry, or undefined when none. */
function oauthConfig(
	entry: OpencodeMcpEntry,
): { clientId?: string; clientSecret?: string; scope?: string } | undefined {
	if (entry.type !== "remote") return undefined;
	// `oauth` is `McpOAuthConfig | false | undefined`; both false and undefined
	// are falsy, so a truthy value is the client-registration object.
	return entry.oauth ? entry.oauth : undefined;
}

/**
 * Map opencode's OAuth client registration to the Cursor SDK's `auth` block so
 * the Cursor agent can run its own OAuth flow. Returns undefined when there is
 * no `clientId` to share (e.g. RFC 7591 dynamic registration) — opencode's
 * access token itself never reaches `config.mcp`, so a bare URL would fail.
 */
function toCursorAuth(
	oauth:
		| { clientId?: string; clientSecret?: string; scope?: string }
		| undefined,
):
	| { CLIENT_ID: string; CLIENT_SECRET?: string; scopes?: string[] }
	| undefined {
	if (!oauth?.clientId) return undefined;
	const scopes = oauth.scope?.split(/\s+/).filter(Boolean);
	return {
		CLIENT_ID: oauth.clientId,
		...(oauth.clientSecret ? { CLIENT_SECRET: oauth.clientSecret } : {}),
		...(scopes && scopes.length > 0 ? { scopes } : {}),
	};
}

/**
 * Names of remote servers that require OAuth but cannot be forwarded to the
 * Cursor agent because no shareable client registration exists (dynamic
 * registration, or a `needs_auth` runtime status with no configured
 * `clientId`). The plugin surfaces these to the user instead of silently
 * forwarding a spec that would 401.
 */
export function findUnshareableOAuthServers(
	mcp: Config["mcp"],
	status?: McpStatusMap,
): string[] {
	const names: string[] = [];
	if (!mcp) return names;
	for (const [name, entry] of Object.entries(mcp) as Array<
		[string, OpencodeMcpEntry]
	>) {
		if (!entry || entry.type !== "remote") continue;
		if (!status && entry.enabled === false) continue;
		const s = status?.[name]?.status;
		if (status && s !== "connected" && !NEEDS_AUTH_STATUS.has(s ?? ""))
			continue;
		const oauth = oauthConfig(entry);
		const needsOAuth = Boolean(oauth) || NEEDS_AUTH_STATUS.has(s ?? "");
		if (needsOAuth && !toCursorAuth(oauth)) names.push(name);
	}
	return names;
}

/**
 * Translate opencode's configured MCP servers (`config.mcp`) into the Cursor
 * SDK's `McpServerConfig` shape so the same servers can be handed
 * to the Cursor agent via `Agent.create({ mcpServers })`.
 *
 * MCP servers are independent processes addressed by a launch spec, so opencode
 * and the Cursor agent can each connect to the same server. Disabled entries
 * (`enabled: false`) are skipped. The `timeout` field is dropped (no Cursor
 * equivalent). OAuth is mapped where possible: a remote server's `oauth` client
 * registration becomes Cursor's `auth` block so the agent runs its own OAuth
 * flow; servers needing OAuth with no shareable `clientId` are skipped (the
 * plugin reports them via {@link findUnshareableOAuthServers}).
 */
export function translateMcpServers(
	mcp: Config["mcp"],
	status?: McpStatusMap,
): Record<string, McpServerConfig> {
	const out: Record<string, McpServerConfig> = {};
	if (!mcp) return out;

	for (const [name, entry] of Object.entries(mcp) as Array<
		[string, OpencodeMcpEntry]
	>) {
		if (!entry) continue;

		// When a live status map is supplied (per-turn dynamic forwarding), it is
		// the source of truth: forward only servers opencode has currently
		// connected, so mid-session enable/disable propagates to the Cursor agent.
		// Without it (the startup config snapshot), fall back to the static
		// `enabled` flag.
		if (status) {
			if (status[name]?.status !== "connected") continue;
		} else if (entry.enabled === false) {
			continue;
		}

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
			const oauth = oauthConfig(entry);
			const auth = toCursorAuth(oauth);
			// OAuth server with no shareable client registration: opencode holds the
			// token and it never lands in config.mcp, so skip rather than forward a
			// bare URL that would 401. The plugin notifies the user (see
			// findUnshareableOAuthServers).
			if (oauth && !auth) continue;
			out[name] = {
				type: "http",
				url: entry.url,
				...(entry.headers && Object.keys(entry.headers).length > 0
					? { headers: entry.headers }
					: {}),
				...(auth ? { auth } : {}),
			};
		}
	}

	return out;
}
