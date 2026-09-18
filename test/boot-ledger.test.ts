import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BOOT_LEDGER_KEEP_LINES,
  BOOT_LEDGER_MAX_BYTES,
  assessRestartLoop,
  bootLedgerActive,
  bootLedgerPath,
  describeRestartLoop,
  noteExitReceipt,
  parseBootLedger,
  recordBoot,
  reportRestartLoop,
  resetBootLedgerForTests,
  type BootLedgerEntry
} from "../src/lib/boot-ledger";
import { installProcessExitGuard } from "../src/lib/exit-guard";

// reportRestartLoop reaches the admin alert through db-health; mock it so no test opens a real DB.
const alertMock = vi.hoisted(() => ({ alertStorageWarning: vi.fn(async () => {}) }));
vi.mock("../src/lib/db-health", () => ({ alertStorageWarning: alertMock.alertStorageWarning }));

const MIN = 60_000;
const T0 = Date.parse("2026-08-28T15:00:00.000Z");

function boot(id: string, atMs: number): BootLedgerEntry {
  return { v: 1, t: "boot", ts: new Date(atMs).toISOString(), bootId: id, pid: 1, node: "v24" };
}
function exit(id: string, atMs: number, code: number | null = 143, extra: Partial<BootLedgerEntry> = {}): BootLedgerEntry {
  return { v: 1, t: "exit", ts: new Date(atMs).toISOString(), bootId: id, pid: 1, code, uptimeSec: 10, ...extra } as BootLedgerEntry;
}

function fakeProc(env: Record<string, string | undefined>) {
  const emitter = new EventEmitter();
  const proc = Object.assign(emitter, { env, pid: 777, version: "v24.0.0" }) as unknown as NodeJS.Process;
  return proc;
}

describe("assessRestartLoop (pure)", () => {
  it("does not call a single boot, or two, a loop with the default threshold of 3", () => {
    const one = assessRestartLoop([boot("a", T0)], T0);
    expect(one.bootsInWindow).toBe(1);
    expect(one.restartLoop).toBe(false);
    const two = assessRestartLoop([boot("a", T0 - 10 * MIN), exit("a", T0 - 9 * MIN), boot("b", T0)], T0);
    expect(two.restartLoop).toBe(false);
  });

  it("flags the ~15-minute loop from 2026-08-28 on the third boot, and only counts the trailing window", () => {
    const entries = [
      boot("a", T0 - 90 * MIN), exit("a", T0 - 89 * MIN), // outside the 45 min window
      boot("b", T0 - 30 * MIN), exit("b", T0 - 29 * MIN),
      boot("c", T0 - 15 * MIN), exit("c", T0 - 14 * MIN),
      boot("d", T0)
    ];
    const a = assessRestartLoop(entries, T0);
    expect(a.bootsInWindow).toBe(3);
    expect(a.restartLoop).toBe(true);
    expect(a.prevUnclean).toBe(false);
    expect(a.lastExit?.bootId).toBe("c");
    expect(a.firstBootInWindowTs).toBe(new Date(T0 - 30 * MIN).toISOString());
  });

  it("treats a predecessor with no exit receipt as an unclean (killed) exit", () => {
    const entries = [boot("a", T0 - 20 * MIN), boot("b", T0 - 10 * MIN), boot("c", T0)];
    const a = assessRestartLoop(entries, T0);
    expect(a.prevUnclean).toBe(true);
    expect(a.uncleanPredecessorsInWindow).toBe(2);
    expect(a.lastExit).toBeNull();
    expect(a.restartLoop).toBe(true);
    expect(describeRestartLoop(a)).toMatch(/NO exit receipt/);
  });

  it("honours a custom window and threshold", () => {
    const entries = [boot("a", T0 - 5 * MIN), exit("a", T0 - 4 * MIN), boot("b", T0)];
    expect(assessRestartLoop(entries, T0, { threshold: 2, windowMinutes: 10 }).restartLoop).toBe(true);
    expect(assessRestartLoop(entries, T0, { threshold: 2, windowMinutes: 3 }).restartLoop).toBe(false);
  });

  it("describes the previous exit code, signal and uptime when a receipt exists", () => {
    const entries = [
      boot("a", T0 - 20 * MIN), exit("a", T0 - 19 * MIN, 143, { signal: "SIGTERM", uptimeSec: 60 }),
      boot("b", T0 - 10 * MIN), exit("b", T0 - 9 * MIN, 143, { signal: "SIGTERM", uptimeSec: 61 }),
      boot("c", T0)
    ];
    const text = describeRestartLoop(assessRestartLoop(entries, T0));
    expect(text).toMatch(/3 boots in the last 45 minutes/);
    expect(text).toMatch(/exited 143 after SIGTERM after 61s/);
  });
});

describe("parseBootLedger", () => {
  it("skips torn and foreign lines instead of throwing", () => {
    const good = JSON.stringify(boot("a", T0));
    const text = [good, "{\"t\":\"boot\",\"ts\":", "not json", JSON.stringify({ t: "other", ts: "x", bootId: "z" }), "", good].join("\n");
    expect(parseBootLedger(text)).toHaveLength(2);
  });
});

describe("bootLedgerActive / bootLedgerPath", () => {
  it("is production-only by default, with on/off overrides", () => {
    expect(bootLedgerActive(fakeProc({ NODE_ENV: "test" }))).toBe(false);
    expect(bootLedgerActive(fakeProc({ NODE_ENV: "production" }))).toBe(true);
    expect(bootLedgerActive(fakeProc({ NODE_ENV: "production", BOOT_LEDGER: "off" }))).toBe(false);
    expect(bootLedgerActive(fakeProc({ NODE_ENV: "test", BOOT_LEDGER: "on" }))).toBe(true);
  });

  it("lives beside the SQLite DB on the persistent volume", () => {
    expect(bootLedgerPath({ DATABASE_URL: "file:/app/data/app.db" })).toBe("/app/data/boot-ledger.jsonl");
    expect(bootLedgerPath({ DATABASE_URL: "file:/app/data/app.db", BOOT_LEDGER_PATH: "/x/y.jsonl" })).toBe("/x/y.jsonl");
  });
});

describe("recordBoot", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    resetBootLedgerForTests();
    dir = mkdtempSync(join(tmpdir(), "boot-ledger-"));
    path = join(dir, "nested", "boot-ledger.jsonl");
  });
  afterEach(() => {
    resetBootLedgerForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op (and writes nothing) outside production", () => {
    const proc = fakeProc({ NODE_ENV: "test" });
    expect(recordBoot({ proc, path })).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it("appends a boot line, creating the directory, and an exit receipt with code + call site", () => {
    let clock = T0;
    const proc = fakeProc({ NODE_ENV: "production", SOURCE_COMMIT: "abcdef0123456789" });
    const a = recordBoot({ proc, path, now: () => clock });
    expect(a?.bootsInWindow).toBe(1);
    expect(a?.restartLoop).toBe(false);

    noteExitReceipt({ code: 43, callSite: "at somewhere (x.ts:1)" });
    clock = T0 + 90_000;
    proc.emit("exit", 43);

    const entries = parseBootLedger(readFileSync(path, "utf8"));
    expect(entries.map((e) => e.t)).toEqual(["boot", "exit"]);
    const boot0 = entries[0];
    const exit0 = entries[1];
    expect(boot0.t === "boot" && boot0.release).toBe("abcdef012345");
    expect(exit0.t === "exit" && exit0.code).toBe(43);
    expect(exit0.t === "exit" && exit0.uptimeSec).toBe(90);
    expect(exit0.t === "exit" && exit0.callSite).toContain("somewhere");
    expect(exit0.bootId).toBe(boot0.bootId);
  });

  it("writes the exit receipt only once even if 'exit' fires twice", () => {
    const proc = fakeProc({ NODE_ENV: "production" });
    recordBoot({ proc, path });
    proc.emit("exit", 1);
    proc.emit("exit", 1);
    expect(parseBootLedger(readFileSync(path, "utf8")).filter((e) => e.t === "exit")).toHaveLength(1);
  });

  it("detects the loop across simulated container restarts sharing one volume", () => {
    const results: Array<ReturnType<typeof recordBoot>> = [];
    for (let i = 0; i < 3; i++) {
      resetBootLedgerForTests(); // a new container = a new process
      const proc = fakeProc({ NODE_ENV: "production" });
      results.push(recordBoot({ proc, path, now: () => T0 + i * 15 * MIN }));
      // Boot 2 (index 1) is SIGKILLed: no exit receipt.  The others exit cleanly.
      if (i !== 1) proc.emit("exit", 143);
    }
    expect(results.map((r) => r?.restartLoop)).toEqual([false, false, true]);
    // Boot 3's predecessor (boot 2) was killed without a receipt.
    expect(results[2]?.prevUnclean).toBe(true);
    expect(results[2]?.bootsInWindow).toBe(3);
  });

  it("is idempotent per process and honours env-tuned thresholds", () => {
    const proc = fakeProc({ NODE_ENV: "production", RESTART_LOOP_BOOT_THRESHOLD: "2", RESTART_LOOP_WINDOW_MINUTES: "5" });
    expect(recordBoot({ proc, path, now: () => T0 })?.restartLoop).toBe(false);
    expect(recordBoot({ proc, path, now: () => T0 })).toBeNull();
    resetBootLedgerForTests();
    expect(recordBoot({ proc: fakeProc({ NODE_ENV: "production", RESTART_LOOP_BOOT_THRESHOLD: "2", RESTART_LOOP_WINDOW_MINUTES: "5" }), path, now: () => T0 + MIN })?.restartLoop).toBe(true);
  });

  it("trims an oversized ledger to the newest lines", () => {
    const filler = JSON.stringify(boot("x", T0 - 999 * MIN));
    const lines = Math.ceil(BOOT_LEDGER_MAX_BYTES / (filler.length + 1)) + 50;
    const dirPath = join(dir, "big");
    const bigPath = join(dirPath, "boot-ledger.jsonl");
    // create the directory through a first recordBoot on a scratch path, then overwrite with bulk
    recordBoot({ proc: fakeProc({ NODE_ENV: "production" }), path: bigPath, now: () => T0 });
    resetBootLedgerForTests();
    writeFileSync(bigPath, Array.from({ length: lines }, () => filler).join("\n") + "\n");
    recordBoot({ proc: fakeProc({ NODE_ENV: "production" }), path: bigPath, now: () => T0 });
    const kept = readFileSync(bigPath, "utf8").split("\n").filter(Boolean);
    expect(kept.length).toBeLessThanOrEqual(BOOT_LEDGER_KEEP_LINES);
    expect(JSON.parse(kept[kept.length - 1]).t).toBe("boot");
  });

  it("never throws when the ledger location is unusable", () => {
    const blocker = join(dir, "a-file");
    writeFileSync(blocker, "x");
    // parent of the target is a FILE, so mkdir/append must fail
    expect(() => recordBoot({ proc: fakeProc({ NODE_ENV: "production" }), path: join(blocker, "nope", "l.jsonl") })).not.toThrow();
    resetBootLedgerForTests();
    expect(recordBoot({ proc: fakeProc({ NODE_ENV: "production" }), path: join(blocker, "nope", "l.jsonl") })).toBeNull();
  });
});

describe("exit-guard receipt hook", () => {
  it("hands the retagged code and call site to the receiver and never lets a throwing receiver block the exit", () => {
    const exitCalls: Array<number | string | null | undefined> = [];
    const emitter = new EventEmitter();
    const proc = Object.assign(emitter, {
      env: { NODE_ENV: "production" } as Record<string, string | undefined>,
      pid: 1,
      exitCode: undefined,
      exit: ((code?: number | string | null) => {
        exitCalls.push(code);
      }) as unknown as NodeJS.Process["exit"]
    }) as unknown as NodeJS.Process;
    const receipts: Array<{ code: number; signal?: string; callSite?: string }> = [];
    installProcessExitGuard(proc, {
      log: () => {},
      receipt: (d) => {
        receipts.push(d);
        throw new Error("receiver bug");
      }
    });
    proc.exit(0);
    expect(exitCalls).toEqual([43]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].code).toBe(43);
    expect(receipts[0].callSite).toMatch(/at /);
  });
});

describe("reportRestartLoop", () => {
  beforeEach(() => alertMock.alertStorageWarning.mockClear());

  it("does nothing when there is no loop", async () => {
    const log = vi.fn();
    await reportRestartLoop(null, { log });
    await reportRestartLoop(assessRestartLoop([boot("a", T0)], T0), { log });
    expect(log).not.toHaveBeenCalled();
    expect(alertMock.alertStorageWarning).not.toHaveBeenCalled();
  });

  it("raises the admin alert (cooldown is enforced inside alertStorageWarning) when there is a loop", async () => {
    const prev = process.env["SENTRY_" + "DSN"];
    delete process.env["SENTRY_" + "DSN"];
    try {
      const entries = [boot("a", T0 - 20 * MIN), boot("b", T0 - 10 * MIN), boot("c", T0)];
      await reportRestartLoop(assessRestartLoop(entries, T0), { log: () => {} });
      expect(alertMock.alertStorageWarning).toHaveBeenCalledTimes(1);
      expect(alertMock.alertStorageWarning.mock.calls[0]).toEqual([
        "restart_loop",
        expect.stringContaining("Restart loop: 3 boots")
      ]);
    } finally {
      if (prev !== undefined) process.env["SENTRY_" + "DSN"] = prev;
    }
  });

  it("logs the loop description to the container log and never throws without Sentry/DB", async () => {
    const log = vi.fn();
    const prev = process.env["SENTRY_" + "DSN"];
    delete process.env["SENTRY_" + "DSN"];
    try {
      const entries = [boot("a", T0 - 20 * MIN), boot("b", T0 - 10 * MIN), boot("c", T0)];
      await expect(reportRestartLoop(assessRestartLoop(entries, T0), { log })).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0][0])).toContain("[boot-ledger] Restart loop: 3 boots");
    } finally {
      if (prev !== undefined) process.env["SENTRY_" + "DSN"] = prev;
    }
  });
});
