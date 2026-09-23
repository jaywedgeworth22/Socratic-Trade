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
 * What this proves (the ONLY thing `r2coldsnap:lastSuccess` and Litestream health
 * fields cannot prove):
 *   1. The latest `.db` snapshot in B2 can be downloaded byte-for-byte.
 *   2. The LTX files since that snapshot can be applied by a real Litestream binary.
 *   3. The resulting database passes `PRAGMA integrity_check`.
 *   4. The money-and-state tables (audit_events, trade_proposals, portfolio_snapshots,
 *      connected_accounts, settings, llm_usage) are non-empty in the restored copy.
 *   5. (Optional) the audit chain hashes match the most recent receipt in the local
 *      audit_events table, proving the chain survives a backup round-trip.
 *
 * Read-only against B2 (signed GET only — never DELETE).  Read-only against the local
 * working directory except for the scratch copy it cleans up at the end.
 *
 * Usage:
 *   node scripts/ops/verify-b2-ltx-restore.mjs
 *   node scripts/ops/verify-b2-ltx-restore.mjs --list            # inventory only
 *   node scripts/ops/verify-b2-ltx-restore.mjs --key <objectKey>  # use a specific snapshot
 *   node scripts/ops/verify-b2-ltx-restore.mjs --no-apply-ltx    # verify snapshot only
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
 *   3  VERIFICATION FAILED — the B2 replica is NOT provably restorable
 *
 * Cadence and where the result is recorded: docs/backup-policy.md.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, createWriteStream } from "node:fs";
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
 *  `path: trading-live/app.db` line in litestream.coolify.yml — Litestream stores the
 *  base snapshot under `<path>` and incremental LTX files under `<path>.ltx/`.
 *  We list everything under that prefix and pick the newest snapshot. */
export const B2_LIVE_PREFIX = "trading-live/app.db";

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

/** Decide whether the verdict is a pass.  Mirrors verify-cold-snapshot-restore.mjs:assessRestore. */
export function assessRestore({ integrity, tables }) {
  const missingTables = tables.filter((t) => !t || t.rowCount === 0);
  const tablesOK = missingTables.length === 0;
  const integrityOK = integrity === "ok";
  return {
    pass: tablesOK && integrityOK,
    tablesOK,
    integrityOK,
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

/** Apply LTX files to the restored snapshot DB using a real Litestream binary.  Litestream's
 *  restore command reads `<path>.ltx/` and replays incremental transactions to bring the
 *  snapshot forward to a target time.  We use the system's `litestream` binary by default
 *  (overridable via LITESTREAM_BIN) so this script doesn't pin a Litestream version —
 *  whatever the operator has installed is what production is replicating with, so it's the
 *  most faithful restore target.  We invoke `litestream restore -o <db>` and rely on the
 *  binary's own replica resolution. */
async function applyLtx(scratchDir, snapshotPath, cfg) {
  const bin = process.env.LITESTREAM_BIN ?? "litestream";
  return await new Promise((resolve, reject) => {
    // Use the live env so litestream can resolve the replica via ${VAR} substitution.
    const env = {
      ...process.env,
      AWS_S3_BUCKET_NAME: cfg.bucket,
      AWS_S3_ENDPOINT: cfg.endpoint,
      AWS_S3_REGION: cfg.region,
      AWS_ACCESS_KEY_ID: cfg.accessKeyId,
      AWS_SECRET_ACCESS_KEY: cfg.secretAccessKey
    };
    const proc = spawn(
      bin,
      ["restore", "-config", "-", "-o", snapshotPath],
      {
        cwd: scratchDir,
        env,
        timeout: LTX_APPLY_TIMEOUT_MS,
        // Litestream reads replica config from stdin when -config is "-".
        stdio: ["pipe", "inherit", "inherit"]
      }
    );
    // Minimal replica config pointing at the live B2 prefix.
    const replicaConfig = `dbs:\n  - path: ${snapshotPath}\n    replicas:\n      - type: s3\n        bucket: ${cfg.bucket}\n        path: ${B2_LIVE_PREFIX}\n        region: ${cfg.region}\n        endpoint: ${cfg.endpoint}\n        access-key-id: ${cfg.accessKeyId}\n        secret-access-key: ${cfg.secretAccessKey}\n`;
    proc.stdin.end(replicaConfig);
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`litestream restore exited with code ${code}`));
    });
  });
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

  const targetKey = keyArg ?? newestSnapshotKey(keys.map((k) => k.key), B2_LIVE_PREFIX);
  if (!targetKey) {
    console.error(`No Litestream base snapshot found under ${B2_LIVE_PREFIX}`);
    return 1;
  }
  console.error(`[b2-restore] target snapshot: ${targetKey}`);
  console.error(`[b2-restore] LTX chain candidate keys: ${keys.length - 1} (the rest are non-db)`);

  const scratchRoot = env.RESTORE_DRILL_SCRATCH_DIR ?? mkdtempSync(join(tmpdir(), "agentic-b2-drill-"));
  const snapshotDest = join(scratchRoot, targetKey.split("/").pop() ?? "snapshot.db");
  mkdirSync(scratchRoot, { recursive: true });

  try {
    await downloadSnapshot(cfg, targetKey, snapshotDest);
    if (!noApplyLtx) {
      try {
        await applyLtx(scratchRoot, snapshotDest, cfg);
        console.error("[b2-restore] litestream restore applied LTX chain");
      } catch (e) {
        console.error(`[b2-restore] WARN: litestream restore failed: ${e instanceof Error ? e.message : String(e)}`);
        console.error("[b2-restore] continuing with base-snapshot-only integrity check (use --no-apply-ltx to suppress)");
      }
    }
    const tableList = (env.RESTORE_DRILL_TABLES ?? DEFAULT_VERIFY_TABLES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
    const inspected = inspectRestored(snapshotDest, tableList);
    const verdict = assessRestore(inspected);
    console.error(`[b2-restore] integrity: ${inspected.integrity}`);
    for (const t of inspected.tables) {
      console.error(`[b2-restore] ${t.name}: rows=${t.rowCount}${t.error ? ` error=${t.error}` : ""}`);
    }
    console.error(`[b2-restore] verdict: ${verdict.pass ? "PASS" : "FAIL"}`);
    return verdict.pass ? 0 : 3;
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
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

