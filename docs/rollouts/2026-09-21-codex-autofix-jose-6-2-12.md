# 2026-09-21 — Codex-autofix for the `jose` 6.2.9 → 6.2.12 bump (PR #3445)

## Context & Objective

Dependabot bumped `jose` 6.2.9 → 6.2.12 (PR #3445, branch `dependabot/npm_and_yarn/jose-6.2.12`,
commit `d0c43f5a`) — a three-release patch bump crossing `6.2.10`'s security-hardening batch,
`6.2.11`'s JWE refactor, and `6.2.12`'s JWS/JWE core simplification plus AES-GCM/JWKS performance
work.  Codex review (one thread, not outdated) flagged that the commit touched only `package.json`
and `package-lock.json`, leaving `STATUS.md` and the tracked `docs/EFFORT-LOG.md` unchanged, which
the repo's binding pre-commit protocol requires so the production snapshot and cross-agent ledger
stay current.  This round adds those handoff records so PR #3445 clears the review gate.

## Changes Made

- `STATUS.md` — dated snapshot entry for the bump and this round.
- `docs/EFFORT-LOG.md` — cross-agent ledger row for the bump.
- `PLAN.md` — scope note (no roadmap or timeline change).
- `docs/rollouts/2026-09-21-codex-autofix-jose-6-2-12.md` — this note.
- `package.json` / `package-lock.json` — the Dependabot commit `d0c43f5a` itself, authored by
  Dependabot and untouched by this lane.

The only code-adjacent work this round was verification, below; no product source was changed.

## Decisions & Trade-offs

- **Classified as a runtime dependency-only change, not a docs-only one.**  `jose` is a production
  `dependencies` entry and the lockfile moved with it, so the diff sits on the `watch_paths` runtime
  set.  Merging to `main` therefore triggers a production image build, subject to the weekday RTH
  latch (`HOTFIX=1` / `RTH_DEPLOY_OVERRIDE=1` to override during 09:30–16:00 ET).  The handoff
  records say runtime dependency-only for that reason; they do not claim "no runtime code changed".
- **Verified the two real `jose` call sites by probe rather than trusting the unit suite.**  The
  6.2.10 release shipped hardening — `jwt: enforce explicit verification policies`,
  `jwt: prevent replacing protected headers`, `jws: reject mixed payload encoding modes`.  The Apple
  sign-in route (`app/api/mobile/auth/apple/route.ts:27`) calls `jwtVerify` with `issuer` +
  `audience` and **no** `algorithms` option, and `test/apple-auth-route.test.ts` mocks `jose`
  wholesale (`vi.mock("jose", …)`), so the suite structurally cannot catch a behavior change there.
  Probed the installed 6.2.12 directly: an RS256 JWT verified against a JWKS with no `algorithms`
  option succeeds, and the HS256 subpath verify used by `src/lib/auth/session-token.ts:41`
  (`algorithms: ["HS256"]`) succeeds.  Subpath exports `jose/jwt/sign` and `jose/jwt/verify` still
  resolve in 6.2.12's `exports` map.  No behavioral break at either site.
- **Reverted an unrelated lockfile artifact.**  Running `npm install` on this seat stripped `libc`
  fields from hundreds of `package-lock.json` entries — an npm-version artifact of the local
  toolchain, not part of the Dependabot bump.  `package-lock.json` was restored to the Dependabot
  version so this round's diff stays limited to the handoff records plus the version bump itself.
- **No pushback on the doc-record finding.**  Recording the bump in `STATUS.md`,
  `docs/EFFORT-LOG.md`, and `PLAN.md` is harmless and consistent with the repo handoff protocol.

## Verification State

```bash
npm install             # deps present for the trio (node_modules/jose resolves to 6.2.12)
node ./jose-probe.mjs   # PASS — no-algorithms JWKS RS256 verify ok; HS256 subpath verify ok
npx tsc --noEmit        # PASS (exit 0)
npm test                # 8144 passed / 13 failed / 51 skipped (746 files) — failures are seat-env artifacts, see below
npm run build           # PASS (exit 0)
# Confirmation that the 13 failures are the seat env, not this bump:
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL \
    -u ANTHROPIC_CUSTOM_HEADERS -u ANTHROPIC_MODEL \
  npx vitest run test/llm-provider.test.ts test/chat-llm.test.ts \
                 test/framework-review.test.ts test/openrouter-credits.test.ts
                        # 4 files passed, 60/60 tests passed
```

The probe script was a temporary scratch file and is not part of the diff.

**On the 13 test failures.**  Every one is in the LLM key-routing family (`test/chat-llm.test.ts`,
`test/framework-review.test.ts`, `test/llm-provider.test.ts`, `test/openrouter-credits.test.ts`),
asserting on which provider a credential routes to.  This cloud seat injects `ANTHROPIC_API_KEY` /
`ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL`, which those tests read, so they resolve providers
differently than a clean CI runner.  Three independent facts establish these are not caused by this
bump:  (1) none of the four files references `jose` at all; (2) all 60 of their tests pass with the
seat's `ANTHROPIC_*` variables unset (command above); (3) this is the same failure class the
2026-09-07 codex-autofix round on PR #3178 documented on this runner.  The repo `verify` CI gate runs
without those secrets and is authoritative.

**Unrelated drift found and deliberately not fixed here.**  Running `npm test` rewrites
`ios/SocraticTradeTests/Fixtures/policy-contract.json`:  `test/policy-ios-contract-fixture.test.ts:82`
unconditionally regenerates the checked-in fixture from live `GET /api/policy` output.  The rewrite
flips `learningReviewModel` from `claude-fable-5` to `claude-fable-latest`, which is the real source
default at `src/lib/defaults.ts:91` — so the fixture on `main` (and the stale doc comment at
`src/lib/types.ts:1050` that still says "Default claude-fable-5") is genuinely out of sync with the
route.  That is a pre-existing repo inconsistency with nothing to do with a `jose` patch bump, so the
fixture was reverted out of this PR rather than smuggled in; it wants its own fix (regenerate the
fixture and correct the `types.ts` comment).

## Next Steps & Blockers

- Auto-merge (squash) lands PR #3445 once the repo `verify` gate passes and the Codex thread is
  resolved.  No further code action expected from this lane.
- Dependabot owns the branch (`maintainerCanModify: false`); this round pushes the handoff records
  onto `dependabot/npm_and_yarn/jose-6.2.12` directly.
