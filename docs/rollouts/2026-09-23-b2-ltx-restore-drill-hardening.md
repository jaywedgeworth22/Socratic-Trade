# 2026-09-23 — B2 LTX restore drill hardening (PR #3453 Codex round)

## 1. Context & Objective

PR #3453 (`minimax/held-batch-20260923`, the iOS partialData + B2 LTX restore drill + project.yml
sync held batch) added `scripts/ops/verify-b2-ltx-restore.mjs`, the restore drill for the LIVE
Backblaze B2 Litestream replica of the production database. Codex review of head `48831cf9`
raised four findings: three on the drill script and one on missing mandatory handoff records.
A restore drill that can silently pass on a broken backup is worse than no drill, so this round
fixes the script before the PR lands.

## 2. Changes Made

High-level: the drill now fails when the Litestream replay fails, never deletes an
operator-supplied scratch directory, and understands the actual Litestream 0.5.x replica layout
that production writes.

Exact files touched:

- `scripts/ops/verify-b2-ltx-restore.mjs` — the three code fixes below.
- `STATUS.md` — round entry (2026-09-23 INSTINCT).
- `PLAN.md` — round entry (no roadmap scope change).
- `docs/rollouts/2026-09-23-b2-ltx-restore-drill-hardening.md` — this note.

## 3. Decisions & Trade-offs

**(a) Replay failure now fails the drill.** Previously a `litestream restore` error was logged as
WARN and the drill could still exit 0 on the base snapshot alone — the exact false-green the
drill exists to prevent. `assessRestore` now takes `ltxApplied` (true/false when a replay was
requested, null under `--no-apply-ltx`); a requested replay that failed fails the verdict
(exit 3). `--no-apply-ltx` remains as the explicit, deliberately degraded snapshot-only check.

**(b) Scratch cleanup only removes what the script created.** The old `finally` ran
`rmSync(scratchRoot, { recursive: true })` even when `scratchRoot` came from
`RESTORE_DRILL_SCRATCH_DIR`, wiping an operator-supplied directory. Now only mkdtemp directories
the script itself created are removed; inside an operator-supplied directory only this run's own
files (the downloaded snapshot / restored db) are deleted.

**(c) REAL finding: the drill could never find a snapshot against the production replica.**
Production runs Litestream 0.5.12 (pinned, `scripts/coolify-prod-start.sh`; do-not-upgrade per
`docs/rollouts/2026-07-10-deploy-blocker-tcpmem-litestream.md`). Traced against the pinned
v0.5.12 source (github.com/benbjohnson/litestream, tag v0.5.12):

- A 0.5 replica holds NO standalone `.db` object. Keys are
  `<path>/<level:%04x>/<minTXID:%016x>-<maxTXID:%016x>.ltx` (s3/replica_client.go
  `OpenLTXFile`/`WriteLTXFile`); full snapshots are LTX files at level 0009
  (`SnapshotLevel = 9`, compaction_level.go) written every `snapshot.interval` (24h).
- `litestream restore` REQUIRES a positional DB path or replica URL
  (cmd/litestream/restore.go: `fs.NArg() == 0` → usage error) — the old invocation passed none.
- `-config -` does NOT read stdin: `OpenConfigFile` os.Open()s the path, so `-` fails with
  "config file not found" (cmd/litestream/main.go). The old invocation relied on stdin.

So the old code could neither locate a snapshot nor run a restore against the live replica. The
drill now detects the layout (`detectReplicaLayout` → "ltx" / "legacy" / "empty"). For an LTX
replica there is no snapshot file to download, so the Litestream binary IS the restore path:
`litestream restore -config <0600 tempfile> -o <scratch>/restored-ltx.db -force <scratch>/restored-ltx.db`
rebuilds the database straight from the replica, then the existing integrity_check + table
assertions run on the result. Under `--no-apply-ltx` the degraded check downloads the newest
snapshot-level (0009) object and verifies the `LTX1` file magic. The legacy
`<prefix>-<timestamp>.db` branch is retained for historic replica sets. The generated replica
config carries the B2 keys, so it is written mode 0600 into the scratch dir and deleted after
the run; it sets `force-path-style: true` to match litestream.coolify.yml (virtual-hosted style
is unreliable against B2).

Deliberately not done: no schema, config, or production-path changes; no test file added (repo
has no test for the sibling `verify-cold-snapshot-restore.mjs` either, and vitest excludes
`scripts/**/*.test.mjs` — CI runs those suites via explicit `node --test` lines, so adding one
would need a ci.yml change that is out of scope for this round).

## 4. Verification State

Commands run (offline, no real B2 credentials touched):

- `node --check scripts/ops/verify-b2-ltx-restore.mjs` — clean.
- `node test-drill.mjs` — an offline harness importing the script, stubbing `fetch` (ListObjectsV2
  XML + object GETs) and pointing `LITESTREAM_BIN` at a fake litestream: 8 scenario groups pass —
  (A) LTX happy path exit 0 with operator-scratch dir and sentinel file preserved and the run's
  own files + the 0600 creds config removed; (B) LTX replay failure exits 3 (finding a);
  (C) mkdtemp scratch dir removed; (D) `--no-apply-ltx` degraded check passes on the LTX1 magic
  without invoking litestream; (E) legacy layout happy path exit 0; (F) legacy replay failure
  exits 3; (G) empty replica exits 1; (H) `--key` without value / missing creds exit 1.
- Helper unit assertions in the same harness: `parseLtxKey`, `detectReplicaLayout`,
  `newestLtxSnapshotKey`, `newestSnapshotKey`, `assessRestore` (ltxApplied true/false/null).

The repo vitest suite was not re-run: vitest excludes `scripts/**/*.test.mjs`, nothing under
`src/**` imports this script, and no `src/**` file changed this round. The required CI `verify`
check re-runs on push and is the authoritative gate.

**The drill has never been run against real B2 credentials.** The first real run (correct S3
signing against the live bucket, real multi-GB download, real litestream binary) should be
watched.

## 5. Next Steps & Blockers

- Watch the first real drill run end-to-end (`scripts/infisical-run.mjs` wrapper per
  docs/backup-policy.md) and record the receipt per the policy's drill table.
- `docs/EFFORT-LOG.md` (~1.05 MB) exceeds the github.com web editor's 1 MB edit limit, so this
  round's ledger row could not be added through this lane; a seat with git push access should
  mirror the entry.
- Remaining PR #3453 watch items (per the merge-watch lane): whether CI `verify`/`verify-hosted`
  go green on the current head and whether Codex Autofix stays red (pre-existing, cause
  unconfirmed).

## 6. Zero-Code Findings

- Litestream 0.5.12 replica layout and restore CLI contract were traced from source (above) and
  are the basis for fix (c); no code change was needed to establish that finding (c) was real.
