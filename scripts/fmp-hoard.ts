/**
 * RETIRED (owner 2026-08-04).
 *
 * Socratic-Trade must not call Financial Modeling Prep. FMP quota and any
 * FMP-class market/fundamentals data live on Congress.Trade; this app consumes
 * App A read paths instead.
 *
 * This script exits non-zero so operators/cron never re-enable accidental FMP spend.
 */

console.error(
  "[fmp-hoard] RETIRED: Socratic-Trade does not call FMP. " +
    "Use Congress.Trade for FMP-class data (or run hoards only from Congress.Trade)."
);
process.exit(1);
