# Pinecone store-more vs condense-first

| Field | Value |
| --- | --- |
| Date | 2026-08-18 |
| Status | Report-only (no product-code change) |
| Author | Cursor (RAG architect / IR / ML-eval / trading-decision quality) |
| Branch | `cursor/pinecone-store-vs-condense-ce2b` |
| Tree | `main` at `cde3deee` plus ancestors |
| Question | Is more Pinecone storage better for Green/Red, or is condensing / extracting / consolidating the corpus the better way to make retrieval useful to the LLM? |

This is a read-only expert review.  It does **not** flip `RAG_PINECONE_WRITE_CLASS`, does **not** prune the live index, does **not** implement a condensation pipeline, does **not** charge Stripe, and does **not** buy FilingAPI Plus.  FilingAPI is unrelated: keep the lane, 401 soft-skip ([#2792](https://github.com/jaywedgeworth22/Socratic-Trade/pull/2792)).

Companion reports: tonight's RAG stack audit ([#2803](https://github.com/jaywedgeworth22/Socratic-Trade/pull/2803), `docs/audits/2026-08-17-rag-learning-recall.md`) and the approved writer-split design (`docs/designs/2026-08-16-proposer-corpus-storage.md` rev 3).

---

## 1. Recommended default (explicit)

**Hybrid.  Condense-first for the Pinecone operational index.  Store-more locally.**

| Layer | Policy |
| --- | --- |
| **Pinecone (what Green/Red retrieve)** | Processed proposer corpus: extractive highlights + form-aware signal sections + speaker-turn transcript slices.  Latest full call for high-interest names until transcript FTS exists.  Experience-memory / lessons stay full. |
| **Local (SQLite FTS, artifacts, `earningscalls_transcripts`)** | Full 10-K / 10-Q / transcript bodies.  This is the recall-recovery store, not the ANN haystack. |
| **Money path** | `retrieveContextDetailed` (cosine first) → local hydrate of winning pointers.  Do not pretend FTS is an equal sibling of Pinecone.  Do not score the fused eval harness as production. |
| **Existing live vectors** | Keep.  Do not prune.  Do not flip write-class until corpus-storage PR A (split writer) and PR B (money-path hydrate) are on `main`. |
| **New trial / Builder writes** | Do **not** spend remaining credit on more raw 10-K/Q body pages of names we already have.  Spend it on latest-first **breadth** of the processed keep-set, then deepen high-interest as processed corpus, plus the transcript full-body exception. |

**Store-more (raw 10-K/Q/transcripts in Pinecone) is not better for Green/Red decisions.**  The prompt already cannot consume a 900-chunk filing.  Extra ANN neighbors of Item 8 tables, exhibits, and signatures compete with the 8/1 slots and then lose to the 24k filings budget.  That is precision loss, not "more evidence."

**Condense-only (highlights in Pinecone, no local body, no hydrate) is also worse.**  Red cannot dissent on an unseen revolver footnote.  Chat "what does the 10-K say about X?" fails.  #2803 already notes transcripts have no lexical FTS backstop.

**Hybrid is the only shape that matches how proposers actually consume text** and how Builder storage actually works (10 GB hard cap, not unlimited).

Do not implement that pipeline in this PR.  Sequence remains A → B → Infisical flip.  Extractive `extractive-highlights-v2` stays unless a gold-set proves it misses catalysts that a bounded ingest LLM would catch (no such evidence today; no ingest-path LLM).

---

## 2. Owner facts this review uses

Owner, 2026-08-17 ~7:37pm CT:

- Pinecone **Standard Trial** (Jay's Services / Socratic project): **$230.44 of $300 remaining**, 12 days left (9/21 elapsed, ~$69.56 used).  Credit usage delayed up to an hour.
- He will **likely upgrade to Builder** around Aug 30.  Plan is **keep using Pinecone**, not prune-to-highlights or accept retrieval loss.
- Keep ingesting / using the trial now.  There is headroom.  Do not sit on credits.
- Existing daily WU fuse / trial-window pacing stay unless this review finds they are leaving useful retrieval on the table.

This **updates** Key Decision 1 in the 2026-08-16 design, which treated a free/Starter ~2 GB / ~250k-record snap as the default post-trial landing.  Builder is a different landing.  It is still **not** "unlimited raw 10-Ks."

Live Pinecone pricing (2026-08-18, pinecone.io/pricing):

| Plan | Storage | Write units | What happens at the cap |
| --- | --- | --- | --- |
| Starter | 2 GB | 2M / month | Blocked |
| **Builder ($20 flat)** | **10 GB** | **5M / month** | **Blocked — no overage** |
| Standard ($50 min) | Unlimited @ $0.33/GB-mo | Unlimited @ ~$4/M | Billed |

The current trial is Standard-shaped (usage-billed, $300 credits).  Builder after Aug 30 is **5× Starter storage and still finite**.  A fat latest-1k full-body pass at 900 chunks/filing is ~900k records and will race a 10 GB wall.  The processed keep-set (~60–80k records plus experience-memory plus latest high-interest transcripts) fits Builder with room for history on held names.

"Keep using Pinecone / do not prune-to-highlights" means: **do not delete the live full-body index and live on abstracts alone.**  It does **not** mean fill Builder with more raw bodies.  Those are different decisions.

---

## 3. How Green/Red actually see the corpus

Verified on this tree, not from intent.

### 3.1 Production retriever

Strategy and Coach call **`retrieveContextDetailed` only** (`src/lib/strategy.ts` ~1421–1433; `src/lib/chat/orchestrator.ts` ~566–580).  They do **not** call `retrieveFusedContext`.  `search-fusion.ts` is the eval/experimental stack.  #2803 finding R1: the golden harness scores the fused path.  Do not promote store-more from harness Recall@k.

Strategy retrieval shape (`strategy.ts` ~1380–1433):

- Deep = top-3 scan ∪ held → **k = 8**.
- Scout = other scan candidates → **k = 1**.
- Query is `deterministicFilingsRetrievalQuery` = `Significant financial events, SEC filings, and macro catalysts for $SYM` (`information-routing.ts:118–119`).
- `asOf` is `runAsOf = now`.  Production `VECTOR_ASOF_STRICT=on` therefore **does** bind on the money path.  Chat/desk still omit `asOf` (#2803 T2/T3) — a different honesty bug, not a storage argument.

`retrieveContextDetailed` (`vector-db.ts:6445+`):

- Returns `[]` **before any FTS** if Pinecone or the embed key is missing (`lookup_failed`).
- Dense cosine first.  `HYBRID_RETRIEVAL` defaults off.  Corpus-wide lexical is an add-on INNER JOIN of FTS to committed `chunk_occurrences` with `o.source IN ('sec-edgar','sec-8k')` (`corpus-wide-lexical.ts:322`).  **Transcripts have no lexical backstop.**
- Parent expansion defaults on and reads `parent_text` from **vector metadata**, not FTS.
- Rerank over-fetches (scout vs deep plans in `rerank-policy.ts`).  That helps a buried signal chunk reach the cross-encoder.  It does **not** put 900 body pages into the prompt.

### 3.2 The consumption bottleneck

Green and Red read a **bounded dossier**, then the same string again (no second retrieve):

| Gate | Cap | Code |
| --- | --- | --- |
| Retrieve slots | 8 deep / 1 scout | `strategy.ts:1390–1391` |
| Filings family (includes facts / Form 4 / 13F / ARK cards) | **24,000 characters / 6,000 tokens** | `strategy.ts:5204–5212` |
| Global prose | 48,000 / 12,000 | same |
| Parent expansion | 6,000 / chunk, 12,000 total | `vector-db.ts:539–544` |
| Extractive highlight | 8 × 1,800 chars, Jaccard 0.55 | `document-summarizer.ts:324–326` |

`orderChunksForProposer` already puts `document-summary` / `earnings-summary` / `*-brief` first (`proposer-format.ts:7–16`).  The assembler in the approved design would also suppress retrieved compact types when SQLite abstracts are inlined.

**Decision quality is a property of what survives these gates, not of how many vectors exist.**  A 933-chunk 10-K (`FTS_MIRROR_INCIDENT_CHUNKS`) cannot become 933 prompt tokens of useful dissent.  Eight raw body chunks at 1,800 chars are 14.4k on one deep name; three deep + twenty scout already blow the 24k family before cards.  That is why scout must stay a stub, not a full-highlight dump (design Key Decision 6).

### 3.3 What ingest writes today

Still one funnel for filings: `storeDocument(full body)` then FTS + abstract only after `documentComplete`.  8-K default is already the extractive `8k-brief`.  ROIC already honors a processed write class (`roicPineconeWriteClass` in `roic-transcripts.ts:165–176`): archive = local-only; latest high-interest = full-body (no transcript FTS); other latest/deepen = `earnings-summary` only.

`RAG_PINECONE_WRITE_CLASS` is **design-only**.  There is no `pinecone-write-class.ts` on `main`.  Do not flip an env the producers do not read.

#2803 I1 remains binding: `SecIngestWorker` can embed **raw HTML** while incremental EDGAR embeds parsed text.  Store-more through that worker makes the haystack worse, not better.  Do not enable the worker at scale until the document builder is unified.

---

## 4. Expert answers

### 4.1 RAG architect — why the operational index must be processed

The index is a **routing layer** to a 24k-character hose.  The right Pinecone record is one the generic catalyst query can rank into k=8 (deep) or k=1 (scout) **and** that still looks like a catalyst after `orderChunksForProposer`.

A full 10-K is a poor routing layer:

- Item 8 tables blow the 40,896-byte metadata soft cap and are a weak dense neighbor (design KD 7).
- Risk-factor boilerplate is near-duplicate across issuers.  Cosine on "significant financial events… for $SYM" prefers that template over a one-line going-concern change.
- `information-routing.ts` still *asks* for full `10-k` / `10-q` / `earnings-transcript` types, so body pages compete with the compact types the proposer sort is trying to surface.
- Completeness on `storeDocument` means you cannot keep "12 of 400" in one commit.  Until PR A splits the writer, stopping full-body upserts **darkens new names** (no ledger, no abstract, no FTS-joinable occurrences).  That is why we do not flip the knob in this PR.

The processed keep-set (abstract + ≤12 signal sections / 20k source chars per document) is sized to the retrieve+budget contract.  Latest-four-docs × 1,000 names ≈ 800k delivered WU and ~60k records.  That is a Builder-sized index, not a Standard-trial hangover.

Local-complete bodies stay.  Hydrate-from-pointer is how an obscure footnote returns **after** a highlight/section hit, without living in the ANN pool.  That is "do not accept retrieval loss" without "store every page as a vector."

### 4.2 IR — store-more vs condense as a ranking problem

Let *C* be the corpus, *k* the slot budget, *q* the catalyst query.

| Policy | Expected effect on Recall@k of **decision-relevant** evidence | Expected effect on Precision@k / nDCG@k |
| --- | --- | --- |
| Store-more raw bodies | Small gain on rare footnotes **if** they outrank boilerplate.  Often a loss: the relevant sentence is at dense rank 80+ and never reaches rerank's useful prefix on scout (k=1). | Down.  More near-duplicates, more Item 8 noise, more lost-in-the-middle after the 24k trim. |
| Condense-first (highlights + signal) | Recall of **catalysts** up, because the index prior matches the query.  Recall of **footnotes** down unless hydrate exists. | Up.  Scout k=1 becomes a summary instead of a random 10-K page. |
| Hybrid (this recommendation) | Catalyst recall of condense-first, plus footnote recall via local hydrate on a winning pointer.  Transcript exception keeps dense-only calls retrievable until FTS exists. | Matches the 8/1 + 24k contract. |

Classic IR result this stack already rediscovered in 2026-07-12 ("do not turn every filing byte into a vector") and then violated because the writer had no split.  BM25/FTS cannot rescue the violation: corpus-wide lexical requires a committed Pinecone occurrence, excludes transcripts, and the catalyst query OR-quoted is a boilerplate magnet (design Alternative D, rejected).

**Do not raise *k* to "use more storage."**  Deep k=8 already fights the 24k family once cards are in the same hose.  Raising k without shrinking chunk size or moving cards out of `ragContext` just truncates later, which `derivePromptRagConsumption` will honestly label `retrievedButNotConsumed`.

### 4.3 ML-eval — what to measure before anyone claims a win

Score **`retrieveContextDetailedWithStatus`**, same catalyst query, same 8/1 limits, same floors, `strictAsOf: true`.  That harness already exists (`scripts/eval/rag-production-eval.ts`).  Do not use `retrieveFusedContext` numbers as a merge gate (#2803 R1).

Three metrics, in this order.  None of them is "index record count" or "WU spent."

#### A. Recall@k on the production retriever

Gold labels are **provenance**, never `vectorId`: `source` + `accession` + `section` / `contentHash` (`ProductionRagGoldenCase` in `rag-production-eval.ts:20–41`).

Split populations.  One blended Recall@10 will hide the scout hole.

| Cell | *k* | Pass (after first baseline) | Fail |
| --- | --- | --- | --- |
| Deep names (held ∪ top-3), filings | 8, also report @3 | Recall@8 ≥ 0.70 | < 0.60 |
| Scout names | 1 | Recall@1 ≥ 0.35, **summary preferred** | < 0.20 or body-page win rate > summary |
| Transcripts, lexical-off | 8 | Report only until FTS join exists | Do not fail CI on transcript FTS |
| Document-summary / 8k-brief catalysts | 8 / 1 | Hit the compact type | Compact type absent while a 10-K page wins |

Hard negatives required: later 10-K of the same issuer, prior quarter, same-day 10-Q vs 8-K, other-quarter call (ROIC period-bind trap, #2803 S4).  `authoritativeAsOf` is source publication, never index time.

#2803 §5 case mix (n ≈ 80 production + 28–40 CI fixture) is the right gold-set.  Add two **ablation arms** this question needs, still read-only until A/B exist:

1. **Full-body index** (today's live vectors) vs **highlight+signal subset** of the same accessions (filter `doc_type` to compact + signal itemCodes).
2. **No-hydrate** vs **local hydrate** on the winning accession (PR B).  Hydrate must lift footnote Recall without dropping catalyst Precision@1 on scout.

If arm 1's highlight+signal subset **beats or ties** full-body on catalyst Recall@8 and **wins** scout Recall@1, store-more is falsified for this product.  If full-body wins footnote Recall@8 by a wide margin **and** those footnotes appear in `consumed` (next metric), hydrate is mandatory before any write-class flip — which is already the A → B gate.

#### B. Consumed-attribution (not retrieved-attribution)

`derivePromptRagConsumption` (`evidence-consumption.ts:200+`) is the only honest "the model saw this" receipt.  Retrieval can return candidates that containment or the 24k budget then drops (`strategy.ts:5225–5245`).  Those stay in `retrievedButNotConsumed` and must never enter usefulness / decision attribution.

Measure, on live strategy runs and on the production eval subset:

| Signal | Why |
| --- | --- |
| `consumed / retrieved` by `doc_type` | If 10-k body pages are retrieved but not consumed, they are storage without decision value. |
| `consumed` compact-type rate on scout | Scout k=1 should almost always consume a summary/brief, not a 10-K page. |
| `retrievedButNotConsumed` character mass | Diagnoses 24k overflow.  Store-more that increases this number is harmful. |
| Gold id ∈ `consumed` when the run used RAG | The only Recall that can change a Green/Red vote. |

Do not treat cosine or rerank score as consumed.

#### C. Lookahead Jaccard

`classifyRagEvidenceReplay` (`lookahead-audit.ts:535–647`) diffs persisted `used:true` candidate-pool ids against a strict-asOf replay of the same deterministic query.  Default `LOOKAHEAD_AUDIT_JACCARD_MIN = 0.5`.

This is a **PIT / stability** metric, not a quality metric.  Use it to refuse policies that make replay unverifiable or leak future chunks:

| Result | Meaning for this question |
| --- | --- |
| Jaccard ≥ 0.50 median, <10% of sample below | Condensed keep-set is stable enough to trust as-of. |
| `candidate_pool_not_persisted` | `RAG_PERSIST_CANDIDATE_POOL` off — Jaccard is unverifiable.  Turn the knob on before claiming store-more or condense changed lookahead. |
| `replay_corpus_empty` | Re-embed/prune turnover.  A prune-to-highlights without hydrate would spike this.  Another reason not to prune the live index. |
| `post_asof_chunk_in_decision_context` | Hard mismatch.  Storage policy is irrelevant until PIT is clean. |
| Jaccard collapse after a write-class change | The operational neighbor set moved.  Re-baseline; do not silently accept. |

Lookahead does **not** tell you whether Green made a better buy.  Pair it with consumed-attribution and (separately, already-built) source-ablation / usefulness receipts.

#### What not to use as a win

- Pinecone record count, GB, or WU spent.
- Fused-harness Recall@k.
- Coverage % against "already touched" tickers (#2803 I4 — denominator must be the 1k manifest).
- "The trial still has dollars, therefore more bodies."

### 4.4 Trading-decision quality — Green/Red, not Chat-as-librarian

Green proposes; Red attacks **the same** `retrievedFinancialContext`.  Decision quality here means: did the bounded dossier contain the clause that should have flipped size, side, or pass?

| Failure mode | Store-more raw | Condense-only | Hybrid |
| --- | --- | --- | --- |
| Scout name (k=1) gets a boilerplate 10-K page | Common | Rare if summaries exist | Rare; stub abstract is the slot |
| Deep name misses Item 1A / guidance | Possible (lost in 900) | Possible if scorer skipped it | Reserved 1A slot + section vectors |
| Red cannot cite an unseen footnote | Possible if it ranked in | **Systematic miss** | Hydrate after pointer |
| Cards + 8 raw chunks blow 24k; last names dropped | Yes | Less | Planned together |
| Transcript catalyst, no FTS | Dense-only; full body helps latest HI call | Summary may miss a Q&A turn | Summary + management + first N Q&A; latest HI full body until FTS |
| HTML-poisoned worker vectors | Makes it worse | Same poison if worker writes highlights from HTML | Same — fix I1 first |

Owner philosophy is harden **correctness**, not obedience.  A short abstract is a **receipt**, never a trade block (design KD 14).  Missing corpus must not halt Autopilot.

The decision-quality bet is: **higher Precision@k of consumed evidence** beats **higher index cardinality**.  That bet is testable with the three metrics above on held names the owner actually trades.  Until those numbers exist, the architecture prior (8/1 + 24k + generic catalyst query + no transcript FTS) is strong enough to refuse a raw-body Builder fill.

---

## 5. What Builder storage should be filled with

**Processed proposer corpus.  Not raw 10-K/Q bodies.**

### Fill (after A+B, or via producers that already can)

1. **Latest 10-K + latest 10-Q + latest 8-K brief + latest transcript summary** for the demand-first universe (`rankDemandFirstSymbols`).  `highlight+signal` (~200 delivered WU / document, ~800 WU / name for four docs).
2. **Deepen history** for `rankHighInterestSymbols` only, same class.  Extra 10-Qs, prior 10-K highlights, extra transcript summaries.
3. **Latest full transcript** for high-interest names until a transcript FTS mirror exists (`roicPineconeWriteClass` already does this).
4. **Experience-memory / coach-note / lesson.**  Full.  Do-not-touch.  Never summarize fills.
5. **Fundamentals cards** as short vectors if they already are.

### Do not fill Builder with

- Remaining 10-K/10-Q body (exhibits, signatures, certifications, Item 8 tables).
- 8-K full-body pages outside 2.02 / 5.02 / 1.01 / 8.01 (and only if that flag is on; default is already brief).
- Transcript history beyond latest, or latest full calls for **non**-high-interest names once `earnings-summary` + management + Q&A-tops exist.
- A "Pass C leftover" of fat full-body 10-Ks "because the trial still has $230."

Those pages belong in `document_chunks_fts` / `sec-artifacts` / `earningscalls_transcripts` for hydrate and a later filing sheet (design PR C).  They are not Green/Red ANN neighbors.

### If the owner stays on Standard instead of Builder

Storage stops being the hard cap; **WU and RU** become the bill, and the prompt bottleneck does not move.  Still write processed corpus.  Extra Standard dollars buy **more names and more history of the keep-set**, not more pages per filing.  Unlimited storage of unused neighbors is how the trial already spent ~$70 without filling scout k=1 with summaries.

### If the owner wants Builder *and* "no retrieval loss"

Keep the live full-body vectors (no prune).  Land A+B.  Flip **new** writes to `highlight+signal`.  Measure §4.3.  Only after hydrate is proven and Keep-set + leftover bodies still fit **10 GB** should anyone discuss a receipt-gated prune.  If leftover bodies plus keep-set will exceed 10 GB at the snap, the owner choices are: stay on Standard, prune with receipts, or accept Builder write-blocks.  This review does not pick a prune.  It refuses a silent raw-body top-up that makes the 10 GB snap worse.

---

## 6. WU fuse / trial pacing — are we leaving useful retrieval unused?

### 6.1 Math on tonight's owner numbers

Trial ends `2026-08-30T00:00:00.000Z` (`pinecone-trial-window.ts:18`).  List price used by the pacer is **$4 / 1M WU**.  Reserve **$45**.

| Quantity | Value |
| --- | --- |
| Remaining credit | $230.44 |
| Remaining WU | ≈ 57.6M |
| Remaining days (from 2026-08-18) | 12 |
| Paced daily | ≈ **4.80M WU/day** |
| Configured Infisical fuse | 2.5M (trial-sized, ≥ `PINECONE_TRIAL_DAILY_FUSE_HINT`) |
| Full-steam effective daily | `max(configured, paced)` = **≈ 4.80M** (`assessPineconeTrialWindow`, `:143–165`) |
| Finish phase | only when remaining ≤ $45 **and** paced ≤ configured |

The rolling-24h fuse **already reads the trial window** (`pineconeMaxWriteUnitsPerDay` at `vector-db.ts:593–595`).  Raising `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY` above 2.5M does **not** spend more trial credit.  The pacer is already the higher number.

Retrieval is never gated by this fuse.

### 6.2 Verdict on the fuse

**Keep the 2.5M configured fuse and the $45 reserve.  Do not raise them.**

They are **not** the reason credits sit unused.  Full-steam already lifts the effective cap to remaining/days (~4.8M).  The reserve exists because credit usage lags up to an hour and Builder/Standard after Aug 30 is not a signed contract yet.  Dumping the last $45 in one day buys more raw pages we will not want on a 10 GB Builder index.

**Do not sit on credits either.**  Run ingest at that effective paced rate.  Spend the ~57M remaining WU on:

1. Latest-universe **highlights + signal sections** (and 8-K briefs) for names that still lack them.
2. Latest **transcript summaries** universe-wide; **full latest call** for high-interest only.
3. High-interest deepen as processed corpus.
4. Abstracts for accessions that already have bodies but no current `extractive-highlights-v2` row (cheap, high scout-k=1 value).

Do **not** spend them on a fat latest-1k full-body 10-K pass.  Design already deleted Pass C.  A 1,000 × 900-chunk full-body wave is ~14M delivered WU and ~900k records — real trial spend that becomes a Builder storage hangover.

### 6.3 What *is* leaving useful retrieval unused

Not the 2.5M knob.  These are:

| Blocker | Why it wastes trial headroom *and* hurts Green/Red | Lane |
| --- | --- | --- |
| 15-WU local-MTD remainder clamp | Parks every real document while the card reads "used 0 of 15."  Deadlock, not a spent trial. | **[#2800](https://github.com/jaywedgeworth22/Socratic-Trade/pull/2800)** — land this; do not "fix" it by raising the 2.5M fuse |
| One-funnel writer | Cannot write cheap highlights without a complete full-body commit.  Latest-name coverage stays expensive. | Corpus-storage PR A (not this PR) |
| No money-path hydrate | Even a perfect highlight index would thin Green/Red if flipped today. | PR B |
| Worker HTML embed | More vectors of tags/XBRL (#2803 I1). | Parsed-text builder; worker stays off |
| Transcript lexical hole | Dense-only; fuse-skip of a call is unrecoverable | S1 after A/B; until then keep HI latest full-body |
| Completeness vs 1k manifest | Coverage looks healthier than universe fill (#2803 I4) | Admin denominator; do not celebrate WU |

If #2800 is not on `main` and ingest is still showing used-0 / skipped-large-doc, **that** is unused trial retrieval.  Fix the deadlock.  Do not raise the daily fuse.

### 6.4 After Aug 30

`maybeAdvisePineconeTrialRollback` snaps **write** knobs to 60k WU/day, 20k texts/day, 1.6M monthly (`pinecone-trial-window.ts:174–192`) unless `PINECONE_TRIAL_ENDS_AT=off`.  Builder actually allows **5M WU/month** (~167k/day if smoothed).  The 60k snap is the old Starter/free table.  When the owner picks Builder, an **ops** step should set daily/monthly knobs to Builder (5M/mo, no overage) rather than leave the free-tier snap in place.  That is not a reason to raise the fuse **during** the trial.  Storage still does not snap itself.

---

## 7. Constraints this review does not reopen

Already binding on `main` / #2803 / the design.  Repeated so a later agent cannot "fix storage" by violating them:

1. Do not flip `RAG_PINECONE_WRITE_CLASS` off `full-body` until PR A and PR B exist.  The env is unread on `main` today anyway.
2. Extractive highlights stay.  No ingest-path LLM.  No Infisical LLM runtime keys.
3. Production retrieve is `retrieveContextDetailed`.
4. Scout k=1 vs deep k=8.  Transcripts have no lexical FTS backstop.
5. `VECTOR_ASOF_STRICT` is on in prod when callers pass `asOf`.  Strategy does.  Chat/desk do not.
6. Do not prune the live index in this window.
7. Do not clone production onto a local machine beyond this cloud workspace.
8. FilingAPI: unrelated.  Keep #2792.  Do not charge Stripe.  Do not buy Plus.

---

## 8. What the next agent should do (not this PR)

1. Land **#2800** if writes are still remainder-deadlocked.  That unsticks trial ingest without touching the 2.5M fuse.
2. Keep latest-first + high-interest deepen **running** at the paced ~4.8M effective WU/day.  Prefer producers that already write highlights (ROIC `highlight-only`, 8-K brief, post-body `document-summary`).
3. Implement corpus-storage **PR A then PR B** (`docs/designs/2026-08-16-proposer-corpus-storage.md`).  Then flip the env.  This audit does not replace that design; it re-answers the storage question now that Builder is the likely landing.
4. Stand up the §4.3 eval on `retrieveContextDetailed` (merge-gate once n≥50 and a baseline exists).  #2803 R1.
5. Measure live Pinecone **record count / GB** from `/api/admin/rag-coverage` + the console before anyone talks prune or Builder snap.  Do not guess.
6. Owner ops at trial end: Builder ($20 / 10 GB / 5M WU) vs stay on Standard.  If Builder, confirm the index is under 10 GB **or** stay on Standard.  Do not prune blindly.

Zero product code was changed in this audit.
