# Processing and AI

Open **Settings → Processing** as the owner after setup.
Changes apply to new requests. An AI request already running may finish.

## Choose processing controls

| Control | Behavior | Saves |
| --- | --- | --- |
| Local filters | Checks mail locally | Immediately |
| Reputation lookups | Requires local filters to be on | Immediately |
| AI | Uses the selected provider when enabled | Immediately |
| Address exceptions | Skips AI classification, indexing, and assist for that address | Immediately |
| Rules, daily budget, uncertainty preference | Controls AI classification and spending | **Save rules and budget** |

You can turn AI off without any Cloudflare credential or saving other form edits.
Turning it off makes no provider calls or gateway changes.

## Enable AI or change providers

This is the one optional feature that needs a credential you create. Box Ox applies privacy and spending settings
to your AI Gateway before any mail reaches a model, and Cloudflare's sign-in for tools cannot change AI Gateway.

1. In Cloudflare, create an API token limited to **AI Gateway Edit** on your account, with a short expiry.
2. Store it: `pnpm exec wrangler secret put CF_API_TOKEN --config .wrangler/deploy/wrangler.json`
3. In **Settings → Processing**, choose the provider, review its data disclosure, and save.
4. Remove it: `pnpm exec wrangler secret delete CF_API_TOKEN --config .wrangler/deploy/wrangler.json`

Before saving consent, Box Ox verifies third-party credits and applies these AI Gateway settings:

- Authenticated Unified Billing.
- Body logging and caching off.
- A zero-data-retention routing preference.
- A daily gateway spending backstop.

Provider retention depends on model support. The routing preference does not guarantee provider retention behavior.
Completed setup keeps its domain/onboarding mutations locked.

## Set rules and a budget

The app accepts a daily budget from $0 to $1,000, stored in integer micro-dollars.
A $0 budget refuses new AI calls.
Rules allow up to 20 entries of 500 characters each. They apply when the AI classifier runs.

Use **Save rules and budget** after changing rules, the budget, or the uncertainty preference.

**The app counter is not a strict billing ceiling.** Concurrent calls can pass its budget check together.

Without that token, a same-provider budget change updates the app limit but retains the previous gateway backstop.
An old lower gateway limit can stop calls early. An old higher limit remains a looser backstop.
Box Ox returns a warning when these limits differ.

To synchronize the gateway limit, store the token again and save the budget again.
Remove the token afterward.

## Work without the token

You can still turn processing groups off, change local/reputation choices, edit rules, and change the app budget.
You can also set address exceptions. Enabling AI or changing an enabled provider requires the token.

## Owner API

These endpoints live under `/api/settings` and require owner authentication:

| Endpoint | Result |
| --- | --- |
| `GET /processing` | Current choices, provider/data disclosure, and address exceptions |
| `PATCH /processing` | Partial update of the fields below |
| `PATCH /processing/addresses/:id` | Set `{ "aiDisabled": true }` or `false` |

The processing patch accepts `localFilters`, `reputationLookups`, `ai`, `provider`, `ownerRules`, `dailyBudgetMicros`, and `onlyWhenUncertain`.
The address patch uses the existing AI opt-out for classification, indexing, and assist consent.
