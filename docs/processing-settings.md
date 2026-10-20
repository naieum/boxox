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

You can turn AI off without a Cloudflare setup token or saving other form edits.
Turning it off makes no provider calls or gateway changes.

## Enable AI or change providers

Enabling AI or changing an enabled provider requires `CF_API_TOKEN` and `CF_ACCOUNT_ID`.

1. Restore the scoped setup token if you removed it.
2. Choose the provider and review its data disclosure.
3. Save the choice, then remove the setup token after configuration.

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

Without the setup token, a same-provider budget change updates the app limit but retains the previous gateway backstop.
An old lower gateway limit can stop calls early. An old higher limit remains a looser backstop.
Box Ox returns a warning when these limits differ.

To synchronize the gateway limit, restore the setup token and save the budget again.
Remove the token afterward.

## Work without the setup token

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
