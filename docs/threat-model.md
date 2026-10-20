# Box Ox V2 threat model

This document describes trust boundaries, threats, and defenses in the V2 application.
Each `Test:` reference names a test path and case as `<path>::<test name>`.
Run the Worker test suite to check the corresponding behavior.

Rules that hold for every row:
- Mail content, headers and attachments are untrusted data, including the parts that claim to come from us.
- Agent paths (`/api/agent/v1/*`, `/mcp`, `/oauth/*`) and developer paths (`/dev/v1/*`) are outside Access.
  Every other path is behind Access.
- The Access JWT check in `apps/worker/src/middleware/access.ts` is the only proof of sign-in.
  `ctx.access` is `undefined` once the Worker serves
  static assets. On bypassed paths it carries the bypass app's `aud`. So `ctx.access` is never treated as
  "signed in".

## External attacks

### Malicious HTML mail (XSS, CSS tricks, form phishing)

**Threat.** HTML in a message runs script on the app origin, steals the session, or imitates the app's UI
with CSS and forms.

**Defence.** DOMPurify, and then a sandboxed iframe with no `allow-scripts` or `allow-same-origin`. The
app CSP is strict and sets `frame-ancestors 'none'` (`middleware/security-headers.ts`). Forms and
`meta refresh` are stripped.

Test: apps/worker/test/safe-render.test.ts::the XSS payload corpus never executes in the sandboxed frame

### Tracking pixels / IP leaks

**Threat.** Remote images tell the sender that the mail was opened, and when and from which IP.

**Defence.** Remote images are blocked by default. When the user allows them, they load through the
Worker's image proxy. The proxy strips cookies and referrer, hides the user's IP, and limits size and time.

Test: apps/worker/test/safe-render.test.ts::the image proxy strips cookies and referrer

### Phishing links

**Threat.** A link shows a trusted domain but goes to a credential-harvesting page.

**Defence.** Flagged mail gets a link warning page that shows the real destination. Quarantine disables
links. 1.1.1.2 DoH lookups (a `0.0.0.0` answer means blocked; see `docs/spikes/platform.md`) and the
OpenPhish feed are spam signals. The warning page follows only signed URLs, so it is not an open redirect.
`spam-signals.test.ts::flags link text that shows a different domain` covers the signal.

Test: apps/worker/test/safe-render.test.ts::the link warning page only follows signed urls

### Spoofing and look-alikes

**Threat.** A forged From, a display name that copies the owner's domain, or a punycode look-alike domain.

**Defence.** Cloudflare rejects mail that fails the sender's DMARC policy. Only Cloudflare's authserv-id is
trusted for `Authentication-Results`. The UI shows an authentication badge, a "first time sender" banner,
and warnings for spoofed display names and look-alike domains. `spam-signals.test.ts::flags a look-alike
punycode domain` and `ingest.test.ts::trusts Cloudflare's authserv-id for authentication results` cover
the rest.

Test: apps/worker/test/spam-signals.test.ts::flags a display name that spoofs the owner's domain

### Thread hijacking (forged References)

**Threat.** A forged `References` or `In-Reply-To` header puts attacker mail into a trusted thread, or into
another mailbox.

**Defence.** Threading is limited to one mailbox, as in v1. An unknown sender who joins a thread is marked
"new participant". Spam checks still run on replies. `threading-v2.test.ts::an unknown sender joining is
marked new participant` covers the marker.

Test: apps/worker/test/threading-v2.test.ts::a forged References header pointing at another mailbox does not join

### Malicious attachments

**Threat.** An HTML or SVG attachment runs script on the app origin. An executable is disguised with a
bidirectional-override character or a double extension. A zip bomb.

**Defence.** The detected type (from magic bytes) is used, never the type the sender declared. Filenames
are cleaned. Dangerous files can only be downloaded, behind a warning, and they feed the spam signals.
Archives are never unpacked. Every attachment response sends `Content-Disposition: attachment` (inline
only for safe images and PDFs), `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`.
The rest of `attachments-v2.test.ts` covers the other points.

Test: apps/worker/test/attachments-v2.test.ts::serves html and svg attachments with CSP sandbox and as attachment

### MIME parser attacks (deep nesting, huge headers, malformed encodings)

**Threat.** Crafted MIME uses up CPU or memory, crashes the parser, or makes the ingest Workflow retry
forever.

**Defence.** Parsing runs inside a Workflow step, with limits on size, part count, nesting depth and
header count. If parsing fails, the raw message is quarantined instead of retried. Before release, the
fuzz corpus in `apps/worker/test/fuzz` runs too. `ingest.test.ts::giant headers are rejected by the
parser limits` covers headers.

Test: apps/worker/test/ingest.test.ts::a deeply nested MIME message is quarantined, not retried forever

### Prompt injection against the AI classifier, summaries and agents

**Threat.** Text in a message tells a model to call it "not spam", to leak data, or to forward mail.

**Defence.** Mail goes to models only as data, in clearly marked fields. Classifier output that fails the
JSON schema is thrown away, and the message is marked "unscanned". The classifier score is only one input
to layer 3. Summaries run with no tools and render as plain text. Agents don't see mail flagged
`prompt_injection` unless they have the `classify` grant. Reply-only send policy means an injected
"forward to x@evil" fails without `send_new`. Other tests that cover this:
`spam-combiner.test.ts::injected text saying not spam cannot decide the verdict alone`,
`assist.test.ts::summaries run with no tools` and
`agent-v2.test.ts::an injected forward-to-attacker instruction is refused`.

Test: apps/worker/test/spam-classifier.test.ts::mail text is passed in marked data fields, never as instructions

### Flooding the mailbox / running up costs

**Threat.** Floods of mail fill storage and use up the Workers AI budget. Random local parts abuse the
catch-all.

**Defence.** `email()` has per-sender and global rate limits (rate-limit binding). AI is skipped when
layer 1 is already certain. The daily AI budget cap falls back to the non-AI checks. The unknown-address
policy (`drop` or `hold`) limits catch-all abuse. Storage-usage alerts. `models.test.ts::stops calling AI
once the daily budget is spent` and `spam-combiner.test.ts::falls back to AI-free weights when the budget
is spent` cover the budget.

Test: apps/worker/test/email-handler.test.ts::rate-limits a flooding sender

### Web app attacks (CSRF, IDOR, open redirects)

**Threat.** A forged cross-site request, reading another address's data by changing an id, or an open
redirect.

**Defence.** Access protects everything except the agent and developer paths. Mutating requests need a
matching Origin and a custom header (`middleware/csrf.ts`). Every query is filtered by address grants
(`services/access.ts`). There are no open redirects: the link warning page and click tracking use signed
URLs. `security-base.test.ts::rejects a mutating request with a foreign Origin` covers CSRF, and
`security-base.test.ts::refuses every app request while ACCESS_AUD or TEAM_DOMAIN is unset` covers Access.

Test: apps/worker/test/access-grants.test.ts::a user without a grant cannot read another address's threads

### MCP / OAuth attacks

**Threat.** A stolen authorization code, a redirect to an attacker's `redirect_uri`, a client that
registers itself and gets access, or a long-lived stolen token.

**Defence.** PKCE is required. `redirect_uri` must match exactly. The consent page is behind Access.
Client registrations are rate-limited and the owner approves each one. Tokens are short-lived, and each
client has a revoke button. `/mcp` is an Access bypass path, so the consent page and token issuance must
never trust `ctx.access` there (`docs/spikes/platform.md`, finding 2). The rest of `mcp.test.ts` covers
redirect matching, approval and revocation.

Test: apps/worker/test/mcp.test.ts::requires PKCE

### Public large-file download links

**Threat.** Someone guesses, lists or scrapes download tokens, or a link stays live after it should have
expired.

**Defence.** 128-bit tokens, expiry (7 days by default), revocation and rate limits. No listing of other
files. `noindex`. The page is outside Access and serves only the one file the token names.

Test: apps/worker/test/compose.test.ts::large-file links expire, can be revoked and are rate limited

### Browser Run link previews

**Threat.** Rendering a link automatically triggers a one-click unsubscribe, confirmation or tracking
action, or tells the sender the mail was read.

**Defence.** Previews run only when the user asks. The UI warns that visiting a link can trigger one-click
actions. Previews never run automatically. `preview.test.ts::warns that visiting can trigger one-click
links` covers the warning.

Test: apps/worker/test/preview.test.ts::previews only run when the user asks

## Internal and operational risks

### Leaked Cloudflare API token (it can edit DNS)

**Threat.** The setup token leaks and is used to change DNS or other account resources.

**Defence.** Least-privilege scopes, limited to the chosen zones. Only the setup and domain pages use the
token. The wizard recommends removing the token after setup (add it again to add domains), and the app
works without it. The token is a Worker secret, set with `wrangler secret put` through stdin, and it is
never logged.

Test: apps/worker/test/cloudflare-client.test.ts::reports a clear error when no token is configured

### Compromised or over-eager agent

**Threat.** An agent's credentials are stolen, or the agent misbehaves: it mails new people, sends in
bulk, or deletes mail.

**Defence.** `send_new` is off by default. Per-agent hourly and daily send caps. Agents have no
hard-delete permission (trash only). Everything an agent does goes to the audit log (`audit.ts`), which
the UI shows. A kill switch for each agent and one for all agents. `agent-v2.test.ts::an agent without
send_new cannot mail a new recipient` and `agent-v2.test.ts::agents cannot permanently delete` cover the
rest.

Test: apps/worker/test/agent-v2.test.ts::the kill switch stops all agent actions

### Damage to sender reputation (Cloudflare can suspend the account)

**Threat.** Bounces or complaints rise until Cloudflare suspends sending for the whole account.

**Defence.** A circuit breaker pauses all sending when the bounce or complaint rate crosses a threshold.
Hard-bounced and complaining recipients are suppressed. The owner gets an alert.
`send.test.ts::maps a recorded Cloudflare bounce event to bounced and suppresses the address` covers
suppression.

Test: apps/worker/test/send.test.ts::pauses all sending when the bounce rate crosses the threshold

### Invited users overstepping

**Threat.** An invited user reads or acts on addresses they have no grant for, or uses owner-only admin
routes.

**Defence.** The server checks grants for every address. Threads never span mailboxes. Admin routes are
owner-only. Audit log. `mailbox-hub.test.ts::only pushes to users with a grant on the address` covers
realtime push.

Test: apps/worker/test/access-grants.test.ts::admin routes are owner-only

### Sensitive data in logs

**Threat.** Bodies, headers, API keys, webhook secrets or tokens end up in Workers logs or Logpush.

**Defence.** The v1 rule is kept: no bodies, headers or tokens in logs. A redaction helper in `log.ts`,
plus a test that checks the log output.

Test: apps/worker/test/security-base.test.ts::logger never prints message bodies, headers or tokens

### Data loss

**Threat.** A bad migration, a bug or an accidental purge loses mail.

**Defence.** D1 Time Travel (30 days). Trash is held for its window before R2 objects are deleted. mbox
export. `wrangler d1 export` refuses databases with FTS5 tables (`docs/spikes/platform.md`, finding 4), so
backups use Time Travel and our own export, never `d1 export` alone.

Test: apps/worker/test/retention.test.ts::R2 objects are deleted only after the trash window ends

### Supply chain (a fork syncing a compromised upstream)

**Threat.** A compromised upstream commit or dependency reaches an owner's fork, and Workers Builds
deploys it.

**Defence.** Signed release tags. The README tells owners to sync tags, not `main`. Pinned lockfile, few
dependencies, Dependabot, hardened CI, and `pnpm audit` in CI.

Test: apps/worker/test/release-hygiene.test.ts::CI installs from the frozen lockfile and runs pnpm audit

### Account takeover (Cloudflare or GitHub)

**Threat.** Someone takes over the owner's Cloudflare or GitHub account and deploys their own code.
Workers Builds deploys whatever is pushed.

**Defence.** The README requires two-factor sign-in on both accounts and recommends security keys. This
row is mostly a review sign-off. The test only checks that the README keeps the requirement.

Test: apps/worker/test/release-hygiene.test.ts::README requires two-factor sign-in on Cloudflare and GitHub

### Data at rest and AI processing

**Threat.** The owner doesn't know where mail content is processed, or what at-rest protection it has.

**Defence.** Cloudflare encrypts R2 and D1 at rest. App-level encryption is not planned, because it would
break search, and the docs say so plainly. AI is off until the owner picks it explicitly. The consent
screen names the provider company and the models. Settings shows the Workers AI privacy note. AI calls go
through AI Gateway with ZDR on and body logging off. `setup.test.ts::AI group defaults to off and nothing
is pre-ticked` and `cloudflare-client.test.ts::applies AI Gateway settings: ZDR on, body logging off,
spend limit` cover the rest.

Test: apps/worker/test/setup.test.ts::consent screen names the provider company and models

## Developer API security additions

### API key leaks

**Threat.** A `bxk_` or `bxm_` key is committed, logged or stolen.

**Defence.** The key hierarchy limits the damage. A leaked domain key reaches only its one domain and its
permissions. A leaked management key can mint keys only for its assigned domains, and can't send or read
mail itself. Keys are stored hashed (SHA-256 of a 256-bit secret) and shown once. Recognisable prefixes
for secret scanners. Rotation, expiry, IP allow-lists, revocation and last-used time and IP. Other tests
that cover this: `dev-keys.test.ts::a domain key cannot act on another domain`,
`dev-keys.test.ts::a management key cannot send or read mail` and
`dev-keys.test.ts::rotation keeps both secrets valid during the overlap window`.

Test: apps/worker/test/dev-keys.test.ts::keys are stored hashed and shown once

### Escalation through the hierarchy

**Threat.** A management or domain key gets more than it was given: a management key, a key for another
domain, or wider permissions or caps.

**Defence.** Management keys can't create management keys, and can be created only in the
Access-protected UI. Child permissions and caps are capped by the parent. Every route is tried with keys
for the wrong domain and with management keys, and must return 403. MCP refuses management-key and
owner-level operations. Other tests that cover this:
`dev-keys.test.ts::a management key cannot be created through the API`,
`dev-keys.test.ts::a management key cannot create a key for a domain outside its list` and
`mcp.test.ts::MCP refuses management-key and owner-level operations`.

Test: apps/worker/test/dev-keys.test.ts::a child key cannot exceed its parent's permissions or caps

### A project's key used to send spam

**Threat.** A project's domain key, leaked or misused, sends bulk mail and puts the Cloudflare account at
risk.

**Defence.** Per-key daily caps. Sends made with domain keys count toward the global circuit breaker on
bounce and complaint rates, which protects the account.

Test: apps/worker/test/dev-keys.test.ts::a domain key's daily send cap feeds the circuit breaker

### Webhook targets

**Threat.** Webhook endpoints are used to reach internal services (SSRF), or webhook secrets leak.

**Defence.** HTTPS only. Workers can't reach private networks anyway, but obvious internal hostnames are
blocked. Secrets are never logged. Signatures use the Standard Webhooks format.
`dev-webhooks.test.ts::signatures match the Standard Webhooks test vectors` covers signing.

Test: apps/worker/test/dev-webhooks.test.ts::only https targets are accepted

### Tracking privacy

**Threat.** Open and click tracking runs without anyone choosing it, or the tracking endpoints leak
information or act as open redirects.

**Defence.** Tracking is off by default and is set per domain. The pixel and click endpoints reveal
nothing else. Only signed click URLs are followed.
`dev-tracking.test.ts::an unsigned click url is refused` covers redirects.

Test: apps/worker/test/dev-tracking.test.ts::tracking is off unless enabled

### Template injection

**Threat.** Template variables filled from user input inject HTML or script into sent mail.

**Defence.** The in-house renderer escapes `{{var}}`. `{{{var}}}` outputs raw HTML only for variables
declared raw. `dev-templates.test.ts::raw output only for variables declared raw` covers the raw case.

Test: apps/worker/test/dev-templates.test.ts::escapes variables by default
