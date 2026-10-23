# Box Ox CLI

Download from https://boxox.dev/downloads/boxox-cli-0.3.0.tgz and verify its SHA-256 against https://boxox.dev/downloads/RESOURCE-SHA256SUMS.txt.

```sh
npm install -g ./boxox-cli-0.3.0.tgz
boxox --help
```

Requires Node.js 22+. No npm registry package is required: the SDK and WebSocket client are bundled.
You can also download https://boxox.dev/downloads/boxox-cli-0.3.0.mjs and run `node boxox-cli-0.3.0.mjs --help`.
Use `boxox login --url https://your-install.workers.dev --key -` and provide a scoped Box Ox key through standard input.
Credentials are saved in your OS keychain. On headless systems use `BOXOX_URL` and `BOXOX_KEY` from your secret manager.
See https://boxox.dev/setup/ for infrastructure setup; this CLI works with an existing installation.

## Prepare MCP mailbox access

Version 0.3.0 adds a request planner for the mailbox consent flow in Box Ox 2.4.8 and newer:

```sh
boxox mcp request --url https://mail.example.com --mailbox hello@example.com --mailbox ian@example.com --perm read
boxox mcp request --url https://mail.example.com --grant read:hello@example.com --grant send:hello@example.com --grant read:ian@example.com
```

The first form applies each `--perm` to every listed mailbox. Reading is the default. The second assigns permissions individually; do not mix the forms. `send` permits replies and `send_new` also permits new recipients. Neither is added automatically.

The JSON output contains the exact mailbox request, OAuth scope tokens, MCP endpoint, and Codex login arguments. Configure that endpoint in your MCP client before using its login arguments; `--server-name NAME` changes the configured server name. The planner does not connect, grant access, store credentials, or need a developer key. After the owner approves consent, use MCP `list_addresses` to verify the actual mailbox grants.

## Agent mail

Version 0.2.0 adds `boxox agent` commands. Build from the same source release as your Worker.
Version 0.1.0 does not contain these commands.
Set `BOXOX_URL` and the short-lived `BOXOX_AGENT_TOKEN` through your secret manager.
Agent commands never read the saved developer key.

```sh
boxox agent changes ADDRESS_ID --limit 100
boxox agent pending ADDRESS_ID --group support
boxox agent claim MESSAGE_ID --group support
boxox agent message MESSAGE_ID --include-body true
boxox agent complete MESSAGE_ID --group support --claim-token -
```

The last command reads the claim token from standard input. Claims do not mark mail read.
Use `agent retry`, `agent renew`, and `agent complete-batch` for recovery and bounded acknowledgments.
See the [agent workflow guide](https://boxox.dev/docs/agent-automation/) for checkpoint handling and permissions.
