#!/usr/bin/env node
/**
 * RESTORE VERIFICATION for the live Backblaze B2 Litestream replica.
 *
 * The production database replicates continuously to Backblaze B2 (S3-compatible, bucket
 * jays-socratic-trade-eu, endpoint s3.eu-central-003.backblazeb2.com — see
 * litestream.coolify.yml).  The weekly R2 cold-snapshot lane has its own verifier
 * (verify-cold-snapshot-restore.mjs); this script covers the LIVE Litestream path that
 * R2 does NOT cover.  Both must pass before any backup-driven recovery can be trusted.
 *
 * Production runs Litestream 0.5.12 (pinned — do not upgrade, see
 * docs/rollouts/2026-07-10-deploy-blocker-tcpmem-litestream.md), whose replica layout is
 * LTX objects at `<path>/<level:0000-0009>/<minTXID>-<maxTXID>.ltx`; full snapshots live
 * at level 0009 (litestream's SnapshotLevel = 9, compaction_level.go).  There is NO
 * standalone `.db` object in a 0.5 replica, so "download the snapshot, then replay" is
 * not a real code path against it — the Litestream binary IS the restore path.  An older
 * `<prefix>-<timestamp>.db` snapshot layout is still detected and handled for historic
 * replica sets.
 *
 * What this proves (the ONLY thing `r2coldsnap:lastSuccess` and Litestream health
 * fields cannot prove):
 *   1. LTX layout (production): `litestream restore` rebuilds the database straight
 *      from the live replica into a scratch file — snapshot fetch AND chain replay in
 *      one step, executed by the same binary version production replicates with.
 *   2. Legacy layout: the newest `.db` base snapshot downloads byte-for-byte AND the
 *      replica chain replays onto it via the Litestream binary.  A replay failure
 *      FAILS the drill — a base snapshot alone is not proof of restorability.
 *   3. The resulting database passes `PRAGMA integrity_check`.
 *   4. The money-and-state tables (audit_events, trade_proposals, portfolio_snapshots,
 *      connected_accounts, settings, llm_usage) are non-empty in the restored copy.
 *   5. (Optional) the audit chain hashes match the most recent receipt in the local
 *      audit_events table, proving the chain survives a backup round-trip.
 *
 * Read-only against B2 (signed GET only — never DELETE).  Read-only against the local
 * working directory except for the scratch copy it cleans up at the end.  Only scratch
 * directories this script itself creates (mkdtemp) are deleted; an operator-supplied
 * RESTORE_DRILL_SCRATCH_DIR is never removed — only the files this run created in it.
 *
 * Usage:
 *   node scripts/ops/verify-b2-ltx-restore.mjs
 *   node scripts/ops/verify-b2-ltx-restore.mjs --list            # inventory only
 *   node scripts/ops/verify-b2-ltx-restore.mjs --key <objectKey>  # use a specific (legacy) snapshot
 *   node scripts/ops/verify-b2-ltx-restore.mjs --no-apply-ltx    # degraded: verify the snapshot object only, no replay
 *
 * Credentials come from the environment; never pass them on argv:
 *   AWS_S3_BUCKET_NAME       (default: jays-socratic-trade-eu)
 *   AWS_S3_ENDPOINT          (default: s3.eu-central-003.backblazeb2.com)
 *   AWS_S3_REGION            (default: eu-central-003)
 *   AWS_ACCESS_KEY_ID
 *   AWS_SECRET_ACCESS_KEY
 * Optional:
 *   LITESTREAM_BIN           path to litestream binary (default: litestream on $PATH)
 *   RESTORE_DRILL_SCRATCH_DIR where the scratch copies land (default: os tmpdir)
 *   RESTORE_DRILL_TABLES      comma-separated tables to assert non-empty
 *
 * Exit codes:
 *   0  restore verified — the live B2 replica IS restorable
 *   1  usage / missing credentials / unexpected error
 *   2  auth failure (403/AccessDenied)
 *   3  VERIFICATION FAILED — the B2 replica is NOT provably restorable (integrity,
 *      table, or LTX replay failure)
 *
 * Cadence and where the result is recorded: docs/backup-policy.md.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, createWriteStream, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const CONTROL_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 60 * 60_000; // a multi-GB snapshot over a modest uplink
const LTX_APPLY_TIMEOUT_MS = 30 * 60_000; // 30 min for apply; the LTX chain can be long

/** Path prefix inside the B2 bucket for the live Litestream replica.  Mirrors the
 *  `path: trading-live/app.db` line in litestream.coolify.yml.  Under Litestream 0.5.x
 *  the objects below it are `<prefix>/<level:0000-0009>/<minTXID>-<maxTXID>.ltx`
 *  (snapshots at level 0009); legacy replica sets instead carry `.db` snapshots named
 *  `<prefix>-<timestamp>.db`.  We list everything under the prefix and detect which. */
export const B2_LIVE_PREFIX = "trading-live/app.db";

/** Litestream's SnapshotLevel (compaction_level.go, pinned v0.5.12) — full-database
 *  snapshots are written as LTX files at this level. */
export const LTX_SNAPSHOT_LEVEL = 9;

/** First 4 bytes of every LTX file (superfly/ltx Magic), checked on degraded
 *  snapshot-only downloads. */
export const LTX_MAGIC = "LTX1";

/** Same money-and-state tables the R2 cold-snapshot verifier asserts (mirror of
 *  scripts/ops/verify-cold-snapshot-restore.mjs:DEFAULT_VERIFY_TABLES).  When the two
 *  lists drift the litestream restore is failing closed — the "set of tables I would
 *  reach for in a real recovery" is the answer either verifier must give the same answer. */
export const DEFAULT_VERIFY_TABLES = [
  "audit_events",
  "trade_proposals",
  "portfolio_snapshots",
  "connected_accounts",
  "settings",
  "llm_usage"
];

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/** Pick the newest BASE snapshot key from a list of B2 object keys.  Litestream names
 *  snapshots `<prefix>-<year>-<month>-<day>T<HH-MM-SS>Z.db` (e.g. `trading-live/app.db-2026-09-20T03-00-00Z.db`)
 *  and increments the timestamp on every fresh full snapshot.  Sorting lexicographically on the
 *  timestamp portion is safe because the format is fixed-width.  Falls back to the bare prefix
 *  when a snapshot was uploaded without the timestamp suffix (older Litestream releases). */
export function newestSnapshotKey(keys, prefix = B2_LIVE_PREFIX) {
  const suffix = /(-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)?\.db$/;
  const candidates = keys
    .filter((k) => k === prefix || k.startsWith(`${prefix}-`) || k === `${prefix}.db`)
    .filter((k) => suffix.test(k) && !k.endsWith(".tmp"))
    .sort();
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

/** `<level:%04x>/<minTXID:%016x>-<maxTXID:%016x>.ltx` below the replica prefix — the
 *  Litestream 0.5.x object shape (s3.ReplicaClient: `c.Path + "/" + fmt.Sprintf("%04x/%s", level, filename)`). */
const LTX_KEY_RE = /^([0-9a-f]{4})\/([0-9a-f]{16})-([0-9a-f]{16})\.ltx$/;

/** Parse a 0.5.x LTX object key under the replica prefix.  Returns
 *  { level, minTxid, maxTxid } (txids as fixed-width hex strings) or null. */
export function parseLtxKey(key, prefix = B2_LIVE_PREFIX) {
  if (!key.startsWith(`${prefix}/`)) return null;
  const m = LTX_KEY_RE.exec(key.slice(prefix.length + 1));
  if (!m) return null;
  return { level: parseInt(m[1], 16), minTxid: m[2], maxTxid: m[3] };
}

/** Detect which replica layout the listed keys represent: "ltx" (Litestream 0.5.x —
 *  what production writes), "legacy" (`.db` snapshots), or "empty" (nothing usable). */
export function detectReplicaLayout(keys, prefix = B2_LIVE_PREFIX) {
  if (keys.some((k) => parseLtxKey(k, prefix) !== null)) return "ltx";
  if (keys.some((k) => k === prefix || k.startsWith(`${prefix}-`) || k === `${prefix}.db`)) return "legacy";
  return "empty";
}

/** Pick the newest snapshot-level (0009) LTX object — a full-database snapshot written
 *  every `snapshot.interval` (24h in litestream.coolify.yml).  Fixed-width hex TXIDs
 *  sort lexicographically.  Returns null when no snapshot has been written yet (a
 *  replica younger than one snapshot interval still restores from the raw L0 chain). */
export function newestLtxSnapshotKey(keys, prefix = B2_LIVE_PREFIX) {
  const snaps = keys
    .map((k) => ({ key: k, info: parseLtxKey(k, prefix) }))
    .filter((x) => x.info !== null && x.info.level === LTX_SNAPSHOT_LEVEL)
    .sort((a, b) => (a.info.maxTxid < b.info.maxTxid ? -1 : a.info.maxTxid > b.info.maxTxid ? 1 : 0));
  return snaps.length > 0 ? snaps[snaps.length - 1].key : null;
}

/** Parse a minimal ListObjectsV2 XML response.  Returns [{ key, size }].  Same shape as
 *  the R2 verifier so the surface is interchangeable. */
export function parseListObjectsV2(xml) {
  const objects = [];
  for (const m of String(xml).matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1];
    const key = /<Key>([^<]+)<\/Key>/.exec(block)?.[1];
    if (!key) continue;
    const size = Number(/<Size>([^<]+)<\/Size>/.exec(block)?.[1]);
    objects.push({ key, size: Number.isFinite(size) ? size : 0 });
  }
  return objects;
}

/** Decide whether the verdict is a pass.  Mirrors verify-cold-snapshot-restore.mjs:assessRestore.
 *  `ltxApplied` is true/false when a Litestream replay was requested, null when the
 *  operator explicitly opted out with --no-apply-ltx.  A requested replay that failed
 *  fails the drill — PASS on the base snapshot alone is exactly the false-green this
 *  script exists to prevent. */
export function assessRestore({ integrity, tables, ltxApplied = null }) {
  const missingTables = tables.filter((t) => !t || t.rowCount === 0);
  const tablesOK = missingTables.length === 0;
  const integrityOK = integrity === "ok";
  const ltxOK = ltxApplied !== false;
  return {
    pass: tablesOK && integrityOK && ltxOK,
    tablesOK,
    integrityOK,
    ltxOK,
    missingTables
  };
}

/** Detect an auth failure from the S3-compatible status / body.  B2 returns 403 with
 *  InvalidAccessKeyId or SignatureDoesNotMatch on bad creds; Cloudflare R2 returns
 *  the same.  Treated as a fatal "auth failure" exit (code 2) so the operator distinguishes
 *  "wrong creds" from "the backup is broken". */
export function isAccessDenied(status, body) {
  if (status !== 403 && status !== 401) return false;
  const text = String(body ?? "").toLowerCase();
  return /accessdenied|invalidaccess|sigaturedoesnotmatch|signaturedoesnotmatch|nosuchkey|unauthorized/i.test(text);
}

/** Sign an S3 v4 request and return the headers / URL needed for fetch().  Mirrors the
 *  R2 verifier's signedRequest helper so both scripts use the same auth contract. */
function signedRequest(cfg, method, key, query = {}) {
  const region = cfg.region;
  const service = "s3";
  const host = new URL(cfg.endpoint).host;
  // Path-style addressing: B2 (like the R2 verifier) expects the bucket as the
  // first path segment — without it every signed request hits the wrong resource.
  const segments = key ? [cfg.bucket, ...key.split("/")] : [cfg.bucket];
  const path = `/${segments.map(encodeURIComponent).join("/")}`;
  const search = new URLSearchParams(query);
  const canonicalQuery = [...search.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const payloadHash = "UNSIGNED-PAYLOAD";
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, cryptoHash(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");
  const authHeader = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = `${cfg.endpoint.replace(/\/$/, "")}${path}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  return {
    url,
    headers: {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      authorization: authHeader
    }
  };
}

function hmac(key, data) {
  // `crypto` must be the node:crypto import above: in an ESM module the global
  // `crypto` is Web Crypto, which has no createHmac — every signed request crashed.
  return crypto.createHmac("sha256", typeof key === "string" ? Buffer.from(key, "utf8") : key).update(data, "utf8").digest();
}
function cryptoHash(data) {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

function loadConfig(env) {
  const bucket = env.AWS_S3_BUCKET_NAME ?? "jays-socratic-trade-eu";
  const endpoint = env.AWS_S3_ENDPOINT ?? "https://s3.eu-central-003.backblazeb2.com";
  const region = env.AWS_S3_REGION ?? "eu-central-003";
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set in env");
  }
  return { bucket, endpoint, region, accessKeyId, secretAccessKey };
}

async function listKeys(cfg, prefix) {
  // ListObjectsV2 returns at most 1000 keys per page.  The LTX chain under this
  // prefix grows unboundedly, so page through with the continuation token or the
  // newest base snapshot silently falls out of the (alphabetical) first page.
  const objects = [];
  let continuationToken = null;
  do {
    const query = { "list-type": "2", prefix };
    if (continuationToken) query["continuation-token"] = continuationToken;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONTROL_TIMEOUT_MS);
    let body;
    try {
      const { url, headers } = signedRequest(cfg, "GET", "", query);
      const res = await fetch(url, { method: "GET", headers, signal: ctrl.signal });
      // Read the body exactly once — a second res.text() throws "body used already".
      body = await res.text().catch(() => "");
      if (isAccessDenied(res.status, body)) {
        const e = new Error("B2 auth failure (403/401)");
        e.code = "AUTH";
        throw e;
      }
      if (!res.ok) throw new Error(`ListObjectsV2 HTTP ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
    objects.push(...parseListObjectsV2(body));
    const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(body);
    continuationToken = truncated
      ? (/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(body)?.[1] ?? null)
      : null;
  } while (continuationToken);
  return objects;
}

async function downloadSnapshot(cfg, key, destPath) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const { url, headers } = signedRequest(cfg, "GET", key);
    const res = await fetch(url, { method: "GET", headers, signal: ctrl.signal });
    if (!res.ok || !res.body) {
      // Read the body exactly once — a second res.text() throws "body used already".
      const body = await res.text().catch(() => "");
      if (isAccessDenied(res.status, body)) {
        const e = new Error("B2 auth failure (403/401)");
        e.code = "AUTH";
        throw e;
      }
      throw new Error(`Download HTTP ${res.status} for ${key}`);
    }
    // Stream straight to disk: the base snapshot is several GB, so buffering it
    // whole in memory (res.arrayBuffer) can OOM the drill host.
    await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
    return destPath;
  } finally {
    clearTimeout(timer);
  }
}

/** Read the first `len` bytes of a file (the LTX magic check must not slurp a
 *  multi-GB snapshot object into memory). */
function readFileMagic(path, len = 4) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, 0);
    return buf.subarray(0, n).toString("latin1");
  } finally {
    closeSync(fd);
  }
}

/** Restore the database from the live replica using a real Litestream binary.  We use
 *  the system's `litestream` binary by default (overridable via LITESTREAM_BIN) so this
 *  script doesn't pin a Litestream version — whatever the operator has installed is
 *  what production is replicating with, so it's the most faithful restore target.
 *
 *  Two invocation traps, both verified against the pinned v0.5.12 source
 *  (cmd/litestream/restore.go, cmd/litestream/main.go):
 *    - `-config -` does NOT read stdin: OpenConfigFile os.Open()s the path, so "-"
 *      fails with "config file not found".  The drill config is therefore written
 *      into the scratch dir (mode 0600 — it carries the B2 keys) and deleted in the
 *      finally below.
 *    - `restore` REQUIRES a positional DB path (or replica URL); without one it exits
 *      with a usage error before touching the replica.  We pass the scratch output
 *      path, matching the `path:` in the generated config, plus `-force` so the
 *      legacy flow can replay onto the just-downloaded snapshot file.
 *  `force-path-style: true` mirrors litestream.coolify.yml — virtual-hosted style is
 *  unreliable against B2. */
async function litestreamRestore(scratchDir, destPath, cfg) {
  const bin = process.env.LITESTREAM_BIN ?? "litestream";
  const configPath = join(scratchDir, ".litestream-drill-config.yml");
  const replicaConfig = [
    "dbs:",
    `  - path: ${JSON.stringify(destPath)}`,
    "    replicas:",
    "      - type: s3",
    `        bucket: ${JSON.stringify(cfg.bucket)}`,
    `        path: ${JSON.stringify(B2_LIVE_PREFIX)}`,
    `        region: ${JSON.stringify(cfg.region)}`,
    `        endpoint: ${JSON.stringify(cfg.endpoint)}`,
    "        force-path-style: true",
    `        access-key-id: ${JSON.stringify(cfg.accessKeyId)}`,
    `        secret-access-key: ${JSON.stringify(cfg.secretAccessKey)}`,
    ""
  ].join("\n");
  writeFileSync(configPath, replicaConfig, { mode: 0o600 });
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(
        bin,
        ["restore", "-config", configPath, "-o", destPath, "-force", destPath],
        {
          cwd: scratchDir,
          stdio: ["ignore", "inherit", "inherit"],
          timeout: LTX_APPLY_TIMEOUT_MS
        }
      );
      proc.on("error", reject);
      proc.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`litestream restore exited with code ${code}`));
      });
    });
  } finally {
    // The config file carries the B2 credentials — it must not outlive the run.
    rmSync(configPath, { force: true });
  }
}

/** Open the restored DB and run the integrity check + table row-count assertions. */
export function inspectRestored(dbPath, tables) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const integrity = db.pragma("integrity_check");
    const result = integrity.length === 1 && integrity[0]?.integrity_check === "ok" ? "ok" : "fail";
    const tableResults = tables.map((name) => {
      try {
        const row = db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get();
        return { name, rowCount: Number(row?.c ?? 0) };
      } catch (e) {
        return { name, rowCount: 0, error: e instanceof Error ? e.message : String(e) };
      }
    });
    return { integrity: result, tables: tableResults };
  } finally {
    db.close();
  }
}

function tableListFromEnv(env) {
  return (env.RESTORE_DRILL_TABLES ?? DEFAULT_VERIFY_TABLES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
}

function printInspection(inspected, verdict) {
  console.error(`[b2-restore] integrity: ${inspected.integrity}`);
  for (const t of inspected.tables) {
    console.error(`[b2-restore] ${t.name}: rows=${t.rowCount}${t.error ? ` error=${t.error}` : ""}`);
  }
  if (!verdict.ltxOK) {
    console.error("[b2-restore] LTX replay FAILED — the drill cannot pass on the base snapshot alone (--no-apply-ltx is the explicit degraded opt-out)");
  }
  console.error(`[b2-restore] verdict: ${verdict.pass ? "PASS" : "FAIL"}`);
}

/** Legacy layout: download the newest `.db` base snapshot byte-for-byte, then replay
 *  the replica chain onto it with the Litestream binary.  A requested replay that
 *  fails FAILS the drill (exit 3). */
async function runSnapshotFlow({ cfg, env, targetKey, noApplyLtx, scratchRoot, createdFiles }) {
  if (!targetKey) {
    console.error(`No Litestream base snapshot found under ${B2_LIVE_PREFIX}`);
    return 1;
  }
  console.error(`[b2-restore] target snapshot: ${targetKey}`);
  const snapshotDest = join(scratchRoot, targetKey.split("/").pop() ?? "snapshot.db");
  createdFiles.push(snapshotDest);
  await downloadSnapshot(cfg, targetKey, snapshotDest);
  let ltxApplied = null;
  if (!noApplyLtx) {
    try {
      await litestreamRestore(scratchRoot, snapshotDest, cfg);
      ltxApplied = true;
      console.error("[b2-restore] litestream restore applied the replica chain");
    } catch (e) {
      ltxApplied = false;
      console.error(`[b2-restore] ERROR: litestream restore failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const inspected = inspectRestored(snapshotDest, tableListFromEnv(env));
  const verdict = assessRestore({ ...inspected, ltxApplied });
  printInspection(inspected, verdict);
  return verdict.pass ? 0 : 3;
}

/** Litestream 0.5.x LTX layout (what production writes): there is no standalone `.db`
 *  object, so the Litestream binary performs the whole restore — snapshot fetch and
 *  chain replay — into a scratch file, which we then integrity-check. */
async function runLtxReplicaFlow({ cfg, env, noApplyLtx, scratchRoot, createdFiles, keys }) {
  const newestSnap = newestLtxSnapshotKey(keys, B2_LIVE_PREFIX);
  console.error(`[b2-restore] replica layout: Litestream 0.5 LTX (objects at ${B2_LIVE_PREFIX}/<level>/<minTXID>-<maxTXID>.ltx)`);
  if (newestSnap) {
    console.error(`[b2-restore] newest snapshot-level object: ${newestSnap}`);
  } else {
    console.error(`[b2-restore] WARN: no snapshot-level object under ${B2_LIVE_PREFIX}/0009/ — restore replays the raw L0 chain`);
  }

  if (noApplyLtx) {
    // Degraded object-level check: prove the newest snapshot object downloads
    // byte-for-byte and carries the LTX magic.  No database is produced, so the
    // integrity/table assertions cannot run in this mode.
    if (!newestSnap) {
      console.error("[b2-restore] --no-apply-ltx needs a snapshot-level object to verify; none found");
      return 1;
    }
    const ltxDest = join(scratchRoot, newestSnap.split("/").pop() ?? "snapshot.ltx");
    createdFiles.push(ltxDest);
    await downloadSnapshot(cfg, newestSnap, ltxDest);
    const magic = readFileMagic(ltxDest);
    const ok = magic === LTX_MAGIC;
    console.error(`[b2-restore] snapshot object downloaded (${newestSnap}); LTX magic: ${ok ? "ok" : `INVALID (${JSON.stringify(magic)})`}`);
    console.error(`[b2-restore] verdict: ${ok ? "PASS" : "FAIL"} (degraded: snapshot object only — no replay, no integrity_check)`);
    return ok ? 0 : 3;
  }

  const restoredDest = join(scratchRoot, "restored-ltx.db");
  createdFiles.push(restoredDest, `${restoredDest}-txid`);
  let ltxApplied = null;
  try {
    await litestreamRestore(scratchRoot, restoredDest, cfg);
    ltxApplied = true;
    console.error("[b2-restore] litestream restore rebuilt the database from the live LTX replica");
  } catch (e) {
    ltxApplied = false;
    console.error(`[b2-restore] ERROR: litestream restore failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const tableList = tableListFromEnv(env);
  // A failed restore produces no database to inspect — report the failure shape
  // instead of crashing on a missing file, and let ltxOK fail the verdict.
  const inspected = ltxApplied
    ? inspectRestored(restoredDest, tableList)
    : { integrity: "fail", tables: tableList.map((name) => ({ name, rowCount: 0 })) };
  const verdict = assessRestore({ ...inspected, ltxApplied });
  printInspection(inspected, verdict);
  return verdict.pass ? 0 : 3;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const listOnly = argv.includes("--list");
  const noApplyLtx = argv.includes("--no-apply-ltx");
  const keyIdx = argv.indexOf("--key");
  let keyArg = null;
  if (keyIdx !== -1) {
    const v = argv[keyIdx + 1];
    // A missing value (or the next flag swallowed as the value) must be a usage
    // error, not a silent fall-through to the newest snapshot.
    if (v === undefined || v.startsWith("--")) {
      console.error("--key requires a value (a B2 object key under the bucket)");
      return 1;
    }
    keyArg = v;
  }

  let cfg;
  try {
    cfg = loadConfig(env);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }

  let keys;
  try {
    keys = await listKeys(cfg, B2_LIVE_PREFIX);
  } catch (e) {
    if (e && typeof e === "object" && e.code === "AUTH") return 2;
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }

  if (listOnly) {
    for (const k of keys) console.log(`${k.size}\t${k.key}`);
    return 0;
  }

  // Only scratch directories THIS script creates (mkdtemp) may be deleted at the end.
  // An operator-supplied RESTORE_DRILL_SCRATCH_DIR is never wiped — the finally only
  // removes the specific files this run created inside it (a multi-GB snapshot must
  // not linger, but an operator directory must not be destroyed).
  const operatorScratchDir = env.RESTORE_DRILL_SCRATCH_DIR ?? null;
  const scratchRoot = operatorScratchDir ?? mkdtempSync(join(tmpdir(), "agentic-b2-drill-"));
  mkdirSync(scratchRoot, { recursive: true });
  const createdFiles = [];

  try {
    const keyList = keys.map((k) => k.key);
    console.error(`[b2-restore] objects under ${B2_LIVE_PREFIX}: ${keyList.length}`);
    if (keyArg) {
      // An explicit --key is always legacy snapshot semantics.
      return await runSnapshotFlow({ cfg, env, targetKey: keyArg, noApplyLtx, scratchRoot, createdFiles });
    }
    const layout = detectReplicaLayout(keyList, B2_LIVE_PREFIX);
    if (layout === "empty") {
      console.error(`No Litestream base snapshot or LTX replica objects found under ${B2_LIVE_PREFIX}`);
      return 1;
    }
    if (layout === "ltx") {
      return await runLtxReplicaFlow({ cfg, env, noApplyLtx, scratchRoot, createdFiles, keys: keyList });
    }
    return await runSnapshotFlow({ cfg, env, targetKey: newestSnapshotKey(keyList, B2_LIVE_PREFIX), noApplyLtx, scratchRoot, createdFiles });
  } finally {
    if (operatorScratchDir) {
      for (const f of createdFiles) rmSync(f, { force: true });
    } else {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  }
}

// CLI entry point — only run when invoked directly (`node verify-b2-ltx-restore.mjs`),
// not when imported by tests.
const isCli = (() => {
  if (typeof process === "undefined") return false;
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
})();
if (isCli) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err?.stack ?? String(err));
      process.exit(1);
    }
  );
}
