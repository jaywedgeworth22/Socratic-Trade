# Earnings RAG design

Date: 2026-07-03

Purpose: define how Socratic Trade should ingest earnings-related material without wasting Pinecone /
Voyage quota or turning LLM summaries into ungrounded trading facts.

## Recommendation

Use a three-layer model:

1. **Structured facts table** for numbers the strategy should compare and learn from.
2. **Raw evidence chunks** for source-grounded RAG retrieval.
3. **LLM-generated earnings brief** as a derived convenience layer, not the source of truth.

Do not only embed a one-paragraph LLM summary. That hides the data the agent must inspect later and
makes errors harder to trace. Do not embed full unfiltered transcripts repeatedly. That wastes quota
and buries the important deltas in boilerplate.

Current implementation: `src/lib/web-sources/fmp-transcripts.ts` is a separate producer for
`earnings-transcript` documents. It discovers fiscal periods through FMP's stable transcript-dates
endpoint and retrieves bodies through the stable transcript endpoint. It is deliberately
`WEB_SOURCE_FMP_TRANSCRIPTS=off` by default and also requires
`FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED=on`. FMP's paid Starter quota can be healthy while the
transcript endpoints return HTTP 402; FMP's current pricing places transcripts on Ultimate. A 402 is
recorded as `endpoint_not_entitled`, stops the run after one request, and does not poison ordinary FMP
endpoint health. Existing transcript chunks stay available to retrieval when future ingestion is
disabled only while storage/display rights remain confirmed. With rights unconfirmed, the shared
metadata filter excludes transcript chunks from broad Coach/chat retrieval as well as explicit
Strategy retrieval. Empty-corpus receipts mention transcripts only while both producer gates are on.

Timing is point-in-time safe: FMP's reported call date is stored as event/publication metadata, while
`acceptance_datetime` is the first time this app actually observed non-empty body content. The app does
not claim the transcript was available at call time. Empty/transient responses remain unrecorded in the
ingestion ledger and retry on the producer's independent cadence. Provider JSON has hard byte caps,
uses fatal UTF-8 decoding, and must match the endpoint-specific dates/body envelope before the one green
health/usage event. Embedded provider errors, invalid bytes, malformed JSON, and oversize responses write
one bounded redacted failure instead. The connector re-proves its durable shared RAG lease before each
provider, alert, or corpus boundary. If
period discovery consumes the final request slot, the symbol cursor does not advance, so that exact
ticker is retried before rotating. A transient body accession gets one next-run priority retry before
the cursor advances for universe fairness. Store errors, empty writes, incomplete writes, and invalid
embeddings use the same bounded fairness rule.
The body parser accepts both numeric `quarter` and FMP's documented strict `period: "Q1".."Q4"`
shape. Voyage document batches must have exact cardinality and either all valid unique request indices
or a fully positional response; ambiguous/malformed batches fail atomically before Pinecone. Raw SDK,
retry-backoff, bootstrap, and delayed alert aborts are lease loss, not provider degradation, and cannot
write failure ledgers after ownership changes. Guarded notifications, usage alerts, and Sentry capture
are awaited rather than detached. Chunk hashes remain derived only from content, but content identity is
not source-occurrence completion. `storeDocument` materializes a deterministic Pinecone record for every
ticker/accession/PIT occurrence; an exact bounded model/revision/text cache may reuse the embedding, never
the vector identity or metadata. `documentComplete` requires every vector upsert plus an atomic
`document_chunks`/`chunk_occurrences` receipt transaction, and source ledgers additionally require exact
`indexed === attempted` cardinality.

Provider request attempts now reserve durable request/cost capacity before the network boundary, mark
dispatch immediately around the actual fetch/SDK call, and settle to succeeded/failed independently of
the producer lease. Crash-left dispatched calls reconcile to `unknown`; an outbox projects deterministic
events through `usage-monitor-push.ts` and `usage-monitor-replay.ts`. Generic FMP enrichment and transcript
calls share this credential-wide ledger inside Socratic-Trade. Activation across multiple apps still
requires one genuinely shared transactional authority; assigning the same authority string to separate
SQLite databases is not sufficient. New `storeDocument` writes no longer have the content-dedup ghost-
vector defect; any corpus populated by the older shortcut should still be reconciled for legacy
occurrence/vector mismatches before it is trusted as complete.

Managed vectors use a two-phase receipt protocol: provider metadata starts `pending`, exact local
content/occurrence receipts commit atomically, provider metadata is promoted only after those receipts,
and the relational commit becomes queryable last. Pinecone filters exclude pending records and a local
receipt check rejects any managed result whose tenant, commit, version, content, source, accession,
section, ordinal, parser revision, or embedding revision differs. Operator tooling inventories Pinecone
itself (including receiptless ghosts), defaults rights cleanup to a bounded dry-run, deletes provider
records first, verifies zero provider residue, then removes exact local/observation/provenance-tagged
artifacts transactionally. Unattributable aggregate decisions are retained rather than guessed.

## Source priority

Highest confidence:
- SEC 8-K Item 2.02 earnings release, including exhibit 99.1 when available.
- 10-Q / 10-K MD&A and financial statements after filing.
- Company investor-relations earnings release PDF/HTML when it matches the SEC exhibit.

Useful with source/licensing caveats:
- Earnings-call transcript prepared remarks.
- Earnings-call Q&A.
- Investor deck / supplemental slides.

Lower confidence / should not be primary:
- News summaries and analyst recaps.
- Social posts.
- LLM summaries from another system unless their source citations are recoverable.

## Structured fields to extract

Identity / timing:
- `event_id`
- `symbol`
- `company_name`
- `fiscal_period`
- `fiscal_year`
- `reported_at`
- `accepted_at`
- `source_url`
- `accession`
- `source_type` (`sec-8k-2.02`, `earnings-release`, `10-q`, `transcript`, `slides`)
- `source_refs` for every extracted fact

Headline actuals:
- revenue, revenue growth YoY, revenue growth QoQ
- GAAP EPS, adjusted EPS, EPS surprise if consensus is available
- gross margin, operating margin, net margin
- operating income, net income, free cash flow
- cash, debt, net cash/debt

Guidance:
- next-quarter revenue guide low/high/mid
- full-year revenue guide low/high/mid
- EPS guide low/high/mid
- margin guide
- capex guide
- whether guidance was raised, lowered, initiated, withdrawn, or reaffirmed

Segment and driver data:
- segment revenue/growth
- geography or product-line growth when material
- backlog, bookings, RPO, ARR, subscriber/customer count, units shipped, same-store sales, or other
  industry-specific operating KPIs

Language and risk:
- management explanation of beat/miss
- demand tone
- pricing/margin tone
- inventory/channel tone
- macro/FX/rates/consumer tone
- one-time items
- risk flags and litigation/regulatory flags

Trading features:
- post-report price reaction window
- volume reaction
- gap size
- volatility regime
- whether the report changed an existing thesis tag

## What to embed

Embed raw source chunks with metadata:
- earnings-release headline + financial tables
- guidance paragraph/table
- segment results
- MD&A paragraphs that explain drivers
- risk/uncertainty paragraphs
- prepared remarks by topic
- Q&A exchanges, chunked by analyst question + full answer
- the derived earnings brief, but only after it includes source links and row-level citations

Do not embed:
- legal boilerplate safe-harbor text except one small chunk if it contains unusually specific risk
- full tables with no surrounding labels
- duplicated press release text from both company IR and SEC exhibit when the content hash matches
- every transcript sentence as separate tiny chunks

## LLM summarization policy

Use an LLM summarizer when the source is long or semi-structured:
- transcript Q&A
- large press-release tables
- 10-Q MD&A
- investor deck text

Do not use the LLM as the only extractor for numeric facts. Numeric facts should come from deterministic
parsing first when possible, then the LLM can classify, reconcile, and explain.

Recommended tier:
- Normal path: GPT-5.4 Mini at medium effort remains a deliberate lower-cost structured-extraction
  choice; it is cheaper than GPT-5.6 Luna and supports schema-constrained output.
- High-impact path: GPT-5.6 Terra at medium effort for consequential synthesis, escalating to Sol at
  high effort only for a current holding, large position-sizing decision, long/conflicting source
  set, or final adversarial review.
- Store the served model, prompt version, source chunk IDs, and extraction confidence.

## Summarizer prompt

System:

```text
You are an earnings-analysis extraction agent for Socratic Trade. Extract only facts supported by the
provided source text. Do not infer missing numbers. Do not use outside knowledge. Preserve uncertainty.
Return strict JSON matching the schema. Every non-empty claim must include source_chunk_ids.
```

User:

```text
Analyze this earnings source for trading decision support.

Company: {{company_name}}
Ticker: {{symbol}}
Source type: {{source_type}}
Accepted/published at: {{accepted_at}}
Fiscal period if known: {{fiscal_period}}

Source chunks:
{{chunks_with_ids}}

Return JSON:
{
  "symbol": "string",
  "event_id": "string",
  "period": "string|null",
  "reported_at": "string|null",
  "source_type": "string",
  "headline": {
    "summary": "string",
    "tone": "positive|mixed|negative|unclear",
    "source_chunk_ids": ["string"]
  },
  "actuals": [
    {
      "metric": "string",
      "value": "number|string|null",
      "unit": "usd|percent|shares|count|bps|text|null",
      "period": "string|null",
      "yoy_change": "number|null",
      "qoq_change": "number|null",
      "source_chunk_ids": ["string"],
      "confidence": "high|medium|low"
    }
  ],
  "guidance": [
    {
      "metric": "string",
      "range_low": "number|null",
      "range_high": "number|null",
      "midpoint": "number|null",
      "unit": "usd|percent|shares|count|bps|text|null",
      "period": "string|null",
      "change_vs_prior": "raised|lowered|reaffirmed|initiated|withdrawn|unclear",
      "source_chunk_ids": ["string"],
      "confidence": "high|medium|low"
    }
  ],
  "drivers": [
    {
      "topic": "string",
      "claim": "string",
      "impact": "bullish|bearish|mixed|neutral|unclear",
      "source_chunk_ids": ["string"]
    }
  ],
  "risks": [
    {
      "risk": "string",
      "severity": "high|medium|low|unclear",
      "source_chunk_ids": ["string"]
    }
  ],
  "questions_for_strategy": ["string"],
  "missing_or_ambiguous": ["string"]
}
```

## Safeguards

- Keep event/publication time separate from first-observed availability and always apply `asOf` filters
  in backtests. For FMP transcripts, first body observation is the PIT `acceptance_datetime`; the call
  date must never be substituted for availability.
- Content-hash every raw chunk and derived summary; never re-embed unchanged content.
- Keep raw chunk hashes content-derived and store ticker-period/document identity separately as
  occurrences. Never mutate a content digest to simulate occurrence identity.
- Store summary documents with `doc_type:"earnings-summary"` and raw source chunks with their true
  source doc types.
- Treat extracted numbers with `confidence:"low"` unless they are directly present in a table or
  deterministically parsed.
- Refuse to summarize if source chunks do not include source IDs.
- Never let a failed summarizer block raw chunk indexing.
- Keep a per-run cap on reports summarized and a daily WU cap before embedding.
- Benchmark retrieval on questions such as "what changed in guidance?", "why did margins move?", and
  "what risks did management emphasize?" before expanding the corpus.

## Deferred until entitled fixtures exist

The first producer stores source-faithful raw chunks. Speaker-turn/Q&A pairing and cited derived
earnings briefs remain intentionally deferred until the entitled endpoint can supply representative
fixtures. Implementing a speculative parser without those fixtures would risk mislabeling prepared
remarks as Q&A or separating an analyst question from management's answer. Before broad enablement,
add fixture-backed speaker/Q&A segmentation, deterministic numeric extraction, cited derived briefs,
and retrieval evaluation for guidance changes, margin drivers, and management-emphasized risks.
