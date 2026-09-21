#!/usr/bin/env node
/**
 * RESTORE VERIFICATION for the weekly R2 cold archive.
 *
 * An untested backup is a hypothesis, not a backup.  Everything else in this lane proves
 * that bytes were WRITTEN — `r2coldsnap:lastSuccess`, the health field, the audit rows, the
 * pre-upload `PRAGMA integrity_check`.  None of them proves the object in the bucket can be
 * turned back into a working database.  This script does the only thing that proves it:
 * download the newest `cold-snapshots/` object, gunzip it, open it with the same SQLite
 * driver production uses, integrity-check it, assert the tables holding trading state are
 * populated, then throw the copy away.
 *
 * Read-only against R2.  It has no DELETE path of any kind — not for the object it
 * verified, not for anything else.  The only file it removes is the scratch copy it made.
 *
 * Usage:
 *   node scripts/ops/verify-cold-snapshot-restore.mjs
 *   node scripts/ops/verify-cold-snapshot-restore.mjs --list           # inventory only
 *   node scripts/ops/verify-cold-snapshot-restore.mjs --key <objectKey>
 *   node scripts/ops/verify-cold-snapshot-restore.mjs --receipt /path/receipt.json
 *
 * Credentials come from the environment; never pass them on argv:
 *   AWS_R2_HISTORIC_BUCKET_NAME, AWS_R2_HISTORIC_ENDPOINT, AWS_R2_HISTORIC_REGION,
 *   AWS_R2_HISTORIC_ACCESS_KEY_ID, AWS_R2_HISTORIC_SECRET_ACCESS_KEY
 * Optional:
 *   RESTORE_DRILL_SCRATCH_DIR   where the scratch copy lands (default: os tmpdir)
 *   RESTORE_DRILL_TABLES        comma-separated tables to assert non-empty
 *
 * Exit codes:
 *   0  restore verified — the archive object IS restorable
 *   1  usage / missing credentials / unexpected error
 *   2  auth failure (403/AccessDenied)
 *   3  VERIFICATION FAILED — the archive object is NOT provably restorable
 *
 * Cadence and where the result is recorded: docs/backup-policy.md.
 */
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { pathToFileURL } from "node:url";

export const COLD_SNAPSHOT_PREFIX = "cold-snapshots/";
export const KEY_PATTERN = /^cold-snapshots\/app-\d{4}-\d{2}-\d{2}\.db(\.gz)?$/;

/** Same money-and-state tables the in-app pre-upload check asserts (r2-cold-snapshot.ts). */
export const DEFAULT_VERIFY_TABLES = [
  "audit_events",
  "trade_proposals",
  "portfolio_snapshots",
  "connected_accounts",
  "settings",
  "llm_usage",
];

const CONTROL_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 60 * 60_000; // a multi-GB object over a modest uplink

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/** Newest cold-snapshot key by the ISO date embedded in the name.  Ignores anything that
 *  is not a cold snapshot, so a stray object can never be selected as "the backup". */
export function newestSnapshotKey(keys) {
  const snapshots = keys.filter((k) => KEY_PATTERN.test(k)).sort();
  return snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
}

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

/**
 * Decide pass/fail from an integrity result plus row counts.
 * A well-formed but EMPTY database passes `integrity_check` and is worthless as a backup,
 * so a populated-table assertion is required alongside it — the same two-part contract the
 * in-app pre-upload check uses.
 */
export function assessRestore({ integrity, tables }) {
  const failures = [];
  if (integrity !== "ok") failures.push(`integrity_check=${integrity ?? "unknown"}`);
  const empty = Object.entries(tables ?? {})
    .filter(([, n]) => typeof n !== "number" || n <= 0)
    .map(([t]) => t);
  if (empty.length > 0) failures.push(`empty_or_missing_tables=${empty.join(",")}`);
  return { ok: failures.length === 0, failures };
}

export function isAccessDenied(status, body) {
  if (status === 401 || status === 403) return true;
  return /AccessDenied/i.test(String(body ?? ""));
}

// ── Minimal S3 SigV4 (same shape as src/lib/r2-cold-snapshot.ts) ─────────────

const sha256hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, s) => crypto.createHmac("sha256", key).update(s).digest();

function signedRequest(cfg, method, key, query) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const segments = key === null ? [cfg.bucket] : [cfg.bucket, ...key.split("/")];
  const canonicalUri = "/" + segments.map(encodeURIComponent).join("/");
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join("&");
  const payloadHash = sha256hex("");
  const canonicalHeaders = `host:${cfg.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac("AWS4" + cfg.secretAccessKey, dateStamp), cfg.region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return {
    url: `https://${cfg.host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`,
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
  };
}

function loadConfig(env, provider) {
  if (provider === "b2") {
    const bucket = env.AWS_S3_BUCKET_NAME?.trim() ?? "";
    const endpoint = env.AWS_S3_ENDPOINT?.trim() ?? "";
    const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim() ?? "";
    const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim() ?? "";
    if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) return null;
    return {
      bucket,
      host: endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
      region: env.AWS_REGION?.trim() || "auto",
      accessKeyId,
      secretAccessKey,
      provider
    };
  }
  const bucket = env.AWS_R2_HISTORIC_BUCKET_NAME?.trim() ?? "";
  const endpoint = env.AWS_R2_HISTORIC_ENDPOINT?.trim() ?? "";
  const accessKeyId = env.AWS_R2_HISTORIC_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = env.AWS_R2_HISTORIC_SECRET_ACCESS_KEY?.trim() ?? "";
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) return null;
  return {
    bucket,
    host: endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
    region: env.AWS_R2_HISTORIC_REGION?.trim() || "auto",
    accessKeyId,
    secretAccessKey,
    provider
  };
}

async function listKeys(cfg, prefix) {
  const objects = [];
  let continuation;
  for (let page = 0; page < 20; page++) {
    const query = { "list-type": "2", prefix };
    if (continuation) query["continuation-token"] = continuation;
    const { url, headers } = signedRequest(cfg, "GET", null, query);
    const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS) });
    const body = await res.text();
    if (!res.ok) {
      const err = new Error(`ListObjectsV2 HTTP ${res.status}`);
      err.exitCode = isAccessDenied(res.status, body) ? 2 : 1;
      throw err;
    }
    objects.push(...parseListObjectsV2(body));
    if (!/<IsTruncated>true<\/IsTruncated>/.test(body)) break;
    continuation = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(body)?.[1];
    if (!continuation) break;
  }
  return objects;
}

async function downloadAndDecompress(cfg, key, destPath) {
  const { url, headers } = signedRequest(cfg, "GET", key, {});
  const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) {
    const body = res.body ? await res.text() : "";
    const err = new Error(`GetObject HTTP ${res.status}`);
    err.exitCode = isAccessDenied(res.status, body) ? 2 : 1;
    throw err;
  }
  const source = Readable.fromWeb(res.body);
  // Gunzip in the STREAM, never to a second full-size file on disk: the raw DB is ~11 GB
  // and the box has 169 GB free but shares it with three apps' backups.
  const stages = key.endsWith(".gz")
    ? [source, createGunzip(), createWriteStream(destPath)]
    : [source, createWriteStream(destPath)];
  await pipeline(...stages);
}

/** Open the restored file with the SAME driver production uses and interrogate it. */
function inspectRestored(path, tables) {
  const require_ = createRequire(import.meta.url);
  let Database;
  try {
    Database = require_("better-sqlite3");
  } catch {
    const err = new Error("better-sqlite3 is not resolvable from this checkout — run `npm ci` first");
    err.exitCode = 1;
    throw err;
  }
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const rows = db.pragma("integrity_check");
    const integrity = Array.isArray(rows) && rows.length > 0 ? String(rows[0].integrity_check ?? rows[0]) : "unknown";
    const counts = {};
    for (const t of tables) {
      try {
        counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM "${t.replace(/"/g, '""')}"`).get().c;
      } catch {
        counts[t] = null;
      }
    }
    return { integrity, tables: counts };
  } finally {
    try { db.close(); } catch { /* closing a read-only handle cannot lose data */ }
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const cfg = loadConfig(env);
  if (!cfg) {
    console.error("Missing AWS_R2_HISTORIC_* credentials in the environment.");
    return 1;
  }

  const listOnly = argv.includes("--list");
  const keyArgIndex = argv.indexOf("--key");
  let requestedKey = null;
  if (keyArgIndex >= 0) {
    const raw = argv[keyArgIndex + 1];
    // A bare `--key` (final arg) or `--key --receipt` must not fall through to
    // "newest snapshot" — that silently verifies the wrong object.
    if (raw == null || raw === "" || raw.startsWith("-")) {
      console.error("Usage: verify-cold-snapshot-restore.mjs --key <cold-snapshots/...> [--receipt path]");
      return 2;
    }
    requestedKey = raw;
  }
  const receiptIndex = argv.indexOf("--receipt");
  const receiptPath = receiptIndex >= 0 ? argv[receiptIndex + 1] : null;
  const tables = (env.RESTORE_DRILL_TABLES ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const verifyTables = tables.length > 0 ? tables : DEFAULT_VERIFY_TABLES;

  const objects = await listKeys(cfg);
  const snapshots = objects.filter((o) => KEY_PATTERN.test(o.key));
  console.log(`cold-snapshots/ objects: ${snapshots.length}`);
  for (const o of snapshots) console.log(`  ${o.key}  ${o.size} bytes`);
  if (snapshots.length === 0) {
    console.error("FAIL: the cold archive is EMPTY — there is nothing to restore.");
    return 3;
  }
  if (snapshots.length === 1) {
    console.log("WARN: archive depth is ONE — this object IS the entire cold tier.");
  }
  if (listOnly) return 0;

  const key = requestedKey ?? newestSnapshotKey(snapshots.map((o) => o.key));
  const chosen = snapshots.find((o) => o.key === key);
  if (!chosen) {
    console.error(`FAIL: ${key} is not a cold-snapshot object in this bucket.`);
    return 1;
  }

  const scratchDir = env.RESTORE_DRILL_SCRATCH_DIR?.trim() || tmpdir();
  mkdirSync(scratchDir, { recursive: true });
  const scratch = join(scratchDir, `cold-restore-drill-${crypto.randomUUID()}.db`);

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let receipt;
  try {
    console.log(`Restoring ${key} -> ${scratch}`);
    await downloadAndDecompress(cfg, key, scratch);
    const restoredBytes = statSync(scratch).size;
    console.log(`Restored ${restoredBytes} bytes in ${Math.round((Date.now() - t0) / 1000)}s`);

    const inspected = inspectRestored(scratch, verifyTables);
    const verdict = assessRestore(inspected);
    receipt = {
      ok: verdict.ok,
      key,
      objectBytes: chosen.size,
      restoredBytes,
      integrity: inspected.integrity,
      tables: inspected.tables,
      failures: verdict.failures,
      archiveDepth: snapshots.length,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
    };
    console.log(JSON.stringify(receipt, null, 2));
    if (!verdict.ok) {
      console.error(`FAIL: restore verification failed — ${verdict.failures.join("; ")}`);
      return 3;
    }
    console.log(`PASS: ${key} is restorable (integrity ok, key tables populated).`);
    return 0;
  } finally {
    // The scratch copy always goes, pass or fail.  It is a full copy of live trading state.
    // Sidecars too: opening the file read-only still leaves `-shm`/`-wal` behind (observed on
    // the 2026-09-09 drill), and a stray sidecar next to a future scratch file is a real
    // corruption hazard, not just litter.
    for (const path of [scratch, `${scratch}-shm`, `${scratch}-wal`, `${scratch}-journal`]) {
      try { if (existsSync(path)) rmSync(path, { force: true }); } catch { /* best effort */ }
    }
    if (receiptPath && receipt) {
      try { writeFileSync(receiptPath, JSON.stringify(receipt) + "\n"); } catch { /* best effort */ }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`ERROR: ${err?.message ?? err}`);
      process.exit(err?.exitCode ?? 1);
    });
}
