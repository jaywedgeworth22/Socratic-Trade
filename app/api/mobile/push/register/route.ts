// POST /api/mobile/push/register   — register (or re-register) this device's APNs token
// DELETE /api/mobile/push/register — unregister it (sign-out)
//
// Session-authenticated exactly like every other /api/mobile route: identity comes from
// resolveRequestUserId (middleware-verified), never from the body.
//
// Contract
//   POST   body { token: string, environment: "sandbox" | "production", bundleId?: string }
//          -> 200 { ok: true, device: { token: "<masked>", environment, bundleId, platform } }
//          Idempotent: re-POSTing the same token refreshes it and returns 200 again. Registering a
//          token that currently belongs to ANOTHER user REASSIGNS it to the caller — a shared phone
//          that switches accounts must never keep receiving the previous user's alerts.
//          The FIRST registration of a device for a user also enables the "apns" delivery channel
//          (the act of allowing notifications in the app IS the opt-in). A re-registration of a
//          device the user already owns does NOT touch the channel prefs — the app re-registers on
//          every launch, so re-enabling there would make the Settings -> Delivery off-switch
//          unusable.
//   DELETE body { token: string }
//          -> 200 { ok: true, removed: boolean }
//          Scoped to the caller: a token owned by someone else is never touched (removed: false).
//
// The raw device token is never echoed back or logged — only maskDeviceToken form.

import {
  countActiveDeviceTokens,
  getDeviceToken,
  getNotifyPrefs,
  isApnsEnvironment,
  maskDeviceToken,
  normalizeDeviceToken,
  registerDeviceToken,
  setNotifyPrefs,
  unregisterDeviceToken
} from "@/lib/db";
import { isAcceptedApnsBundleId, loadApnsConfig } from "@/lib/apns";
import { enforceRateLimit } from "@/lib/rate-limit";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    token?: unknown;
    environment?: unknown;
    bundleId?: unknown;
    platform?: unknown;
  };
  const userId = resolveRequestUserId(request);
  const limited = enforceRateLimit(userId, "mobile/push/register", { limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const token = normalizeDeviceToken(body.token);
  if (!token) {
    return NextResponse.json({ ok: false, error: "token is required and must be a hex APNs device token" }, { status: 400 });
  }
  if (!isApnsEnvironment(body.environment)) {
    return NextResponse.json(
      { ok: false, error: 'environment is required and must be "sandbox" or "production"' },
      { status: 400 }
    );
  }

  // The bundle id doubles as the APNs topic. During the 2026-09-22 rename coexistence
  // window both trade.socratic.ios and trade.socratic.app are accepted (see
  // resolveAcceptedApnsBundleIds). Default to the configured primary when omitted;
  // reject anything outside the accepted set rather than storing a token we could
  // never successfully push to.
  const configured = loadApnsConfig()?.bundleId ?? "";
  const suppliedBundleId = typeof body.bundleId === "string" ? body.bundleId.trim() : "";
  if (suppliedBundleId && !isAcceptedApnsBundleId(suppliedBundleId)) {
    return NextResponse.json(
      { ok: false, error: "bundleId does not match an accepted APNs topic for this server" },
      { status: 400 }
    );
  }
  const bundleId = suppliedBundleId || configured;
  if (!bundleId) {
    return NextResponse.json({ ok: false, error: "bundleId is required (this server has no APNs topic configured)" }, { status: 400 });
  }

  const platform = typeof body.platform === "string" && body.platform.trim() ? body.platform.trim() : "ios";
  // Whether this device is ALREADY a LIVE row of this user's decides the opt-in below — read it
  // before the upsert reassigns/refreshes the row. A disabled row does not count: it means the
  // device was signed out or Apple retired the token, and coming back from either is a fresh
  // opt-in, not a launch-time re-assertion.
  const existing = getDeviceToken(token);
  const alreadyThisUsers = !!existing && existing.userId === userId && existing.disabledAt === null;
  const device = registerDeviceToken({ userId, token, environment: body.environment, bundleId, platform });

  // Allowing notifications on the device IS the opt-in for the channel — but ONLY the first time
  // this device registers for this user. The iOS app re-registers on EVERY launch (APNs can rotate
  // a token, so re-asserting is Apple's own guidance), so enabling here unconditionally would
  // silently undo a user who turned "iPhone push" off in Settings -> Delivery: the next app launch
  // would switch it straight back on and the off-switch would be unusable. A device that is new to
  // this user (first install, or a shared phone switching accounts) still opts in.
  if (!alreadyThisUsers) {
    const prefs = getNotifyPrefs(userId);
    if (!prefs.channels.includes("apns")) {
      setNotifyPrefs(userId, { channels: [...prefs.channels, "apns"] });
    }
  }

  return NextResponse.json({
    ok: true,
    device: {
      token: maskDeviceToken(device.token),
      environment: device.environment,
      bundleId: device.bundleId,
      platform: device.platform,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt
    }
  });
}

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { token?: unknown };
  const userId = resolveRequestUserId(request);
  const limited = enforceRateLimit(userId, "mobile/push/register", { limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const token = normalizeDeviceToken(body.token);
  if (!token) {
    return NextResponse.json({ ok: false, error: "token is required and must be a hex APNs device token" }, { status: 400 });
  }

  const removed = unregisterDeviceToken(userId, token);

  // Last device gone -> drop the channel too, so the user isn't left with an enabled channel that
  // has nowhere to deliver. Re-registering re-enables it.
  if (removed && countActiveDeviceTokens(userId) === 0) {
    const prefs = getNotifyPrefs(userId);
    if (prefs.channels.includes("apns")) {
      setNotifyPrefs(userId, { channels: prefs.channels.filter((channel) => channel !== "apns") });
    }
  }

  return NextResponse.json({ ok: true, removed });
}
