import { describe, expect, it } from "vitest";
import {
  LEGACY_NATIVE_APPLE_CLIENT_ID,
  NATIVE_APPLE_CLIENT_ID,
  NATIVE_APPLE_CLIENT_IDS,
  resolveAppleClientIds
} from "../apple-client-id";

describe("apple-client-id", () => {
  it("always includes both native audiences during the bundle-rename coexistence window", () => {
    expect(NATIVE_APPLE_CLIENT_IDS).toEqual([
      "com.socratictrade.ios",
      "trade.socratic.app"
    ]);
    expect(resolveAppleClientIds(undefined)).toEqual([
      NATIVE_APPLE_CLIENT_ID,
      LEGACY_NATIVE_APPLE_CLIENT_ID
    ]);
    expect(resolveAppleClientIds("   ")).toEqual([
      NATIVE_APPLE_CLIENT_ID,
      LEGACY_NATIVE_APPLE_CLIENT_ID
    ]);
    expect(resolveAppleClientIds("")).toEqual([
      NATIVE_APPLE_CLIENT_ID,
      LEGACY_NATIVE_APPLE_CLIENT_ID
    ]);
  });

  it("does not drop the legacy native ID when APPLE_CLIENT_ID is the web Service ID", () => {
    // APPLE_CLIENT_ID in prod Infisical is the web Services ID, not the old native bundle.
    expect(resolveAppleClientIds("com.socratictrade.web")).toEqual([
      NATIVE_APPLE_CLIENT_ID,
      LEGACY_NATIVE_APPLE_CLIENT_ID,
      "com.socratictrade.web"
    ]);
    expect(resolveAppleClientIds("  com.socratictrade.web  ")).toEqual([
      NATIVE_APPLE_CLIENT_ID,
      LEGACY_NATIVE_APPLE_CLIENT_ID,
      "com.socratictrade.web"
    ]);
  });

  it("does not duplicate a native id when APPLE_CLIENT_ID repeats one", () => {
    expect(resolveAppleClientIds(NATIVE_APPLE_CLIENT_ID)).toEqual([
      NATIVE_APPLE_CLIENT_ID,
      LEGACY_NATIVE_APPLE_CLIENT_ID
    ]);
    expect(resolveAppleClientIds(LEGACY_NATIVE_APPLE_CLIENT_ID)).toEqual([
      NATIVE_APPLE_CLIENT_ID,
      LEGACY_NATIVE_APPLE_CLIENT_ID
    ]);
  });
});
