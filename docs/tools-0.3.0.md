# CLI 0.3.0 and email skill 0.5.0

Released October 23, 2026. These tools use the requested-mailbox consent flow in Box Ox 2.4.8 and newer. The app release stays at 2.4.8. SDK 0.2.0 keeps its published bytes.

## Prepare access before login

CLI 0.3.0 adds `boxox mcp request`:

```sh
boxox mcp request --url https://mail.example.com --mailbox hello@example.com --mailbox ian@example.com --perm read
```

The JSON result contains the exact mailbox permissions, OAuth scopes, MCP endpoint, and Codex login arguments. Configure the endpoint in your MCP client before using those arguments. The planner does not connect, grant access, read credentials, or write configuration.

Each `--perm` applies to every listed `--mailbox`; reading is the default. Use individual grants when only one mailbox needs replies:

```sh
boxox mcp request --url https://mail.example.com --grant read:hello@example.com --grant send:hello@example.com --grant read:ian@example.com
```

The forms cannot be mixed. Unknown permissions and ambiguous or invalid requests fail before authorization. `--server-name NAME` selects another configured MCP server name.

## Updated skill

Email skill 0.5.0 covers MCP mailbox connections, reading, and replies alongside its existing application-email workflows. It prepares the access request before OAuth, checks granted mailbox IDs with `list_addresses`, and explains that a combined owner inbox can contain mailboxes outside an agent's grant. Reading and replying use mailbox grants rather than developer API keys.

The skill keeps the SDK, template-design, sending, and verified-webhook workflows. Its MCP reference distinguishes a prepared request, an approved connection, and a send accepted by the server.

## Downloads and verification

Download CLI 0.3.0 as an installable tarball or standalone `.mjs`, and email skill 0.5.0 as a ZIP. Verify current tools against https://boxox.dev/downloads/RESOURCE-SHA256SUMS.txt or their versioned metadata at https://boxox.dev/downloads/tools-v0.3.0/release.json . The app's versioned 2.4.8 manifest and checksums remain unchanged.

These packages are self-published downloads, not npm registry releases. They are unsigned; SHA-256 checksums establish download consistency rather than independent publisher identity.
