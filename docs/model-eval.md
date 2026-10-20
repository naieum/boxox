# Spam and model evaluation

Measured on 2026-10-18 (UTC), using public messages only. **The chosen default classifier is
`openai/gpt-6-luna`.** It replaces `@cf/openai/gpt-oss-20b`, the interim default. The all-Anthropic preset retains
`anthropic/claude-haiku-5.5`; the Cloudflare-only preset retains `@cf/openai/gpt-oss-20b`. AI still needs explicit consent.

The decision weighs schema reliability, false positives inside the capped combiner, and measured token cost. The
120-message comparison is small: one ham message is 1.67 percentage points. It does not establish production accuracy.

## Reproduce

```sh
scripts/fetch-corpus.sh
node --experimental-transform-types scripts/spam-eval.ts --json .corpus/ai-off.json
node --experimental-transform-types scripts/spam-eval.ts --train-limit 100
node --experimental-transform-types scripts/model-eval.ts --sample 120 --third-party --gateway default --json .corpus/bakeoff.json
node --experimental-transform-types scripts/model-eval.ts --sample 120 --third-party --gateway default --cache-only
```

`spam-eval.ts` executes the production rules, tokenizer, Bayes probabilities and combiner, with in-memory Bayes counts.
`model-eval.ts` executes `classify()` → `runAi()` → a real remote `env.AI.run` binding from wrangler's platform proxy;
no deployed Worker is needed. The third-party models use the authenticated `default` AI Gateway with logs and cache
explicitly disabled for each request. OpenAI requests include `store: false`. Gateway ZDR does not prove provider
retention support for these models; see `docs/spikes/ai-thirdparty.md`.

Replies stay in git-ignored `.corpus/results/`. Cache names include the classifier instructions and evaluation protocol;
after changing the corpus or request builder, use `--fresh`. `--cache-only` refuses missing replies and makes no
Cloudflare connection. Aggregate measurements and corpus SHA-256 checksums are in `docs/model-eval-results.json`.

## Corpus and method

| Source | Label | Messages |
|---|---|---:|
| SpamAssassin `20030228_easy_ham`, `easy_ham_2` | ham | 3,900 |
| SpamAssassin `20030228_hard_ham` | ham | 250 |
| SpamAssassin `20030228_spam`, `20050311_spam_2` | spam | 1,896 |
| Nazario `phishing-2023`, `-2024`, `-2025` | phishing | 1,303 |

All 7,349 messages parse. Sources: Apache SpamAssassin public corpus and Jose Nazario's CC-BY-4.0 phishing corpus;
URLs are in `scripts/fetch-corpus.sh`. Optional owner exports belong in `.corpus/owner/{ham,spam,phishing}/`; none were
present or sent for these measurements.

The model sample is deterministic and shared by all candidates: 60 ham (20 hard ham), 30 spam, 30 phishing. Selection
is stratified by label and source, then hash order. Every model sees every sampled message. Spam includes spam and
phishing; a false positive is ham sent anywhere outside Inbox. Model-alone decisions flag spam/phishing ≥ 0.5 or
category spam/phishing/scam. Phishing → Quarantine uses phishing ≥ 0.5 or category phishing for the model-alone table.

Five-fold evaluation holds each message out of Bayes, reputation and combiner fitting. AI meta-training rebuilds base
learners inside the outer training fold. Classifiers receive **no label-derived sender history**, so cached training
predictions cannot import outer-test labels through that context. Refit training uses in-sample Bayes features;
evaluation messages remain held out. No embedding/kNN vote was evaluated.

Limitations:
- The corpus never traversed Cloudflare. There are no trustworthy authentication results; `auth_untrusted` is removed,
  and receiving time comes from the top Received header. Live reputation/DNS lookups are not run.
- SpamAssassin anonymization rewrites some list senders to recipient domains, triggering `owner_domain_spoof` on 16% of ham.
- Ham is from 2002 and phishing from 2023–2025; Bayes can learn the era. Related campaigns/senders can span folds.
- Hard ham is deliberately overweighted in the model sample. These false positive rates are not population estimates.
- There are no prompt-injection attempts in the public sample; zero detected is not evidence of injection resistance.

## AI off: whole corpus (`spam-eval.ts`, 5-fold)

Each fold is scored by Bayes, sender reputation and refit weights learned only from the other four folds. This stands in
for a mailbox whose owner has labelled everything else.

| Pipeline | Precision | Recall | False positive rate | False positives | Phishing → Quarantine |
|---|---:|---:|---:|---:|---:|
| Layer-1 rules only (day one, no labels) | 90.5% | 2.7% | 0.22% | 9 of 4,150 | 0.1% |
| Bayes only (log-odds > 0) | 99.4% | 96.3% | 0.48% | 20 of 4,150 | – |
| AI off: rules + Bayes + reputation, hand-set weights | **99.8%** | 91.5% | **0.12%** | 5 of 4,150 | 0.1% |
| AI off: same, weights refit on labels | 99.4% | 95.8% | 0.43% | 18 of 4,150 | 0.1% |

**A newer mailbox** (`--train-limit 100`, so at most 100 labels per fold):

| Pipeline | Precision | Recall | False positive rate | False positives |
|---|---:|---:|---:|---:|
| Bayes only | 95.7% | 85.2% | 2.92% | 121 of 4,150 |
| AI off, hand-set weights | 98.3% | 63.9% | 0.87% | 36 of 4,150 |
| AI off, refit weights | 97.4% | 77.5% | 1.59% | 66 of 4,150 |

By source, with all labels:
- Easy ham: 0 of 3,900 flagged.
- Hard ham: 2.0% flagged with hand-set weights, 6.8% with refit weights.
- Spam: 88% caught with hand-set weights, 94% with refit weights.
- Phishing: 95 to 99% caught.

**Findings:**
1. **Layer-1 rules alone almost never flag anything** (2.7% recall). They are a precise extra input, not a filter. Most
   of the work comes from Bayes once there are labels.
2. **The class-balanced refit buys recall with false positives.** On this corpus it adds about 4 points of recall and
   13 false positives, all of them hard ham. The plan's goal is close to zero false positives, so the refit's class
   weighting, or the spam threshold, should be reviewed with real owner labels before this is relied on.
3. **Without AI, phishing almost never reaches Quarantine** (0.1%). It is caught as spam, but the hand-set phishing
   model needs a signal sum of about 11 to pass 0.8. Only `display_name_spoofs_owner` (28% of phishing) and the link
   and brand signals fire often, at weights 2 to 5. Quarantine with AI off needs the phishing weights retuned. That is
   the combiner's code, and is left for a follow-up.

## Same-sample model bake-off

Each candidate used production request shapes, structured-output validation, a 1,024-token output cap and the 20-second
classifier timeout. gpt-oss uses low reasoning. Latency includes the laptop/remote-proxy hop; third-party calls also
include AI Gateway. These are not production Worker latency measurements. Precision and recall below cover scanned
responses; schema-valid/coverage counts include all attempts.

| Model | Schema-valid | Unscanned | Precision | Recall | False positive rate | Phishing → Quarantine | p50 | p95 | Cost per 1,000 emails |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| @cf/openai/gpt-oss-20b | 99.2% (119/120) | schema 1 | 61.5% | 100.0% | 61.67% (37/60) | 96.6% | 1407 ms | 2186 ms | $0.199 (18055 Neurons ≈ $0.199) |
| openai/gpt-6-luna | 100.0% (120/120) | none | 93.7% | 98.3% | 6.67% (4/60) | 93.3% | 2797 ms | 4555 ms | $0.174 |
| anthropic/claude-haiku-5.5 | 100.0% (120/120) | none | 95.2% | 98.3% | 5.00% (3/60) | 96.7% | 1876 ms | 3389 ms | $0.263 |
| openai/gpt-5.6-luna | 88.3% (106/120) | error 2, timeout 12 | 74.6% | 97.9% | 27.59% (16/58) | 93.3% | 2442 ms | 4363 ms | $0.300 |

gpt-5.6-luna had 12 timeouts and 2 errors. Its latency quantiles exclude calls without a completed response, and its
cost is a **lower bound** because failed/timed-out requests may still bill. Other rows have usage for every completed
response, including the invalid-schema gpt-oss response. Costs use reported provider token counts × allow-list rates;
they exclude the 5% credit-purchase fee and Cloudflare's free Neuron allowance. The 360 third-party attempts recorded
about $0.088 in known response cost, plus any charges from incomplete calls. No billed-total reconciliation was possible
with the available gateway API token scope.

## Whole pipeline: AI on versus AI off

These rows refit AI weights on training folds and include AI-free fallback for all unscanned messages. The common
AI-off sample baseline is 96.6% precision, 95.0% recall, 2/60 false positives, and 0% phishing → Quarantine.

| Model in capped combiner | Precision | Recall | False positive rate | False positives | Phishing → Quarantine |
|---|---:|---:|---:|---:|---:|
| @cf/openai/gpt-oss-20b | 96.5% | 91.7% | 3.33% | 2 of 60 | 3.3% |
| openai/gpt-6-luna | 98.2% | 91.7% | 1.67% | 1 of 60 | 3.3% |
| anthropic/claude-haiku-5.5 | 96.5% | 91.7% | 3.33% | 2 of 60 | 3.3% |
| openai/gpt-5.6-luna | 96.4% | 90.0% | 3.33% | 2 of 60 | 3.3% |

Only-when-uncertain would call AI on 7/120 messages (5.8%). In that mode every candidate yielded 2/60 false positives;
recall was 91.7% for gpt-oss, gpt-6-luna and Haiku, and 90.0% for gpt-5.6-luna. This sample does not show that the
uncertainty switch improves accuracy; its purpose is to reduce calls. The full JSON retains all four pipeline variants.

`gpt-6-luna` is the chosen default because it had 120/120 valid replies, the lowest measured third-party cost, and the
fewest false positives in the capped pipeline (1/60). Haiku was faster and had one fewer model-alone false positive,
but cost about 51% more and yielded 2/60 pipeline false positives. Those one-message differences are uncertain.
`gpt-5.6-luna` was less reliable and more expensive on this run. gpt-oss alone flagged 37/60 ham and must remain a capped
input when selected for Cloudflare-only processing.

`openai/text-embedding-3-small` remains the OpenAI embedding choice: it is the only allow-listed embedding candidate,
and the earlier spike measured 1,536 dimensions and working semantic similarity. This classification bake-off does not
measure retrieval quality or kNN accuracy. The all-Anthropic preset keeps embeddings and semantic search off.

An earlier 400-message gpt-oss run reached 399/400 valid replies, 62.2% model-alone precision, 100% recall,
121/200 ham falsely flagged, p50 1,225 ms, p95 1,828 ms and about $0.195 per 1,000 emails. That historical run included
label-derived sender context. Its cached predictions cannot support a fully held-out AI meta-refit comparison and are
superseded by the no-sender-history protocol above. No earlier claim of a 5→1 false-positive improvement is retained.

The schema must still be named in the prompt: the original gpt-oss request produced 0/400 valid replies when it relied
on `response_format` alone. Naming the keys in `classifierInstructions()` fixed that failure. Runtime usage accounting
now recognizes Chat Completions, OpenAI Responses, Anthropic Messages and wrapped embedding usage, and every runtime
gateway call carries `collectLog: false` as well as `skipCache: true`.

## Runtime integration

IngestWorkflow now scans stored inbound mail before search indexing and notifications. The adapter loads persisted
local-filter choices, model consent, address opt-outs and KV budget; stores layer-1 signals, Bayes scores and the
combiner verdict; saves priority/category only from schema-valid successful classifier output; and reports the actual thread folder. Sender history and known contacts are derived from stored
outbound recipients and owner labels. A completed scan is reused on workflow replay, and verdict plus folder changes
commit atomically. Parser quarantine and unrouted mail are preserved.

AI errors retain the AI-free folder and an unscanned status/backoff timestamp. Existing cron invocations process up to
10 due rescans serially, with consent and budget checked again; per-message operational failures are logged without
blocking other rescans or retention/refit. A rescan timestamp is the earliest eligibility time, not a promise of an
immediate run: the existing cron schedule is six-hourly plus nightly. Synthetic integration tests cover the actual
Workflow and scheduled entrypoints without calling real models.
