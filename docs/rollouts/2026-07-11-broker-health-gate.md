# 2026-07-11 Broker Health Gate

## Summary
Added a pre-proposal broker health gate to the `Socratic-Trade` strategy engine and scheduler. Instead of making LLM calls for proposal generation on unhealthy accounts, the system now skips them early. This saves API tokens and prevents `order_placement_uncertain` error loops.

## Why
The proposal pipeline generated strategies via the LLM before verifying broker connectivty and health. When an account was disconnected or rate-limited (e.g. `order_placement_uncertain`), it still generated a proposal only to fail at execution time. This led to wasted LLM tokens and retry loops. 

## What Changed
- Created `checkBrokerHealth` to encapsulate connectivity, error rate, account suspension, and minimum notional checks.
- Extended `deriveExecutionState` to accept a `HealthSignals` object, and added an `isHealthy` flag to `ExecutionState`.
- Wired `checkBrokerHealth` into `src/lib/strategy.ts` immediately prior to the LLM `generateStrategy` call, skipping proposal generation if the broker is unhealthy.
- Wired `checkBrokerHealth` into `src/lib/scheduler.ts` to drop unhealthy accounts from the pending runs list before initiating tick runs.

## Files Touched
- `src/lib/broker-health.ts` (NEW)
- `src/lib/execution-mode.ts`
- `src/lib/db-learning.ts`
- `src/lib/strategy.ts`
- `src/lib/scheduler.ts`

## Verification
- Clean compilation: `npx tsc --noEmit`
- Linter passed: `npm run lint` (0 errors)
- Test suite passed: `npm test` (3740 passing tests)
- Next.js build completed: `npm run build`

## Follow-ups
None required for this specific task.
