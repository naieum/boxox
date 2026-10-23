export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f}fieldset,.request{border:1px solid #ddd;border-radius:8px;margin:1rem 0;padding:1rem}label{display:block;margin:.5rem 0}code{overflow-wrap:anywhere}button{font:inherit;padding:.65rem 1rem;margin:0 .5rem .5rem 0;cursor:pointer}button:disabled{cursor:wait}summary{cursor:pointer;padding:.75rem 0}li{margin:.75rem 0}#consent-error{color:#a00}a{color:#174ea6}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}

export interface ConsentView {
  client: { clientId: string; name: string; clientUri: string | null };
  redirectUri: string;
  permissions: readonly string[];
  addresses: { id: string; email: string }[];
  agents: { id: string; name: string }[];
  requested: { addressId: string; email: string; permissions: string[] }[] | null;
}

const permissionLabels: Record<string, string> = {
  read: "Read messages",
  send: "Send replies",
  send_new: "Send to new recipients",
  webhook: "Manage webhooks",
  classify: "Classify messages",
};

export function consentPage(v: ConsentView): string {
  const requested = v.requested;
  const agentChoices = v.agents
    .map((a) => `<label><input type="radio" name="agent" value="${esc(a.id)}"> Use agent “${esc(a.name)}”</label>`)
    .join("");
  const grants = requested
    ? `<section class="request" aria-labelledby="requested-access"><h2 id="requested-access">Requested access</h2><ul>${requested.map((g) =>
        `<li><strong>${esc(g.email)}</strong><br>${g.permissions.map((p) => esc(permissionLabels[p] ?? p)).join("; ")}${g.permissions.map((p) => `<input type="hidden" name="grant" value="${esc(g.addressId)}:${esc(p)}">`).join("")}</li>`,
      ).join("")}</ul></section>`
    : `<p>This app did not specify any mailboxes. Ask it to reconnect with the access it needs, or choose access below.</p>
<details><summary>Choose access manually</summary>
<fieldset><legend>Agent</legend><label><input type="radio" name="agent" value="" checked> A new agent named “${esc(v.client.name)}”</label>${agentChoices}</fieldset>
<fieldset id="new-agent-grants"><legend>Mailboxes for a new agent</legend>${v.addresses.map((a) =>
        `<p><strong>${esc(a.email)}</strong>${v.permissions.map((p) => `<label><input type="checkbox" name="grant" value="${esc(a.id)}:${esc(p)}"> ${esc(permissionLabels[p] ?? p)}</label>`).join("")}</p>`,
      ).join("") || "<p>No active addresses yet.</p>"}</fieldset></details>`;
  return page(
    `Connect “${v.client.name}” to your mail?`,
    `<p>${requested ? "Review the mailboxes and permissions this app requested." : "This app is asking for MCP access."} Access starts only after you approve.</p>
<form id="consent">${grants}
<p>You can revoke this connection later. After you decide, you'll return to <code>${esc(v.redirectUri)}</code>.</p>
<button type="submit" name="decision" value="approve">Approve${requested ? " requested access" : ""}</button>
<button type="submit" name="decision" value="deny">Deny</button>
<p id="consent-status" role="status" aria-live="polite"></p>
<p id="consent-error" role="alert"></p>
<a id="consent-return" hidden>Return to app</a>
</form><script src="/oauth/consent.js"></script>`,
  );
}

/** Same-origin script allowed by the owner's CSP. Disable repeat submissions before sending. */
export const CONSENT_SCRIPT = `(() => {
  const form = document.getElementById("consent");
  const status = document.getElementById("consent-status");
  const error = document.getElementById("consent-error");
  const buttons = form.querySelectorAll('button[type="submit"]');
  let pending = false;
  form.addEventListener("change", () => {
    const grants = document.getElementById("new-agent-grants");
    if (grants) grants.disabled = !!new FormData(form).get("agent");
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (pending) return;
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
    if (decision === "approve" && !agentId && !grants.length) {
      error.textContent = "No mailbox access selected. Ask the app for a specific request, or choose access manually.";
      return;
    }
    pending = true;
    buttons.forEach((b) => { b.disabled = true; });
    form.setAttribute("aria-busy", "true");
    error.textContent = "";
    status.textContent = decision === "approve" ? "Connecting…" : "Declining…";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(location.href, {
        method: "POST", signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json", "x-boxox-csrf": "1" },
        body: JSON.stringify({ decision, agentId, grants }),
      });
      const body = await res.json();
      if (!res.ok || !body.redirectTo) throw new Error((body.error && body.error.message) || "Could not connect. Try again.");
      status.textContent = decision === "approve" ? "Approved. Returning to the app…" : "Declined. Returning to the app…";
      const back = document.getElementById("consent-return");
      back.href = body.redirectTo;
      back.hidden = false;
      location.assign(body.redirectTo);
    } catch (err) {
      pending = false;
      status.textContent = "";
      error.textContent = err.name === "AbortError"
        ? "The connection timed out. Check the app before trying again."
        : (err.name === "TypeError" || err.name === "SyntaxError"
          ? "Could not connect. Check your connection and try again."
          : (err.message || "Could not connect. Try again."));
      buttons.forEach((b) => { b.disabled = false; });
    } finally {
      clearTimeout(timeout);
      form.removeAttribute("aria-busy");
    }
  });
})();
`;
