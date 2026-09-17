import { test, expect } from "vitest";
import { checkPriceAlerts, createAlert } from "./alerts";
import { setPolicy, getDb, upsertConnectedAccount } from "./db";
import { DEFAULT_POLICY } from "./defaults";

test("alerts without active account", async () => {
  setPolicy({ ...DEFAULT_POLICY, accountNumber: undefined, activeBroker: undefined, connectedAccountId: undefined }, "local");
  upsertConnectedAccount({ id: "test-acc-1", userId: "local", broker: "test", accountNumber: "TEST1234", name: "Test", label: "Test", environment: "paper" } as any);
  createAlert("local", { symbol: "AAPL", op: "<", price: 1000000 });
  const alerts = await checkPriceAlerts("local");
  console.log("Returned alerts:", alerts);
  expect(alerts.length).toBeGreaterThan(0);
});
