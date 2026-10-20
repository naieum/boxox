# Cloudflare services

Box Ox runs in the installation owner's Cloudflare account. The tables below describe the current code and deployment profiles.
They distinguish features that run by default from optional processing and bindings reserved for future use.

## Application and storage

| Service and official documentation | How Box Ox uses it |
| --- | --- |
| [Workers](https://developers.cloudflare.com/workers/) | Runs the application server, mail handlers, developer API, OAuth endpoints, and MCP server. |
| [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/) | Serves the built React mail client from the application Worker. A separate Worker serves this project's public website. |
| [D1](https://developers.cloudflare.com/d1/) | Stores mail metadata, full-text search data, labels, grants, settings, and developer records. Migrations live in `migrations/`. |
| [R2](https://developers.cloudflare.com/r2/) | Stores raw mail, message bodies, and attachments in a private bucket. Activate R2 before deploying. |
| [Workers KV](https://developers.cloudflare.com/kv/) | Stores OAuth protocol state, the downloaded OpenPhish feed, and AI budget counters. |
| [Durable Objects](https://developers.cloudflare.com/durable-objects/) | `MAILBOX_HUB` coordinates live mailbox updates. The Free profile uses `FREE_RUNTIME` for bounded mail-processing work. |
| [Queues](https://developers.cloudflare.com/queues/) | Buffers ingest, email delivery events, and developer webhooks in the full profile. Dead-letter queues retain failed jobs. The Free profile keeps the webhook queue. |
| [Workflows](https://developers.cloudflare.com/workflows/) | Runs ingest, enrichment, scheduled sending, and snoozing in the full profile. The Free profile uses Durable Objects for processing and omits scheduled sending. |

## Mail, domains, and access

| Service and official documentation | How Box Ox uses it |
| --- | --- |
| [Email Service sending](https://developers.cloudflare.com/email-service/get-started/send-emails/) | The full profile sends transactional mail through the `EMAIL` binding. Account quotas, recipient restrictions, and service terms apply. |
| [Email Routing](https://developers.cloudflare.com/email-routing/) | Routes incoming mail from connected domains to the Worker's email handler. The owner reviews receiving rules and MX changes. |
| [Cloudflare DNS](https://developers.cloudflare.com/dns/) | Hosts connected mail domains and their routing, SPF, DKIM, DMARC, and optional BIMI records. The app previews setup changes. |
| [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) | Protects owner and member routes. The Worker verifies the Access identity and audience. Public protocol routes need the documented exceptions. |
| [Cloudflare OAuth](https://developers.cloudflare.com/fundamentals/oauth/) | Authorizes domain-management access through an installation-owned client. Box Ox encrypts stored credentials and renews the connection. A temporary setup token is also supported. |
| [Rate Limiting bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) | Enforces aggregate and per-sender inbound limits. The config also declares an agent limit binding. Agent grant and sending limits use application checks. |
| [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) | Schedules retention cleanup, reputation-feed refresh, and recovery work. |
| [1.1.1.1 for Families](https://developers.cloudflare.com/1.1.1.1/setup/#1111-for-families) | Optional reputation checks send link domains to Cloudflare's malware-blocking DNS resolver. This lookup runs outside the installation's storage boundary. |

## Optional AI and browser features

AI stays off until the owner enables it. These services belong to the full deployment profile.
Enabling a binding does not enable AI processing by itself.

| Service and official documentation | How Box Ox uses it |
| --- | --- |
| [Workers AI](https://developers.cloudflare.com/workers-ai/) | Runs the allow-listed open-weight model for the Cloudflare-only AI preset. |
| [AI Gateway](https://developers.cloudflare.com/ai-gateway/) | Routes optional OpenAI or Anthropic requests through the owner's gateway. Those providers require prepaid gateway credits. Selected message content leaves Cloudflare for the provider. |
| [Vectorize](https://developers.cloudflare.com/vectorize/) | Stores the semantic-search index when an embedding model is configured. The Cloudflare-only preset has no embedding model. |
| [Browser Run](https://developers.cloudflare.com/browser-run/) | Produces link previews after confirmation and exports stored mail as PDF. PDF rendering blocks network requests. |

Read the [processing guide](https://boxox.dev/docs/processing/) for consent, address exceptions, budgets, and data flow.
Spamhaus, OpenPhish, OpenAI, and Anthropic are separate services. They are not Cloudflare products.
R2 and D1 encryption relies on Cloudflare. Box Ox does not add application-level mail encryption.

## AI models and presets

The owner chooses a provider under **Settings → Processing**. AI can classify mail, assign categories and priority, summarize conversations, and suggest replies.
Embeddings support semantic search and similar-mail matching when the selected preset provides them.

| Preset | Classification and assist | Embeddings | Where requests run |
| --- | --- | --- | --- |
| OpenAI | `openai/gpt-6-luna` | `openai/text-embedding-3-small` | OpenAI through the owner's AI Gateway. Selected mail content leaves Cloudflare. |
| Anthropic | `anthropic/claude-haiku-5.5` | None | Anthropic through the owner's AI Gateway. Selected mail content leaves Cloudflare. |
| Cloudflare only | `@cf/openai/gpt-oss-20b` | None | Workers AI inside Cloudflare's service boundary. |

All three presets select `@cf/openai/whisper-large-v3-turbo` for transcription.
Read the official [GPT-OSS model documentation](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/) and [Whisper model documentation](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/).
The [model allow-list and preset definitions](https://github.com/naieum/boxox/blob/main/apps/worker/src/services/ai/models.ts) are the source of truth for model IDs.

For consent, budget controls, address exceptions, and provider retention limits, read [Processing and AI](https://boxox.dev/docs/processing/).

## Deployment and operations

| Service and official documentation | How Box Ox uses it |
| --- | --- |
| [Wrangler](https://developers.cloudflare.com/workers/wrangler/) | Develops, provisions, migrates, and deploys the application from the local installer or a build. |
| [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) | Builds and deploys a connected repository when the owner chooses the hosted deployment path. |
| [Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/) | Starts hosted deployment with separate Free and Paid templates. See the [button setup guide](https://boxox.dev/docs/deploy-button/). |
| [Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) | Holds setup credentials, Access configuration, and the agent signing secret outside source control. |
| [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) | Collects Worker observability data. The portable configuration enables observability. |
| [Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/) | The full profile declares an `ANALYTICS` binding. Current application code does not write Analytics Engine data points or provide an aggregate analytics dashboard. |

The portable configuration is [`wrangler.jsonc`](https://github.com/naieum/boxox/blob/main/wrangler.jsonc).
The installer writes account-specific resource identifiers into an ignored `.wrangler/deploy/wrangler.json` file.
The public website runs in a separate Worker. Its source and build tools are maintained outside this repository.

The [Free profile guide](https://boxox.dev/docs/free/) lists its feature and quota limits.
Review [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and each product's pricing before enabling it.
