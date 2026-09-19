## 2026-09-18 Catalog cleanup

The curated catalog (`src/lib/llm-model-catalog.ts`) dropped from 32 rows to 21. Removed, each
strictly dominated by a same-provider sibling already in the catalog (same-or-worse price, and
worse on every other axis — see `docs/rollouts/2026-09-18-model-catalog-cleanup.md` for the
live-priced before/after table): **GPT-5.4 Nano, GPT Mini (5.4), GPT-5.6 Terra, GPT-4o, GPT-4o
mini, Grok Build 0.1, MiniMax M2.7, DeepSeek R1, Llama 4 Maverick, Llama 4 Scout, Llama 3.3
70B.** The Green Team recommendation that used to sit on GPT-5.6 Terra moved to **GPT-5.6 Sol**
(same input price, cheaper output, stronger model — Sol now carries both the Green and Red
recommendation chips). Mistral Medium is no longer described as "frontier": at $1.50/$7.50 it is
now the **priciest** Mistral row, more expensive than Mistral Large ($0.50/$1.50) — the two
`$`-tier fields were swapped to match. `mistral-large-latest`'s OpenRouter route
(`mistralai/mistral-large-2512`) has no non-batch listing as of 2026-09-18 — see the in-code
comment on that catalog row and the rollout note; the native Mistral API fallback is the
reliable path until OpenRouter lists one. GPT-6 Astra Pro's label no longer says "via
OpenRouter" (every catalog model routes through OpenRouter whenever a credential is
configured, so naming it on one row implied a distinction that doesn't exist) and now explains
what Astra Pro actually is: GPT-6 Astra served with `reasoning.mode=pro`, not a separate SKU.
The Meta picker group header changed from "Meta (via OpenRouter)" to "Meta" for the same
reason. MiniMax M3, Muse Spark 1.3, and Muse Glimmer 30B labels now start with their
`displaySlug` (matching every other row and the Model Stats / Usage pages, which have always
rendered the bare slug). The `MODEL_PRICE_PER_M` budget-estimate table
(`src/lib/llm-usage.ts`) was re-verified against the live OpenRouter list and several entries
were wrong: GPT-5.6 Sol ($5/$30 → real $2/$10), GPT-5.6 Luna ($1/$6 → real $0.20/$1.20), Claude
Sonnet 5 ($3/$15 → real $2/$10), Kimi K3 ($0.30/$1.20 → real $1.95/$10.92 — the old figure was
Kimi's cache-HIT input price, not the real rate), plus smaller corrections to DeepSeek Flash,
DeepSeek Pro, Gemini Flash Lite, and Muse Glimmer 30B. Prices for the 11 removed rows were left
in that table under a clearly commented "retired" block so any already-recorded historical
usage still resolves to a cost estimate.

## 2026-09-09 Meta refresh

GPT-6 Astra Pro is available via OpenRouter; its native API route is not assumed.  Muse Spark 1.3 and Muse Glimmer 30B join Llama 4 in the Meta group.  Meta models require an OpenRouter key; standalone Meta credentials are never forwarded to OpenAI.  MiniMax supports its native pay-as-you-go API key or OpenRouter, including explicit `CHAT_LLM=minimax` operator configuration.  Native MiniMax provider-envelope errors enter the same failure handling as HTTP errors, including billing cooldowns.  Its schema-prompt proposal responses pass the existing completeness gate before sizing; MiniMax and Muse use the wider default-reasoning timeout.  Chat availability and budget enforcement follow the tenant credential route actually used.  Learning-review labels resolve historical aliases through the current catalog, and audit metadata distinguishes the resolved request model from the model reported by the provider.

# Manager / Strategist model options — cross-provider evaluation

## Catalog refresh — 2026-09-09

The web picker now includes GPT-6 Astra, MiniMax M3/M2.7, and Meta Llama 4 Maverick/Scout.  Fable's current native version is 5.1; Grok is 4.6; Gemini Flash is 3.8.  Existing selections and family aliases remain valid.  OpenRouter's live catalog supplies verified routing IDs; the latest stable DeepSeek V4 snapshots and Mistral Medium/Large routes are pinned in `src/lib/llm-model-catalog.ts`.

MiniMax accepts standard server-side pay-as-you-go API credentials through its OpenAI-compatible endpoint.  Its Token Plan supports developer tools but is described as individual interactive development, with pay-as-you-go recommended for production; the app does not promise subscription-funded automated trading.  Sources and verification are recorded in `docs/rollouts/2026-09-09-model-catalog-account-labels.md`.


Decision aid for the sovereign-design question **"which model tier + budget runs the
strategist ('Manager') loop?"** The owner asked for a cross-provider options list (not
Anthropic-only) and a way to evaluate how each performs — including DeepSeek for cost.

## 2026-07-13 current OpenAI policy

## 2026-07-22 rotation availability behavior

When Green or Red is set to rotation, the server now intersects the credential-resolvable curated
pool with OpenRouter's account-filtered `GET /api/v1/models/user` response before choosing a slot.
This prevents a disabled account model such as Claude Fable 5 from being selected by rotation. A
temporary availability-check failure fails rotation closed with an actionable retry message; it does
not silently fall back to another provider or to the other team. Explicit model selections preserve
the existing fail-closed behavior, so an unavailable Red model produces a human-review receipt rather
than being replaced by Green. The account model list is cached in-process for five minutes.

Today's production-schema benchmark successfully called all three GPT-5.6 API IDs (artifact:
`docs/benchmarks/2026-07-13-gpt-5-6-benchmark.md`). The official catalog positions Sol for complex
professional work, Terra for intelligence/cost balance, and Luna for cost-sensitive high volume.
All three expose `none | low | medium | high | xhigh | max` reasoning.

| OpenAI option | $ in / out per 1M | Recommended use | Effort |
|---|---:|---|---|
| GPT-5.6 Sol | 5 / 30 | Red Team; consequential strategy/learning review; difficult manual deep dives | Medium Green/Coach; **High Red/review** |
| GPT-5.6 Terra | 2.5 / 15 | **Green Team** and balanced Coach; Red/review when Sol cost is not justified | **Medium Green/Coach**; High Red/review |
| GPT-5.6 Luna | 1 / 6 | High-volume Coach/synthesis; cost-sensitive Green | Low Coach; Medium Green; prefer Terra/Sol for Red/review |
| GPT-5.4 Mini | 0.75 / 4.5 | Lowest-cost model still advisable as a complete Green seat | Low Coach; Medium Green; High Red/review if deliberately used |
| GPT-5.4 Nano | 0.20 / 1.25 | Extraction, classification, routing, mechanical summaries | Low; **not advisable as the sole Green or Red seat** |

Catalog decision: remove full GPT-5.4 and GPT-5.5 from curated selectors because Terra and Sol are
same-price current successors. Keep stored/custom legacy IDs callable so existing policy does not
break. Keep Mini and Nano: despite its newer generation, Luna is more expensive than both. The app
has no model defaults; these are role recommendations shown before an explicit choice. Terra's Green
and Sol's Red recommendation chips are provisional until realized account-scoped outcomes establish
superiority.

The broader cross-provider analysis below remains useful, but this section supersedes its older
OpenAI rows and any paper-only evaluation wording.

> **Pricing is as of July 2026 and moves often — re-verify at the provider's pricing page before
> committing a budget.** Anthropic figures are from the bundled `claude-api` model reference;
> others are from web search (sources at the bottom). $ = USD per **1M tokens** (input / output).

---

## 1. The candidates

| Provider | Model | $ in | $ out | Context | Reasoning | Wires into this repo via |
|---|---|---|---|---|---|---|
| **Anthropic** | Claude Opus 4.8 | 5 | 25 | 1M | adaptive | native Anthropic path (already in the assistant chat) |
| Anthropic | Claude Sonnet 5 | 3 (2 intro→08-31) | 15 (10 intro) | 1M | adaptive | native Anthropic path |
| Anthropic | Claude Haiku 4.5 | 1 | 5 | 200K | — | native Anthropic path |
| Anthropic | Claude Fable 5 | 10 | 50 | 1M | always-on | native Anthropic path (premium; likely overkill here) |
| **OpenAI** | GPT-5.6 Sol | 5 | 30 | 1.05M | none → max | OpenAI path; explicit model choice |
| OpenAI | GPT-5.6 Terra | 2.50 | 15 | 1.05M | none → max | OpenAI path; explicit model choice |
| OpenAI | GPT-5.6 Luna | 1 | 6 | 1.05M | none → max | OpenAI path; explicit model choice |
| OpenAI | GPT-5.4 Mini | 0.75 | 4.50 | — | effort knob | OpenAI path; retained lower-cost option |
| OpenAI | GPT-5.4 Nano | 0.20 | 1.25 | — | effort knob | OpenAI path; mechanical tasks only |
| **Google** | Gemini 3.1 Pro | 2 | 12 | (200K tier) | thinking | OpenAI-compatible endpoint (base-URL swap) |
| Google | Gemini 3.5 Flash | 1.50 | 9 | — | thinking | OpenAI-compatible endpoint |
| Google | Gemini 3 Flash Preview | 0.50 | 3 | — | thinking | OpenAI-compatible endpoint |
| **DeepSeek** | V4 Pro | 1.74 (promo 0.44) | 3.48 (promo 0.87) | 1M | yes | OpenAI-compatible endpoint (base-URL swap) |
| DeepSeek | V4 Flash | 0.14 | 0.28 | 1M | — | OpenAI-compatible endpoint |
| **xAI** | Grok 4.3 | 1.25 | 2.50 | — | reasoning variant | OpenAI-compatible endpoint |
| xAI | Grok 4.1 Fast | 0.20 | 0.50 | — | reasoning variant | OpenAI-compatible endpoint |
| **Alibaba** | Qwen3.7-Max | 2.50 (promo 1.25) | 7.50 (promo 3.75) | — | `enable_thinking` | OpenAI-compatible endpoint |
| Alibaba | Qwen-Plus | 0.40 | 1.20 | — | `enable_thinking` | OpenAI-compatible endpoint |

**Wiring reality (important):** the strategist loop already speaks the **OpenAI Chat Completions**
shape (`OPENAI_API_KEY`), and the console assistant already has a native Anthropic path. DeepSeek,
xAI, Qwen, and Google all expose **OpenAI-compatible** endpoints — so adding any of them is a
`base_url` + key change and a model-id string, **not** a new integration per provider. That makes an
A/B across providers cheap to stand up.

## 2. Cost reality for THIS workload

The strategist is **low-volume and output-heavy**: a handful of runs per day, each producing a few
schema-constrained proposals plus reasoning. So **output tokens dominate**, and the absolute cost per
run is small even on a premium model. Rough per-run envelope (say ~15K input context + ~8K output
incl. reasoning):

| Model | ~$ / run | ~$ / month @ 20 runs/day |
|---|---|---|
| DeepSeek V4 Flash | ~$0.004 | ~$2.5 |
| Grok 4.1 Fast | ~$0.007 | ~$4 |
| Gemini 3 Flash Preview | ~$0.03 | ~$18 |
| DeepSeek V4 Pro (promo) | ~$0.014 | ~$8 |
| Gemini 3.1 Pro | ~$0.13 | ~$78 |
| Claude Sonnet 5 (intro) | ~$0.11 | ~$66 |
| GPT-5.6 Luna | ~$0.06 | ~$38 |
| GPT-5.6 Terra | ~$0.16 | ~$95 |
| GPT-5.6 Sol | ~$0.32 | ~$190 |
| Claude Opus 4.8 | ~$0.28 | ~$168 |

Takeaway: at this run frequency, **even the most expensive option is ~$150–200/mo**, and the cheapest
are a few dollars. The cost spread is real but the absolute numbers are low — for a role that decides
real-money trades, **capability and reliability should outweigh token cost**. Cost matters more if you
later crank run frequency, add per-account fan-out, or move to high-frequency scanning.

## 3. What actually matters for the strategist role

Not raw benchmark IQ — the things that make a trading strategist safe and usable:

1. **Structured-output / JSON-schema adherence.** Proposals are schema-constrained (`TradeProposal`
   with required `tradeThesisTag`, `entryMarketRegime`, side, sizing…). A model that reliably emits
   valid, complete structured output matters more than one that's 2 points higher on a reasoning eval.
   Anthropic (strict tool use / `output_config.format`) and OpenAI (structured outputs) are the most
   battle-tested here; DeepSeek/Qwen/Grok/Gemini via the OpenAI-compatible path are usually fine but
   should be verified on the actual schema.
2. **Reasoning quality on ambiguous, incomplete market data** — the core judgment call.
3. **Instruction-following / not over-trading** — respecting the "only propose with genuine
   conviction" guidance and the guardrails framing.
4. **Refusal / policy behavior.** Some models refuse finance-adjacent prompts unevenly; the strategist
   prompt is benign but worth checking a model doesn't balk.
5. **Data handling / ToS.** Confirm each provider's terms permit automated trading-assistance use and
   that data-residency/retention fits your posture (esp. non-US providers: DeepSeek, Qwen).

## 4. Recommendation

**Don't pick by spec sheet — measure it.** #334 just landed **`proposedByModel` persistence**, so the
app now records realized win-rate / return / P&L **per model** on Results. That turns "evaluate how
each performs" from a guess into an experiment:

1. **Shortlist 3 to A/B** (spans the capability/cost space):
   - **Claude Sonnet 5** — strong reasoning + best-in-class structured output, ~$0.11/run at intro
     pricing. The balanced default.
   - **DeepSeek V4 Pro** — the cost play the owner flagged; frontier-ish reasoning at ~$0.01/run.
     Verify schema adherence + ToS/data-residency first.
   - **GPT-5.6 Terra or Gemini 3.1 Pro** — a third independent lineage so you're not comparing two similar
     models; pick by whichever you trust more on structured output.
2. **Run attributed comparative rotation** on a deliberately selected broker account over enough
   outcomes. Paper-account results remain isolated unless independently corroborated by live data;
   the Results page and model/source receipts rank concrete serving models within that scope.
3. **Promote the winner** to the live Manager role; keep a cheaper model (DeepSeek V4 Flash / Grok 4.1
   Fast) as the scout/pre-filter tier if you add a two-stage loop later.

**If you want explicit OpenAI picks today without the comparison:** Terra/Medium for Green and
Sol/High for Red; Luna/Low for Coach. These are starting priors, not defaults or realized-performance
claims. Claude Sonnet 5 remains the strongest established cross-provider balanced candidate in the
older benchmark set.

**Budget to set:** at 20 runs/day, **$25–200/mo** covers any single-model choice; **$300/mo** comfortably
covers a 3-model A/B plus headroom. Set the ceiling where you're comfortable and the frequency/tier can
scale into it.

## 5. Wiring notes

- **OpenAI-compatible providers (DeepSeek, xAI, Qwen, Google):** point the existing OpenAI client at the
  provider's `base_url`, set that provider's key, use its model-id string. No per-provider SDK.
  - DeepSeek: `https://api.deepseek.com` · Grok: `https://api.x.ai/v1` · Gemini:
    `https://generativelanguage.googleapis.com/v1beta/openai/` · Qwen (intl):
    `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`.
- **Anthropic:** native path already exists in the console assistant; reuse it for the strategist.
- **Structured output:** validate the `TradeProposal` schema round-trips on each candidate before
  trusting it in a run — providers vary in JSON-schema strictness.
- Keep the model choice a **policy/setting** (per the existing model-picker surface) so the A/B is a
  config change, not a code change, and `proposedByModel` stamps each run correctly.

## 6. Caveats
- **Pricing/models change monthly** — re-verify before committing (sources below).
- **Reasoning tokens bill as output** on every provider here — a reasoning model's real per-run cost is
  higher than its sticker if it thinks a lot; the envelope in §2 already assumes reasoning output.
- **Non-US providers (DeepSeek, Qwen):** confirm ToS permits this use and that data handling fits your
  requirements before sending real portfolio context.

---

### Sources (July 2026)
- Anthropic: bundled `claude-api` model reference (Opus 4.8 $5/$25, Sonnet 5 $3/$15 intro $2/$10, Haiku 4.5 $1/$5, Fable 5 $10/$50).
- DeepSeek: [api-docs.deepseek.com/quick_start/pricing](https://api-docs.deepseek.com/quick_start/pricing)
- OpenAI: [model catalog](https://developers.openai.com/api/docs/models),
  [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
  [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra),
  [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), and
  [pricing](https://developers.openai.com/api/docs/pricing)
- Google Gemini: [ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing)
- xAI Grok: [x.ai/api](https://x.ai/api)
- Alibaba Qwen: [alibabacloud.com/help/en/model-studio/billing-for-model-studio](https://www.alibabacloud.com/help/en/model-studio/billing-for-model-studio)
