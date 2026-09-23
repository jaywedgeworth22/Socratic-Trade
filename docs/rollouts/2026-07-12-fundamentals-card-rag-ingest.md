# Rollout Note: Fundamentals Profile Card RAG Ingest

## Summary
Added a deterministic **"Fundamentals Profile Card"** RAG ingestion pipeline to embed key corporate metrics (valuation ratios, growth rates, analyst consensus, margins) in the Pinecone vector index for each ticker, without requiring LLM passes.

## Why
This implements a hybrid RAG approach:
1. Hard numerical metrics/valuation data are pulled deterministically via our provider cascade (FMP/Yahoo/Finnhub) and embedded as a single key-facts profile card.
2. Large prose sections of the 10-K/10-Q are split into semantic chunks.
This prevents lookups from hallucinating financial data while allowing the model to query both structural corporate metrics and textual disclosures concurrently.

## Touched Files
- [src/lib/web-sources/sec-filings.ts](file:///Users/jay/Code/Socratic-Trade/src/lib/web-sources/sec-filings.ts)
- [test/sec-filings.test.ts](file:///Users/jay/Code/Socratic-Trade/test/sec-filings.test.ts)

## Verification
- Checked static analysis: `npx tsc --noEmit`
- Checked style guidelines: `npm run lint`
- Ran new unit tests: `npx vitest run test/sec-filings.test.ts` (all 36 tests passed)
