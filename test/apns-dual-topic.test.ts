import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CURRENT_APNS_BUNDLE_ID,
  LEGACY_APNS_BUNDLE_ID,
  isAcceptedApnsBundleId,
  resolveAcceptedApnsBundleIds,
  sendApnsPush,
  type ApnsConfig,
  type ApnsHttpRequest
} from "../src/lib/apns";

function ephemeralApnsConfig(bundleId: string = CURRENT_APNS_BUNDLE_ID): ApnsConfig {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    keyId: "KEYID1234",
    teamId: "CC8UTF7ATG",
    bundleId,
    privateKeyPem
  };
}

describe("APNs dual-topic coexistence (bundle rename)", () => {
  it("always accepts both current and legacy native topics", () => {
    expect(resolveAcceptedApnsBundleIds({})).toEqual([
      CURRENT_APNS_BUNDLE_ID,
      LEGACY_APNS_BUNDLE_ID
    ]);
    expect(isAcceptedApnsBundleId("trade.socratic.ios")).toBe(true);
    expect(isAcceptedApnsBundleId("trade.socratic.app")).toBe(true);
    expect(isAcceptedApnsBundleId("com.someone.else")).toBe(false);
  });

  it("honors APNS_BUNDLE_IDS extras without dropping the natives", () => {
    expect(
      resolveAcceptedApnsBundleIds({
        APNS_BUNDLE_ID: "trade.socratic.ios",
        APNS_BUNDLE_IDS: "trade.extra.one, trade.extra.two"
      })
    ).toEqual([
      "trade.socratic.ios",
      "trade.socratic.app",
      "trade.extra.one",
      "trade.extra.two"
    ]);
  });

  it("sends apns-topic from the per-device topic, not only the primary config", async () => {
    const seen: ApnsHttpRequest[] = [];
    const config = ephemeralApnsConfig(CURRENT_APNS_BUNDLE_ID);

    await sendApnsPush(
      {
        deviceToken: "a".repeat(64),
        environment: "sandbox",
        title: "t",
        body: "b",
        topic: LEGACY_APNS_BUNDLE_ID
      },
      {
        config,
        transport: async (req) => {
          seen.push(req);
          return { status: 200, body: "" };
        }
      }
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].headers["apns-topic"]).toBe("trade.socratic.app");
  });

  it("falls back to config.bundleId when no per-device topic is supplied", async () => {
    const seen: ApnsHttpRequest[] = [];
    const config = ephemeralApnsConfig(CURRENT_APNS_BUNDLE_ID);
    await sendApnsPush(
      {
        deviceToken: "b".repeat(64),
        environment: "sandbox",
        title: "t",
        body: "b"
      },
      {
        config,
        transport: async (req) => {
          seen.push(req);
          return { status: 200, body: "" };
        }
      }
    );
    expect(seen[0].headers["apns-topic"]).toBe("trade.socratic.ios");
  });
});
