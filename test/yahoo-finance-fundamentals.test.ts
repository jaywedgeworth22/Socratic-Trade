import { describe, expect, it } from "vitest";
import { yahooFundamentalsFromRecord, yahooQuoteFromChartMeta } from "../src/lib/yahoo-finance";

describe("yahooQuoteFromChartMeta", () => {
  it("keeps the 52-week range the chart endpoint already returns with price/volume", () => {
    const quote = yahooQuoteFromChartMeta({
      longName: "Alphabet Inc.",
      regularMarketPrice: 343.94,
      regularMarketVolume: 14_897_228,
      chartPreviousClose: 342.37,
      regularMarketTime: 1_723_579_200,
      fiftyTwoWeekHigh: 404.47,
      fiftyTwoWeekLow: 197.46
    });
    expect(quote).toMatchObject({
      companyName: "Alphabet Inc.",
      price: 343.94,
      volume: 14_897_228,
      prevClose: 342.37,
      fiftyTwoWeekHigh: 404.47,
      fiftyTwoWeekLow: 197.46
    });
    expect(quote?.peRatio).toBeUndefined();
    expect(quote?.eps).toBeUndefined();
    expect(quote?.syntheticSpread).toBe(true);
  });

  it("does not fabricate a 52-week range or PE when chart meta omitted them", () => {
    const quote = yahooQuoteFromChartMeta({
      regularMarketPrice: 100,
      chartPreviousClose: 99
    });
    expect(quote?.fiftyTwoWeekHigh).toBeUndefined();
    expect(quote?.fiftyTwoWeekLow).toBeUndefined();
    expect(quote?.peRatio).toBeUndefined();
  });

  it("leaves prevClose undefined when Yahoo omits chartPreviousClose — never the current price", () => {
    const quote = yahooQuoteFromChartMeta({ regularMarketPrice: 100 });
    expect(quote?.price).toBe(100);
    // Falling back to the price here fabricates a 0% intraday change.
    expect(quote?.prevClose).toBeUndefined();
  });
});

describe("yahooFundamentalsFromRecord", () => {
  it("maps Yahoo v7 names only when the numbers are real", () => {
    expect(yahooFundamentalsFromRecord({
      trailingPE: 26.4,
      epsTrailingTwelveMonths: 10.12,
      beta: 1.01,
      fiftyTwoWeekHigh: 404.47,
      fiftyTwoWeekLow: 197.46
    })).toEqual({
      peRatio: 26.4,
      eps: 10.12,
      beta: 1.01,
      fiftyTwoWeekHigh: 404.47,
      fiftyTwoWeekLow: 197.46
    });
    expect(yahooFundamentalsFromRecord({
      trailingPE: 0,
      fiftyTwoWeekHigh: -1
    })).toEqual({});
  });
});
