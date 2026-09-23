# Socratic primary-account Infisical bridge writer

## Summary

Added the production-inert writer half of API Usage Monitor PR #286's isolated
primary-account credential bridge. It is default-off and cannot write until a
dedicated writer identity pair is explicitly configured.

The source is fixed to Socratic-Trade's `LOCAL_USER` (`local`, the primary
`mail@jays.services` account). Only stored `gemini` and `deepseek` API-key rows
are eligible. The destination is fixed to the Socratic-Trade Infisical project,
`prod`, and `/usage-monitor/st-primary/v1`; neither a request nor environment
configuration can select another user, provider, project, environment, path, or
origin.

## Protocol and safety decisions

- The complete set is exactly `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, and strict
  `BRIDGE_MANIFEST_V1`.
- The manifest matches the reader's schema: source
  `socratic-trade-primary`, positive monotonic sequence, two exact entries,
  active/revoked status, and raw SHA-256 fingerprints only.
- Active values are written and read-back-verified before the manifest is
  written last. An interrupted value phase leaves the reader on its prior
  last-known-good generation.
- Revocation is a manifest tombstone with a null fingerprint. The writer never
  deletes remote secrets, so its identity needs only exact-path
  read/readValue/create/edit privileges.
- A persisted local sequence watermark prevents reuse after a remote rollback.
  Strict remote parsing, duplicate-member rejection, an unexpected-secret
  fence, and a final generation re-read reject malformed, replayed, mixed, or
  concurrent state.
- Universal Auth responses and secret API responses are bounded through body
  consumption, and redirects are rejected so credential-bearing POST/PATCH
  bodies cannot be forwarded. Errors expose
  only stable status codes; key values, access tokens, and identity secrets are
  never logged or returned.
- The single-leader scheduler uses a five-minute success cadence and one-minute
  retry cadence. Primary Gemini/DeepSeek key mutations queue a forced
  best-effort sync; a mutation arriving during a prior generation forces one
  serialized follow-up. Other users and providers do not.
- Final read-back verifies the manifest and every active value before recording
  local success, so a competing writer cannot produce a false successful mixed
  generation.

## Files

- `.env.example`
- `README.md`
- `app/api/keys/route.ts`
- `docs/EFFORT-LOG.md`
- `docs/secrets.md`
- `docs/rollouts/2026-07-15-st-primary-bridge-writer.md`
- `src/lib/scheduler.ts`
- `src/lib/st-primary-bridge-writer.ts`
- `test/st-primary-bridge-writer.test.ts`
- `STATUS.md`
- `PLAN.md`

## Verification

- `npm run lint` (passed: 0 errors; 488 pre-existing repository warnings)
- `npx tsc --noEmit` (passed)
- `npx vitest run test/st-primary-bridge-writer.test.ts test/request-user.test.ts test/scheduler-managed-vector-reconcile.test.ts test/background-worker-startup.test.ts`
  (4 files / 40 tests passed)
- `npm test` (382 files / 4,400 tests passed)
- `npm run build` (passed)
- `git diff --check` (passed)

The first production build exposed the scheduler bundle's incompatibility with
the `node:crypto` URI; the import was changed to the repository-standard
`crypto` form and the exact final ordered gate above passed. Hostile review's
four writer findings were fixed with dedicated regressions. A follow-up on the
same reviewer thread was unavailable due the agent thread limit; the root's
independent cross-repo review identified a reader-side contract blocker noted
below.

## Follow-ups

- Create two project-managed Infisical identities only after separate operator
  approval: delete-free exact-path writer for Socratic-Trade and read-only
  exact-path reader for API Usage Monitor.
- Configure both apps while their feature flags remain false, then enable the
  writer first, verify one complete generation, and enable the reader second.
- API Usage Monitor reader PR #293 is live and healthy at `c6c4c8f`; its fixed
  ST-primary bridge reads use `expandSecretReferences=false` while ordinary
  Infisical provider reads retain expansion. The writer's unexpanded-byte
  contract is therefore publication-compatible.
- Publish the writer through a ready PR, required hosted checks, protected
  merge, and automatic Coolify deployment observation while leaving the writer
  disabled and unconfigured.
- No identity, secret, Infisical path, production environment, browser session,
  deployment, or Usage Monitor runtime was mutated in this implementation lane.
