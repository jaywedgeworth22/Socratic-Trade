// Pure-helper tests for the ops scripts landed in the 2026-09-23 MM held batch.
// We test the pure helpers directly (no Node spawn, no network) so the suite runs
// without a live B2 / litestream binary.

import { describe, it, expect } from "vitest";
import {
  newestSnapshotKey,
  parseListObjectsV2,
  assessRestore,
  isAccessDenied,
  DEFAULT_VERIFY_TABLES
} from "../scripts/ops/verify-b2-ltx-restore.mjs";
import {
  readPbxprojVersion,
  patchProjectYaml
} from "../scripts/ios-fleet/sync-project-yml.mjs";

describe("verify-b2-ltx-restore pure helpers", () => {
  it("DEFAULT_VERIFY_TABLES mirrors the R2 verifier (drift = fail-closed)", () => {
    expect(DEFAULT_VERIFY_TABLES).toEqual([
      "audit_events",
      "trade_proposals",
      "portfolio_snapshots",
      "connected_accounts",
      "settings",
      "llm_usage"
    ]);
  });

  it("newestSnapshotKey picks the latest base snapshot by lexicographic timestamp", () => {
    const keys = [
      "trading-live/app.db-2026-08-01T00-00-00Z.db",
      "trading-live/app.db-2026-09-15T03-00-00Z.db",
      "trading-live/app.db-2026-09-01T12-00-00Z.db",
      "trading-live/app.db-2026-09-20T03-00-00Z.db",
      "trading-live/app.db-2026-09-20T03-00-00Z.db.tmp", // never picked
      "trading-live/app.db.ltx/00000001.ltx", // never picked
      "trading-live/app.db-2026-09-20T03-00-00Z.db-shm", // not picked: not a .db
      "trading-live/app.db"
    ];
    expect(newestSnapshotKey(keys)).toBe("trading-live/app.db-2026-09-20T03-00-00Z.db");
  });

  it("newestSnapshotKey falls back to the bare prefix when no timestamped snapshots exist", () => {
    expect(newestSnapshotKey(["trading-live/app.db", "trading-live/app.db-shm"])).toBe("trading-live/app.db");
  });

  it("newestSnapshotKey returns null when nothing matches", () => {
    expect(newestSnapshotKey(["trading-live/notes/notes.db"])).toBeNull();
  });

  it("parseListObjectsV2 returns { key, size } for every Contents block", () => {
    const xml = `<?xml version="1.0"?>
      <ListBucketResult>
        <Contents><Key>trading-live/app.db</Key><Size>1024</Size></Contents>
        <Contents><Key>trading-live/app.db-2026-09-20T03-00-00Z.db</Key><Size>8589934592</Size></Contents>
        <Contents><Key>trading-live/app.db.ltx/00000001.ltx</Key><Size>4096</Size></Contents>
      </ListBucketResult>`;
    expect(parseListObjectsV2(xml)).toEqual([
      { key: "trading-live/app.db", size: 1024 },
      { key: "trading-live/app.db-2026-09-20T03-00-00Z.db", size: 8589934592 },
      { key: "trading-live/app.db.ltx/00000001.ltx", size: 4096 }
    ]);
  });

  it("assessRestore passes only when integrity is 'ok' AND every table is non-empty", () => {
    const tables = [
      { name: "audit_events", rowCount: 100 },
      { name: "trade_proposals", rowCount: 50 },
      { name: "portfolio_snapshots", rowCount: 200 }
    ];
    expect(assessRestore({ integrity: "ok", tables }).pass).toBe(true);

    const empty = [...tables, { name: "connected_accounts", rowCount: 0 }];
    expect(assessRestore({ integrity: "ok", tables: empty }).pass).toBe(false);
    expect(assessRestore({ integrity: "fail", tables }).pass).toBe(false);
  });

  it("isAccessDenied matches B2 + R2 403/401 signatures but not 404 or 500", () => {
    expect(isAccessDenied(403, "<Error><Code>InvalidAccessKeyId</Code></Error>")).toBe(true);
    expect(isAccessDenied(403, "<Error><Code>SignatureDoesNotMatch</Code></Error>")).toBe(true);
    expect(isAccessDenied(401, "Unauthorized")).toBe(true);
    // 404 / 500 are NEVER auth failures — auth-failure gating only fires on 401/403.
    expect(isAccessDenied(404, "<Error><Code>NoSuchKey</Code></Error>")).toBe(false);
    expect(isAccessDenied(404, "<Error><Code>AccessDenied</Code></Error>")).toBe(false);
    expect(isAccessDenied(500, "<Error><Code>InternalError</Code></Error>")).toBe(false);
    expect(isAccessDenied(200, "ok")).toBe(false);
  });
});

describe("sync-project-yml pure helpers", () => {
  const SAMPLE = `options:
  bundleIdPrefix: trade.socratic
  deploymentTarget:
    iOS: "16.0"
configs:
  Debug: debug
  Release: release
settings:
  base:
    SWIFT_VERSION: "5.10"
    MARKETING_VERSION: "1.0.7"
    CURRENT_PROJECT_VERSION: "202608010000"
    INFOPLIST_KEY_CFBundleDisplayName: "Socratic Trade"
targets:
  SocraticTrade:
    type: application
`;

  it("readPbxprojVersion pulls both keys in one pass", () => {
    const pbx = `buildSettings = { MARKETING_VERSION = "1.0.8"; CURRENT_PROJECT_VERSION = "202608132022"; };`;
    expect(readPbxprojVersion(pbx)).toEqual({ marketing: "1.0.8", build: "202608132022" });
  });

  it("readPbxprojVersion tolerates unquoted values", () => {
    const pbx = `MARKETING_VERSION = 1.0.8; CURRENT_PROJECT_VERSION = 202608132022;`;
    expect(readPbxprojVersion(pbx)).toEqual({ marketing: "1.0.8", build: "202608132022" });
  });

  it("patchProjectYaml updates both fields and preserves indentation + trailing whitespace", () => {
    const { text, found } = patchProjectYaml(SAMPLE, "1.0.8", "202608132022");
    expect(found.marketing).toBe(true);
    expect(found.build).toBe(true);
    expect(text).toContain('MARKETING_VERSION: "1.0.8"');
    expect(text).toContain('CURRENT_PROJECT_VERSION: "202608132022"');
    // Indentation + neighbors preserved.
    expect(text).toContain('    SWIFT_VERSION: "5.10"\n');
    expect(text).toContain('    INFOPLIST_KEY_CFBundleDisplayName: "Socratic Trade"');
  });

  it("patchProjectYaml reports which keys were found when only one is updated", () => {
    const no = SAMPLE.replace(/^\s*CURRENT_PROJECT_VERSION:.*$/m, "");
    const { text, found } = patchProjectYaml(no, "1.0.9");
    expect(found.marketing).toBe(true);
    expect(found.build).toBe(false);
    expect(text).toContain('MARKETING_VERSION: "1.0.9"');
    // build field was removed from the source and not restored.
    expect(text).not.toContain("CURRENT_PROJECT_VERSION");
  });

  it("patchProjectYaml is a no-op when both fields already match (idempotent)", () => {
    const { text, found } = patchProjectYaml(SAMPLE, "1.0.7", "202608010000");
    expect(found.marketing).toBe(true);
    expect(found.build).toBe(true);
    expect(text).toBe(SAMPLE);
  });
});
