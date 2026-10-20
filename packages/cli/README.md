# Box Ox CLI

Download from https://boxox.dev/downloads/boxox-cli-0.2.0.tgz and verify its SHA-256 against https://boxox.dev/downloads/SHA256SUMS.txt.

```sh
npm install -g ./boxox-cli-0.2.0.tgz
boxox --help
```

Requires Node.js 22+. No npm registry package is required: the SDK and WebSocket client are bundled.
You can also download https://boxox.dev/downloads/boxox-cli-0.2.0.mjs and run `node boxox-cli-0.2.0.mjs --help`.
Use `boxox login --url https://your-install.workers.dev --key -` and provide a scoped Box Ox key through standard input.
Credentials are saved in your OS keychain. On headless systems use `BOXOX_URL` and `BOXOX_KEY` from your secret manager.
See https://boxox.dev/setup/ for infrastructure setup; this CLI works with an existing installation.

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
