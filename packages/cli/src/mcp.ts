import { normalizeUrl } from "./credentials.js";

const PERMISSIONS = ["read", "send", "send_new", "webhook", "classify"] as const;
type Permission = (typeof PERMISSIONS)[number];

/** Prepare a request for an MCP client's OAuth flow; this does not connect or grant access. */
export function mcpRequest(input: { url: string; mailboxes?: string[]; permissions?: string[]; grants?: string[]; serverName?: string }) {
  const origin = normalizeUrl(input.url);
  const serverName = input.serverName ?? "boxox";
  if (!/^[A-Za-z0-9_-]+$/.test(serverName)) throw new Error("--server-name must contain only letters, digits, underscores, or hyphens");
  if (input.grants?.length && (input.mailboxes?.length || input.permissions?.length)) {
    throw new Error("Use --grant for individual permissions, or --mailbox with --perm; do not mix them");
  }
  const requested = new Map<string, { email: string; permissions: Permission[] }>();
  const add = (rawEmail: string, rawPermission: string) => {
    // Exclude whitespace and separators used by OAuth scope tokens and client scope lists.
    const email = rawEmail.toLowerCase();
    if (email.length > 254 || !/^[^\s@,:"\\]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(email)) {
      throw new Error("Mailbox must be an email address without spaces, commas, colons, quotes, or backslashes");
    }
    const permission = PERMISSIONS.find((p) => p === rawPermission);
    if (!permission) throw new Error(`Unknown mailbox permission: ${rawPermission}. Use ${PERMISSIONS.join(", ")}`);
    const grant = requested.get(email) ?? { email, permissions: [] };
    if (!grant.permissions.includes(permission)) grant.permissions.push(permission);
    requested.set(email, grant);
  };
  if (input.grants?.length) {
    for (const grant of input.grants) {
      const colon = grant.indexOf(":");
      if (colon < 1) throw new Error("--grant must be PERMISSION:EMAIL, for example read:hello@example.com");
      add(grant.slice(colon + 1), grant.slice(0, colon));
    }
  } else {
    if (!input.mailboxes?.length) throw new Error("Specify --mailbox EMAIL or --grant PERMISSION:EMAIL before starting authorization");
    for (const email of input.mailboxes) for (const permission of input.permissions ?? ["read"]) add(email, permission);
  }
  if (requested.size > 200) throw new Error("Request at most 200 mailboxes");
  const mailboxes = [...requested.values()];
  const scopes = mailboxes.flatMap((g) => g.permissions.map((p) => `boxox:${p}:${g.email}`));
  const endpoint = `${origin}/mcp`;
  return {
    status: "request_prepared", minimumAppVersion: "2.4.8", approvalRequired: true,
    server: { name: serverName, url: endpoint }, mailboxes, scopes,
    oauth: { resource: endpoint, scope: scopes.join(" ") },
    codex: {
      configuredServerRequired: true, command: "codex",
      args: ["mcp", "login", serverName, "--scopes", scopes.join(",")],
    },
    next: "Configure this server in your MCP client, then request these OAuth scopes. Review consent and verify list_addresses after approval.",
  };
}
