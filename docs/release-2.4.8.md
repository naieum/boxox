# Box Ox 2.4.8

Released October 23, 2026.

This release makes MCP consent a review of the access requested for a task. Approval shows progress and recoverable errors. There is no database migration or new secret. SDK 0.2.0, CLI 0.2.0, and email skill 0.4.1 keep their published bytes.

## Request access before consent

MCP clients can request each mailbox permission through OAuth scopes such as `boxox:read:hello@example.com`. The consent screen lists those mailboxes and permissions, with Approve and Deny controls. It does not show unrelated mailbox or permission choices. Box Ox checks the requested grants again before saving them and rejects added permissions, other mailboxes, or a broader existing agent.

Agree on mailbox addresses and permissions before starting authorization. For a server configured as `boxox` in Codex:

```sh
codex mcp login boxox --scopes 'boxox:read:hello@example.com,boxox:read:ian@example.com'
```

Add `boxox:send:<email>` when replies are needed. `send_new` also permits new recipients. Do not request sending, webhook, or classification access for a reading task. Check the actual grants with `list_addresses` after connecting.

Clients that omit mailbox scopes get a collapsed manual setup option. Nothing is preselected. Existing connections continue to use their approved grants; this upgrade does not add access to mailboxes.

## Approval feedback and retries

The page shows Connecting while approval is pending and disables repeated submissions. Server failures, connection failures, and timeouts display an error. Successful approval shows a return link while navigating back to the app.

Repeating an approval with the same mailbox grants reuses the approved agent. It does not replace the agent or revoke its existing tokens. Changed grants still require a new approval.

## Upgrade and verification

Upgrade the existing installation with its current account, URL, owner, and plan. No new permission or reconnection is needed for existing connections. Use the scoped login flow for a new connection or a changed access request.

OAuth-to-MCP regression tests cover exact requested grants, denied consent, unknown requests, forged grants, compatibility with clients without scopes, and repeated approvals. The consent screen was checked in a local browser for progress, success navigation, server errors, empty selection, and network errors. The 30-second timeout is source-inspected, rather than a timed browser test.

This release does not claim a fresh-account installation, new mail-delivery certification, populated-mail recovery, or throughput verification. It is unsigned. Published SHA-256 checksums establish download consistency, not independent publisher identity.
