# Box Ox 2.1.1

## Sent mail belongs in Sent

New outgoing messages and API sent-mail copies now start in Sent.
They no longer create standalone Inbox entries.
When a received reply joins the conversation, it appears in Inbox and remains available in Sent.
Replying within an existing Inbox conversation keeps that conversation in Inbox.

Restoring a deleted outgoing-only conversation returns it to Sent.
Restoring a conversation with received messages returns it to Inbox.

## Existing mail

The deployment migration moves outgoing-only Inbox conversations into Sent.
It keeps received conversations and existing Archive, Trash, Spam, and quarantine filing.
It does not delete messages, attachments, or delivery records.

## Install or update

Use the [agent installation guide](https://boxox.dev/docs/agent-installation/) or the [downloads page](https://boxox.dev/downloads/).
The installer still supports the Free inbox preview and the full Paid profile.
The SDK, CLI, and email skill keep their existing versions.
