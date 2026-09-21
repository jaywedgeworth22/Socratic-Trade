/**
 * Provenance stamps: every accepted scan/cache value carries source + fetchedAt, and asOf when the
 * provider supplied one (the cascade never fabricates asOf from its own clock).
 * Covers cascade merge (takeScalar), symbol_field_latest writes, quote/bar merges, OHLC stamps.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resetDbForTesting } from "../src/lib/db";
import { stampFieldObservation } from "../src/lib/evidence-facts";
import { stampOhlcBarProvenance } from "../src/lib/history";
import { mergeGroupedBarData, mergeQuoteData } from "../src/lib/market";
import type { MarketQuote, MarketScan } from "../src/lib/types";
import type { MarketEnrichmentProvider, SymbolEnrichment } from "../src/lib/data-providers";

function quote(partial: Partial<MarketQuote> & { symbol: string }): MarketQuote {
  return {
    price: 100,
    volume: 1_000_000,
    intradayChangePct: 0,
    positionMarketValue: 0,
    score: 50,
    ...partial
  };
}

function emptyScan(q: MarketQuote): MarketScan {
  return {
    source: "nasdaq-delayed-screener",
    generatedAt: "2026-08-05T12:00:00.000Z",
    scannedSymbols: 1,
    returnedQuotes: 1,
    topCandidates: [q],
    sectorBySymbol: {},
    quotesBySymbol: { [q.symbol]: q },
    cacheTtlMs: 300_000,
    cached: false,
    warnings: []
  };
}

describe("stampFieldObservation helper", () => {
  it("always fills source, asOf, and fetchedAt", () => {
    const obs = stampFieldObservation(28.5, "yahoo-finance", {
      asOf: "2026-08-05T14:00:00.000Z",
      fetchedAt: "2026-08-05T14:05:00.000Z"
    });
    expect(obs).toMatchObject({
      value: 28.5,
      source: "yahoo-finance",
      asOf: "2026-08-05T14:00:00.000Z",
      fetchedAt: "2026-08-05T14:05:00.000Z",
      status: "ok"
    });
  });

  it("defaults asOf to fetchedAt when only fetch clock is known", () => {
    const obs = stampFieldObservation("Technology", "roic", {
      fetchedAt: "2026-08-05T15:00:00.000Z"
    });
    expect(obs.asOf).toBe("2026-08-05T15:00:00.000Z");
    expect(obs.fetchedAt).toBe("2026-08-05T15:00:00.000Z");
  });
});

describe("cascade merge provenance stamps", () => {
  it("stamps sharesOutstanding + headlines with source and fetchedAt (no fabricated asOf) into fieldObservations and the field store", async () => {
    const dir = mkdtempSync(join(tmpdir(), `prov-cascade-${randomUUID()}-`));
    const prevDb = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
    resetDbForTesting();

    try {
      const provider: MarketEnrichmentProvider = {
        name: "test-prov-provider",
        configured: true,
        async enrich() {
          const data: Record<string, SymbolEnrichment> = {
            AAPL: {
              peRatio: 30,
              sharesOutstanding: 15_000_000_000,
              headlines: ["Apple ships new product"],
              sector: "Technology"
            }
          };
          return data;
        }
      };

      const { CascadingEnrichmentProvider } = await import("../src/lib/data-providers");
      const cascade = new CascadingEnrichmentProvider([provider]);
      const merged = await cascade.enrich(["AAPL"]);

      expect(merged.AAPL.sharesOutstanding).toBe(15_000_000_000);
      expect(merged.AAPL.sources?.sharesOutstanding).toBe("test-prov-provider");
      expect(merged.AAPL.fieldObservations?.sharesOutstanding?.source).toBe("test-prov-provider");
      expect(merged.AAPL.fieldObservations?.sharesOutstanding?.fetchedAt).toBeTruthy();
      // The provider supplied no timestamp for this value, so asOf must stay undefined rather than
      // being back-filled with the cascade's own clock (PR #3309: do not fabricate asOf).
      expect(merged.AAPL.fieldObservations?.sharesOutstanding?.asOf).toBeUndefined();

      expect(merged.AAPL.headlines).toEqual(["Apple ships new product"]);
      expect(merged.AAPL.sources?.headlines).toBe("test-prov-provider");
      expect(merged.AAPL.fieldObservations?.headlines?.source).toBe("test-prov-provider");
      expect(merged.AAPL.fieldObservations?.headlines?.fetchedAt).toBeTruthy();
      expect(merged.AAPL.fieldObservations?.headlines?.asOf).toBeUndefined();

      expect(merged.AAPL.fieldObservations?.peRatio?.source).toBe("test-prov-provider");
      expect(merged.AAPL.fieldObservations?.peRatio?.fetchedAt).toBeTruthy();
      expect(merged.AAPL.fieldObservations?.peRatio?.asOf).toBeUndefined();

      // Allow async store write (void import path)
      await new Promise((r) => setTimeout(r, 50));
      const { getSymbolFieldLatestBySymbol, recordsFromEnrichmentMap, upsertSymbolFieldLatest } =
        await import("../src/lib/db-fundamentals");

      // Explicit store write path (mirrors cascade's recordsFromEnrichmentMap call)
      const records = recordsFromEnrichmentMap(merged, "2026-08-05T16:00:00.000Z");
      expect(records.some((r) => r.field === "sharesOutstanding" && r.source === "test-prov-provider")).toBe(
        true
      );
      expect(records.some((r) => r.field === "headlines" && r.source === "test-prov-provider")).toBe(true);
      for (const r of records) {
        expect(r.source).not.toBe("unknown");
        expect(r.asOf).toBeTruthy();
        expect(r.fetchedAt).toBeTruthy();
      }
      upsertSymbolFieldLatest(records);
      const bySym = getSymbolFieldLatestBySymbol(["AAPL"]);
      expect(bySym.AAPL.sharesOutstanding.source).toBe("test-prov-provider");
      expect(bySym.AAPL.sharesOutstanding.asOf).toBeTruthy();
      expect(bySym.AAPL.headlines.source).toBe("test-prov-provider");
    } finally {
      resetDbForTesting();
      if (prevDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDb;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});

describe("cascade merge arbitrates the new quote fields", () => {
  it("takeScalars bidSize/askSize/prevClose/open/high/low/netChange with source + observations", async () => {
    // Codex P1 review on #3449: these fields were populated by providers but
    // dropped by the cascade merge (never takeScalar'd). They must reach the
    // merged enrichment with per-field source and observations.
    const provider: MarketEnrichmentProvider = {
      name: "test-quote-provider",
      configured: true,
      async enrich() {
        const data: Record<string, SymbolEnrichment> = {
          AAPL: {
            price: 150,
            bid: 149.9,
            ask: 150.1,
            bidSize: 100,
            askSize: 200,
            prevClose: 148,
            open: 149,
            high: 151,
            low: 147.5,
            netChange: 2,
            asOf: "2026-09-21T14:00:00.000Z"
          }
        };
        return data;
      }
    };

    const { CascadingEnrichmentProvider } = await import("../src/lib/data-providers");
    const cascade = new CascadingEnrichmentProvider([provider]);
    const merged = await cascade.enrich(["AAPL"]);

    for (const field of ["bidSize", "askSize", "prevClose", "open", "high", "low", "netChange"] as const) {
      expect((merged.AAPL as any)[field]).toBeDefined();
      expect(merged.AAPL.sources?.[field]).toBe("test-quote-provider");
      expect(merged.AAPL.fieldObservations?.[field]?.source).toBe("test-quote-provider");
      expect(merged.AAPL.fieldObservations?.[field]?.fetchedAt).toBeTruthy();
    }
    expect(merged.AAPL.bidSize).toBe(100);
    expect(merged.AAPL.askSize).toBe(200);
    expect(merged.AAPL.prevClose).toBe(148);
    expect(merged.AAPL.open).toBe(149);
    expect(merged.AAPL.high).toBe(151);
    expect(merged.AAPL.low).toBe(147.5);
    expect(merged.AAPL.netChange).toBe(2);
    // Provider-supplied asOf is preserved on the observations (not fabricated).
    expect(merged.AAPL.fieldObservations?.prevClose?.asOf).toBe("2026-09-21T14:00:00.000Z");
  });
});

describe("cascade merge preserves provider-supplied asOf", () => {
  it("carries a provider fieldDates / record asOf through to the observation instead of the cascade clock", async () => {
    const dir = mkdtempSync(join(tmpdir(), `prov-cascade-asof-${randomUUID()}-`));
    const prevDb = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
    resetDbForTesting();

    try {
      const providerAsOf = "2026-08-05T13:59:00.000Z";
      const peAsOf = "2026-08-04T20:00:00.000Z";
      const provider: MarketEnrichmentProvider = {
        name: "test-prov-provider",
        configured: true,
        async enrich() {
          const data: Record<string, SymbolEnrichment> = {
            AAPL: {
              asOf: providerAsOf,
              peRatio: 30,
              fieldDates: { peRatio: peAsOf },
              sector: "Technology"
            }
          };
          return data;
        }
      };

      const { CascadingEnrichmentProvider } = await import("../src/lib/data-providers");
      const merged = await new CascadingEnrichmentProvider([provider]).enrich(["AAPL"]);

      // Per-field provider date wins; a field with no per-field date falls back to the provider's own
      // record-level asOf (still a provider claim, not the cascade clock).
      expect(merged.AAPL.fieldObservations?.peRatio?.asOf).toBe(peAsOf);
      expect(merged.AAPL.fieldObservations?.sector?.asOf).toBe(providerAsOf);
      // fetchedAt is the cascade's retrieval clock and is always stamped.
      expect(merged.AAPL.fieldObservations?.peRatio?.fetchedAt).toBeTruthy();
      expect(merged.AAPL.fieldObservations?.peRatio?.fetchedAt).not.toBe(peAsOf);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      resetDbForTesting();
      if (prevDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDb;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});

describe("mergeQuoteData / mergeGroupedBarData fieldObservations", () => {
  it("stamps price/bid/ask/volume fieldObservations when broker quote merges", () => {
    const scan = emptyScan(quote({ symbol: "AAPL", price: 90 }));
    const merged = mergeQuoteData(scan, {
      AAPL: {
        price: 101,
        bid: 100.9,
        ask: 101.1,
        volume: 2_000_000,
        provider: "alpaca",
        asOf: "2026-08-05T14:30:00.000Z",
        fetchedAt: "2026-08-05T14:30:01.000Z"
      }
    });
    const c = merged.topCandidates[0];
    expect(c.sources?.price).toBe("alpaca");
    expect(c.fieldObservations?.price?.source).toBe("alpaca");
    expect(c.fieldObservations?.price?.asOf).toBe("2026-08-05T14:30:00.000Z");
    expect(c.fieldObservations?.price?.fetchedAt).toBe("2026-08-05T14:30:01.000Z");
    expect(c.fieldObservations?.bid?.source).toBe("alpaca");
    expect(c.fieldObservations?.ask?.source).toBe("alpaca");
    expect(c.fieldObservations?.volume?.value).toBe(2_000_000);
    expect(merged.quotesBySymbol.AAPL.fieldObservations?.price?.source).toBe("alpaca");
  });

  it("stamps vwap fieldObservations on grouped bar merge", () => {
    const scan = emptyScan(quote({ symbol: "MSFT", price: 400 }));
    const merged = mergeGroupedBarData(
      scan,
      [{ ticker: "MSFT", close: 400, vwap: 399.5 }],
      "massive-vwap"
    );
    expect(merged.topCandidates[0].vwap).toBe(399.5);
    expect(merged.topCandidates[0].sources?.vwap).toBe("massive-vwap");
    expect(merged.topCandidates[0].fieldObservations?.vwap?.source).toBe("massive-vwap");
    expect(merged.topCandidates[0].fieldObservations?.vwap?.fetchedAt).toBeTruthy();
    expect(merged.topCandidates[0].fieldObservations?.vwap?.asOf).toBeTruthy();
  });
});

describe("OHLC bar provenance", () => {
  it("stampOhlcBarProvenance sets source + fetchedAt on every bar", () => {
    const bars = stampOhlcBarProvenance(
      [
        { time: "2026-08-01", close: 10 },
        { time: "2026-08-04", close: 11 }
      ],
      "yahoo-finance",
      "2026-08-05T12:00:00.000Z"
    );
    expect(bars).toHaveLength(2);
    for (const b of bars) {
      expect(b.source).toBe("yahoo-finance");
      expect(b.fetchedAt).toBe("2026-08-05T12:00:00.000Z");
    }
  });

  it("history_cache_eod persists and reloads source", async () => {
    const dir = mkdtempSync(join(tmpdir(), `prov-hist-${randomUUID()}-`));
    const prevDb = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
    resetDbForTesting();
    try {
      const { upsertHistoryCacheEod, fetchHistoryCacheEod } = await import("../src/lib/history-cache");
      const { getSchemaVersion } = await import("../src/lib/db");
      const { getDb } = await import("../src/lib/db");
      expect(getSchemaVersion(getDb())).toBeGreaterThanOrEqual(71);

      upsertHistoryCacheEod("TESTSYM", [
        {
          time: "2026-08-01",
          close: 1,
          source: "massive",
          fetchedAt: "2026-08-05T10:00:00.000Z"
        },
        {
          time: "2026-08-04",
          close: 2,
          source: "massive",
          fetchedAt: "2026-08-05T10:00:00.000Z"
        }
      ]);
      const loaded = fetchHistoryCacheEod("TESTSYM");
      expect(loaded).toBeTruthy();
      expect(loaded!.length).toBeGreaterThanOrEqual(2);
      expect(loaded![0].source).toBe("massive");
      expect(loaded![0].fetchedAt).toBeTruthy();
    } finally {
      resetDbForTesting();
      if (prevDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDb;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});
