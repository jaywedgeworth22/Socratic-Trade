# 2026-07-04 - RAG Sentry visibility and Pinecone hosted-model review

## Summary

Follow-up after PR #351 merged. RAG provider failures, missing keys, Pinecone metric checks, ingest
budget trips, Pinecone Write Unit budget trips, malformed embeddings, retrieval degradations, and
unexpected RAG catch-block failures now emit Sentry warning/error events when `SENTRY_DSN` is set.
Docs now explain how Pinecone-hosted NVIDIA/MSFT embedding options fit into the RAG stack.
Current Infisical runbooks now use the renamed project display name `Socratic-Trade` and slug
`socratic-trade`.

## Why

The owner asked for backend/RAG failures and quota issues to be visible in Sentry, not only buried in
activity feeds or admin tables. The owner also provided a fresh Pinecone account key, but the app should
not connect or spend that quota until the write fuses and observability paths are landed and verified.

## Decisions

- Use Sentry for incident visibility, not billing truth. Normal usage remains in app admin pages and
  API Usage Monitor; provider consoles remain the billing/quota source of truth.
- Emit precise provider-health Sentry events for Pinecone/Voyage failures with provider, operation,
  key source, and sanitized reason tags/context.
- Mark provider-health failures internally so catch blocks do not also emit duplicate generic Sentry
  incidents for the same provider outage.
- Treat Pinecone-hosted `llama-text-embed-v2` and `multilingual-e5-large` as benchmark candidates.
  Their Starter inference token allowances do not solve Pinecone database Write Unit exhaustion.
- Do not commit, log, or document the fresh Pinecone key value. Connect it only after this branch lands
  and conservative `RAG_PINECONE_*` fuses are active.
- Infisical project references should use display name `Socratic-Trade` and slug `socratic-trade`;
  the existing project UUID remains the stable identifier unless the project is recreated.

## Files

- `src/lib/vector-db.ts`
- `test/vector-db-backlog-c-integration.test.ts`
- `.env.example`
- `docs/ops-observability-security.md`
- `docs/deployment.md`
- `docs/prod-config-voyage.md`
- `docs/reviews/2026-07-03-rag-stack-options.md`
- `docs/rollouts/2026-07-03-console-rag-usage-safeguards.md`
- `docs/secrets.md`
- `scripts/infisical-prod-cutover.sh`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`

## Verification

- `npx vitest run test/vector-db-backlog-c-integration.test.ts test/sentry-inert.test.ts`
- `npx tsc --noEmit --pretty false`
- `npm run lint`
- `npx tsc --noEmit`
- `npm test`
- `npm run build`
- `git diff --check`
- `bash -n scripts/infisical-prod-cutover.sh`
- `pm2 restart trading-codex --update-env`

All checks pass locally. `npm run lint` exits with 0 errors and the existing warning backlog.

## Follow-ups

- After merge, connect the fresh Pinecone account through the secret manager, not through committed
  files, and create/use `socratic-trade` only with the daily WU fuse enabled.
- Add an offline retrieval benchmark for `voyage-finance-2`, Pinecone `llama-text-embed-v2`,
  Pinecone `multilingual-e5-large`, and a cheap OpenAI embedding baseline before migration.
