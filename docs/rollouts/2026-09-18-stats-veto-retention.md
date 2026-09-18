# 2026-09-18 — Red Team veto audit retention + efficacy scan ceiling

## Summary

- `src/lib/audit-prune.ts` gains `AUDIT_PRUNE_NEVER_PRUNED_KINDS` so the four Red Team veto / override audit kinds are permanently exempted from retention pruning.
- `src/lib/performance.ts` exports `RED_TEAM_EFFICACY_DEFAULT_AUDIT_LIMIT = 5000`; the route + dashboard import the constant instead of hardcoding 500.
- `app/console/components/model-stats-drawer.tsx` adds a trailing "Retired Models" group derived dynamically as `stats-model-ids MINUS catalog-ids`, with the pure helper `deriveRetiredModelIds` unit-tested.

## Why

- `getRedTeamEfficacy` rebuilds the lifetime Red Team veto scorecard (`Results > Red Team veto efficacy` card + Model Stats drawer reviewer column) from `audit_events.kind = 'proposal_rejected_by_red_team'` rows, plus the related override kinds. `audit-prune.ts` was deleting those rows on the default 90-day cadence because they were never on the 14-day observability list, so any account older than 90 days had already lost real veto history. Once fixed, lifetime rows accumulate without bound — the original 500-row ceiling on `getRedTeamEfficacy`'s audit-kind query would have re-introduced a silent truncation ceiling on a much longer history.
- `app/console/components/model-stats-drawer.tsx` was rendering only catalog-row models per picker; a future catalog cleanup would have silently hidden any model that had stats but was no longer a catalog row. The "Retired Models" trailing group makes that explicit.

## Files

- `app/api/llm-usage/model-stats/route.ts` — import the new `RED_TEAM_EFFICACY_DEFAULT_AUDIT_LIMIT` constant instead of hardcoding 500.
- `app/console/components/model-stats-drawer.tsx` — add `deriveRetiredModelIds`; render a trailing "Retired Models" `<ProviderRows>` group.
- `src/lib/audit-prune.ts` — add `AUDIT_PRUNE_NEVER_PRUNED_KINDS`; exempt the four kinds from the default 90-day prune.
- `src/lib/dashboard.ts` — import `RED_TEAM_EFFICACY_DEFAULT_AUDIT_LIMIT` instead of hardcoding 500.
- `src/lib/performance.ts` — export `RED_TEAM_EFFICACY_DEFAULT_AUDIT_LIMIT = 5000`; use it as the default for `getRedTeamEfficacy`.
- `test/audit-hygiene.test.ts` — assert the new "never-pruned" kinds are exempt from pruning.
- `test/model-stats-drawer.test.ts` — unit-test `deriveRetiredModelIds` for the catalog-cleanup, raw-id-forever, and partial-catalog cases.
- `test/performance.test.ts` — assert the new default audit-limit constant is what the route/dashboard use.

## Cross-lane note (NOT in this PR)

The `src/lib/model-identity.ts` and `test/model-identity.test.ts` portions of Claude's original `claude/stats-veto-retention` diff were **deliberately dropped** from this salvage:

- They added canonical entries for `minimax-m2.7`, `gpt-5.6-terra`, `muse-spark-1.3`, `muse-glimmer-30b`, `gpt-6-astra-pro` and `gpt-6-astra`.
- The parallel `cursor/model-catalog-cleanup` lane (PR #3414) removes the catalog rows for `minimax-m2.7` and `gpt-5.6-terra`.
- If both PRs landed, `canonicalModelId` would return retired slugs and the model-stats display path would re-introduce the very orphan canonicals the catalog cleanup deleted.

The model-identity canonicalisations need to be re-thought and re-submitted as their own follow-up once the catalog-cleanup merge sequence settles (likely: a separate `cursor/model-identity-followup` lane that ONLY adds `muse-spark-1.3`, `muse-glimmer-30b`, `gpt-6-astra-pro`, `gpt-6-astra` after both PRs are in, since those four survive the cleanup).

## Verification

- `npx tsc --noEmit` — 89 baseline lines, 89 with-diff lines; only a line-number shift in the pre-existing `model-stats-drawer.tsx` `lucide-react` declaration-file error. **Zero new errors caused by this diff.**
- Targeted vitest 55 / 55: `test/audit-hygiene.test.ts` + `test/performance.test.ts` + `test/model-stats-drawer.test.ts` (73.91s).
- Full suite + `next build` — runs in hosted CI.

## Follow-ups

- A `cursor/model-identity-followup` lane should land `canonicalModelId` entries for the four models that survive the cleanup (`muse-spark-1.3`, `muse-glimmer-30b`, `gpt-6-astra-pro`, `gpt-6-astra`).
- The audit-prune retention change is **permanent** for the four kinds above. Operators must NOT re-add them to the 14-day observability list or fold them back into the default bucket — both regressions would re-introduce the silent truncation.
- If the lifetime `proposal_rejected_by_red_team` table grows past the comfortable scan ceiling on a busy account, the operator can raise `RED_TEAM_EFFICACY_DEFAULT_AUDIT_LIMIT` rather than re-introducing a prune.

## Blockers

- None.

## Replaced Docs

- None.