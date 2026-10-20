# Box Ox SDK

A typed JavaScript/TypeScript client for your Box Ox installation. MIT licensed.

Download https://boxox.dev/downloads/boxox-mail-0.2.0.tgz and verify it against https://boxox.dev/downloads/SHA256SUMS.txt.

```sh
npm install ./boxox-mail-0.2.0.tgz
```

```js
import { BoxOx } from '@boxox/mail';
const mail = new BoxOx({ url: process.env.BOXOX_URL, key: process.env.BOXOX_KEY });
await mail.messages.send({ from: 'hello@yourdomain.com', to: 'recipient@example.com', subject: 'Your receipt', text: 'Thank you.' }, { idempotencyKey: 'receipt-123' });
```

Use only authorized recipients. Store keys in a secret manager. A queued response proves acceptance, not delivery.
The package has no runtime dependencies. API reference: https://boxox.dev/docs/api/README.md

## Agent mail

Version 0.2.0 exports `BoxOxAgent`. It uses a short-lived agent bearer, separate from developer keys.
Build from the same source release as your Worker. Version 0.1.0 does not contain this client.

```js
import { BoxOxAgent } from '@boxox/mail';
const agent = new BoxOxAgent({ url: process.env.BOXOX_URL, token: process.env.BOXOX_AGENT_TOKEN });
const page = await agent.changes(addressId, { cursor: savedCheckpoint, limit: 100 });
// Process or durably queue the page before saving page.nextCursor.
```

Use `agent.work.pending()`, `claim()`, `complete()`, `renew()`, and `retry()` for processing leases.
Thread and message reads return metadata unless you pass `{ includeBody: true }`.
A `token: async () => getFreshBearer()` supplier can renew authentication before each request.
The client never retries mutations automatically. See the [agent workflow guide](https://boxox.dev/docs/agent-automation/) for bounds and recovery rules.
