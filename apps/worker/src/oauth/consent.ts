import { and, eq, inArray } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AuthRequest, ClientInfo, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { addressGrants, addresses, agents, domains, mcpClients } from "@boxox/db";
import { GRANT_PERMISSIONS } from "@boxox/shared";
import { writeAudit } from "../audit";
import { batch } from "../db";
import type { McpProps } from "../mcp/auth";
import type { AppContext } from "../middleware";
import { SETUP_ORG_ID } from "../routes/setup";
import { generateClientId } from "../services/agent-auth";
import { oauthApi, publicOrigin } from "./provider";

/**
 * /oauth/authorize: the consent page. It stays behind Access, and only the
 * owner can approve. Approving binds the client to an agent principal (an
 * existing one, or a new one with the grants chosen here); the token's props
 * carry that agent, so MCP sees exactly the agent's grants.
 *
 * On top of the provider's own checks this refuses any request without S256
 * PKCE, and any redirect_uri that is not byte-for-byte one the client
 * registered (the provider lets loopback URIs vary their port).
 */

const decisionSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  agentId: z.string().min(1).optional(),
  grants: z
    .array(z.object({ addressId: z.string().min(1), permissions: z.array(z.enum(GRANT_PERMISSIONS)).min(1) }))
    .max(200)
    .default([]),
});

class ConsentError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function isOwner(c: Context<AppContext>): boolean {
  const role = c.get("user")?.role;
  return role === "owner" || role === "admin";
}

interface ParsedConsent {
  api: OAuthHelpers;
  authRequest: AuthRequest;
  client: ClientInfo;
}

async function parseConsent(c: Context<AppContext>): Promise<ParsedConsent> {
  const api = oauthApi(c.env, publicOrigin(c.env, c.req.raw));
  let authRequest: AuthRequest;
  try {
    authRequest = await api.parseAuthRequest(c.req.raw);
  } catch (err) {
    const description = (err as { description?: string }).description ?? "Invalid authorization request";
    throw new ConsentError(400, "invalid_request", description);
  }
  if (!authRequest.codeChallenge || authRequest.codeChallengeMethod !== "S256") {
    throw new ConsentError(400, "invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  const client = await api.lookupClient(authRequest.clientId);
  if (!client) throw new ConsentError(400, "invalid_request", "Invalid client_id");
  if (!client.redirectUris.includes(authRequest.redirectUri)) {
    throw new ConsentError(400, "invalid_request", "redirect_uri must exactly match a registered redirect URI");
  }
  const row = (
    await c.get("db").select().from(mcpClients).where(eq(mcpClients.clientId, client.clientId)).limit(1)
  )[0];
  if (row?.revokedAt) throw new ConsentError(403, "client_revoked", "This client was revoked; register it again");
  return { api, authRequest, client };
}

function clientName(client: ClientInfo): string {
  return (client.clientName?.trim() || client.clientId).slice(0, 100);
}

async function consentOptions(c: Context<AppContext>) {
  const db = c.get("db");
  const [addressRows, agentRows] = await Promise.all([
    db
      .select({ id: addresses.id, localPart: addresses.localPart, domain: domains.name })
      .from(addresses)
      .innerJoin(domains, eq(addresses.domainId, domains.id))
      .where(and(eq(addresses.organizationId, SETUP_ORG_ID), eq(addresses.status, "active"))),
    db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.organizationId, SETUP_ORG_ID), eq(agents.status, "active"))),
  ]);
  return {
    addresses: addressRows.map((a) => ({ id: a.id, email: `${a.localPart}@${a.domain}` })),
    agents: agentRows,
  };
}

function fail(c: Context<AppContext>, err: unknown) {
  if (!(err instanceof ConsentError)) throw err;
  if (wantsJson(c)) return c.json({ error: { code: err.code, message: err.message } }, err.status);
  return c.html(page("Can't connect this app", `<p>${esc(err.message)}</p>`), err.status);
}

function wantsJson(c: Context<AppContext>): boolean {
  return (c.req.header("accept") ?? "").includes("application/json");
}

const ownerOnly = () => new ConsentError(403, "forbidden", "Only the owner can approve MCP clients");

export const consentRoutes = new Hono<AppContext>()
  .get("/consent.js", (c) =>
    c.body(CONSENT_SCRIPT, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }),
  )

  .get("/authorize", async (c) => {
    try {
      if (!isOwner(c)) throw ownerOnly();
      const { authRequest, client } = await parseConsent(c);
      const options = await consentOptions(c);
      const consent = {
        client: { clientId: client.clientId, name: clientName(client), clientUri: client.clientUri ?? null },
        redirectUri: authRequest.redirectUri,
        scope: authRequest.scope,
        permissions: GRANT_PERMISSIONS,
        ...options,
      };
      if (wantsJson(c)) return c.json(consent);
      return c.html(consentPage(consent), 200, { "cache-control": "no-store" });
    } catch (err) {
      return fail(c, err);
    }
  })

  .post("/authorize", async (c) => {
    try {
      if (!isOwner(c)) throw ownerOnly();
      const parsed = decisionSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new ConsentError(400, "bad_request", parsed.error.issues[0]?.message ?? "Invalid decision");
      }
      const { api, authRequest, client } = await parseConsent(c);
      const db = c.get("db");
      const user = c.get("user");
      const name = clientName(client);

      if (parsed.data.decision === "deny") {
        await writeAudit(db, {
          organizationId: SETUP_ORG_ID,
          actorType: "user",
          actorId: user.email,
          action: "mcp_client.denied",
          targetType: "mcp_client",
          targetId: client.clientId,
        });
        const to = new URL(authRequest.redirectUri);
        to.searchParams.set("error", "access_denied");
        if (authRequest.state) to.searchParams.set("state", authRequest.state);
        return c.json({ redirectTo: to.toString() });
      }

      let agentId = parsed.data.agentId;
      if (agentId) {
        const existing = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.organizationId, SETUP_ORG_ID), eq(agents.status, "active")))
          .limit(1);
        if (!existing[0]) throw new ConsentError(404, "not_found", "No such agent");
      } else {
        const wanted = parsed.data.grants;
        const ids = [...new Set(wanted.map((g) => g.addressId))];
        const found = ids.length
          ? await db
              .select({ id: addresses.id })
              .from(addresses)
              .where(and(eq(addresses.organizationId, SETUP_ORG_ID), inArray(addresses.id, ids)))
          : [];
        if (found.length !== ids.length) throw new ConsentError(400, "bad_request", "Unknown address in grants");
        agentId = crypto.randomUUID();
        const newAgentId = agentId;
        await batch(db, [
          db.insert(agents).values({
            id: newAgentId,
            organizationId: SETUP_ORG_ID,
            name,
            description: `MCP client ${client.clientId}`,
            clientId: generateClientId(),
            createdBy: user.email,
          }),
          ...ids.map((addressId) =>
            db.insert(addressGrants).values({
              id: crypto.randomUUID(),
              addressId,
              organizationId: SETUP_ORG_ID,
              principalType: "agent",
              principalId: newAgentId,
              permissions: [...new Set(wanted.filter((g) => g.addressId === addressId).flatMap((g) => g.permissions))],
              createdBy: user.email,
            }),
          ),
        ]);
      }

      const now = new Date();
      await db
        .insert(mcpClients)
        .values({
          clientId: client.clientId,
          agentId,
          name,
          redirectUris: client.redirectUris,
          approvedAt: now,
          approvedBy: user.email,
        })
        .onConflictDoUpdate({
          target: mcpClients.clientId,
          set: { agentId, name, redirectUris: client.redirectUris, approvedAt: now, approvedBy: user.email },
        });

      const props: McpProps = { agentId, organizationId: SETUP_ORG_ID, clientId: client.clientId };
      const { redirectTo } = await api.completeAuthorization({
        request: authRequest,
        userId: agentId,
        scope: authRequest.scope,
        metadata: { clientName: name, approvedBy: user.email },
        props,
      });
      await writeAudit(db, {
        organizationId: SETUP_ORG_ID,
        actorType: "user",
        actorId: user.email,
        action: "mcp_client.approved",
        targetType: "mcp_client",
        targetId: client.clientId,
        metadata: { agentId, newAgent: !parsed.data.agentId },
      });
      return c.json({ redirectTo });
    } catch (err) {
      return fail(c, err);
    }
  });

// ---------- page ----------

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f}fieldset{border:1px solid #ddd;border-radius:8px;margin:1rem 0}label{display:block}code{word-break:break-all}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}

interface ConsentView {
  client: { clientId: string; name: string; clientUri: string | null };
  redirectUri: string;
  permissions: readonly string[];
  addresses: { id: string; email: string }[];
  agents: { id: string; name: string }[];
}

function consentPage(v: ConsentView): string {
  const agentChoices = v.agents
    .map((a) => `<label><input type="radio" name="agent" value="${esc(a.id)}"> Use agent “${esc(a.name)}”</label>`)
    .join("");
  const grants = v.addresses
    .map(
      (a) =>
        `<p><strong>${esc(a.email)}</strong><br>${v.permissions
          .map(
            (p) =>
              `<label style="display:inline;margin-right:1rem"><input type="checkbox" name="grant" value="${esc(a.id)}:${esc(p)}"> ${esc(p)}</label>`,
          )
          .join("")}</p>`,
    )
    .join("");
  return page(
    `Connect “${v.client.name}” to your mail?`,
    `<p>This app is asking for MCP access. It will act as an agent with only the mailboxes and permissions you pick.</p>
<p>After you decide you'll be sent to <code>${esc(v.redirectUri)}</code>.</p>
<form id="consent">
<fieldset><legend>Agent</legend>
<label><input type="radio" name="agent" value="" checked> A new agent named “${esc(v.client.name)}”</label>${agentChoices}
</fieldset>
<fieldset><legend>Mailboxes for a new agent</legend>${grants || "<p>No active addresses yet.</p>"}
<p><small><code>send</code> is replies only; <code>send_new</code> allows new recipients.</small></p></fieldset>
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
<p id="consent-error" role="alert"></p>
</form>
<script src="/oauth/consent.js"></script>`,
  );
}

/** Served from /oauth/consent.js: the CSP allows only same-origin scripts. */
const CONSENT_SCRIPT = `(() => {
  const form = document.getElementById("consent");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const decision = e.submitter && e.submitter.value === "deny" ? "deny" : "approve";
    const data = new FormData(form);
    const agentId = data.get("agent") || undefined;
    const byAddress = {};
    for (const v of data.getAll("grant")) {
      const i = String(v).lastIndexOf(":");
      const id = String(v).slice(0, i);
      (byAddress[id] = byAddress[id] || []).push(String(v).slice(i + 1));
    }
    const grants = Object.entries(byAddress).map(([addressId, permissions]) => ({ addressId, permissions }));
    const res = await fetch(location.href, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-boxox-csrf": "1" },
      body: JSON.stringify({ decision, agentId, grants }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.redirectTo) return location.assign(body.redirectTo);
    document.getElementById("consent-error").textContent = (body.error && body.error.message) || "Something went wrong";
  });
})();
`;
