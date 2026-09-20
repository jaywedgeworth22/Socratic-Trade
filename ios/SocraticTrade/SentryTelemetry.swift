import Foundation
import Sentry

/// Native Sentry telemetry and crash reporting for Socratic Trade iOS.
///
/// DSN is read only from Info.plist (`SENTRY_DSN`). There is no hardcoded
/// fallback — missing or empty skips init so a leaked default cannot be
/// pointed at the wrong project.
///
/// Features enabled under the sponsored tier:
/// - Native crash reporting (SIGSEGV, uncaught exceptions, OOM)
/// - UI freeze / App hang detection (>2.0s main thread hang)
/// - HTTP 5xx client request failure capture
/// - Distributed tracing (0.2 sample rate)
/// - Session Replay with aggressive masking (all text, all images, no screenshots)
/// - Release health via CFBundleShortVersionString / CFBundleVersion
enum SentryTelemetry {
    /// Resolves the Sentry environment string for this build.  Hardcoding `production` here
    /// used to make every simulator debug run, every TestFlight internal beta, and every
    /// ad-hoc local build pollute the production issue stream — a 2026-09-20 MM audit
    /// (#3226 #2) finding.  The fix: DEBUG builds always report `development`, App Store
    /// installs always report `production`, and anything in between (TestFlight, ad-hoc)
    /// reports `testflight`.  Receipt detection covers both the App Store and the
    /// TestFlight sandbox; receipt absence covers simulator / dev builds.
    static func resolvedEnvironment() -> String {
        #if DEBUG
        return "development"
        #else
        guard let receiptURL = Bundle.main.appStoreReceiptURL else {
            return "development"
        }
        // Receipt present means the install went through App Store OR TestFlight.
        // Receipt URL is `.appStoreReceipt` for App Store and a sandbox URL for TestFlight,
        // but both are "real" receipts — the file's existence is the signal, not the path.
        // A missing receipt file in Release means an unsigned sideload / `xcodebuild`
        // simulator archive — surface those as `development` so they never pollute prod.
        if FileManager.default.fileExists(atPath: receiptURL.path) {
            // TestFlight receipts live at `.../sandboxReceipt`; App Store at `.../receipt`.
            return receiptURL.lastPathComponent == "sandboxReceipt" ? "testflight" : "production"
        }
        return "development"
        #endif
    }

    static func start() {
        guard !SocraticTradeApp.isScreenshotMode else { return }

        guard let dsn = plistString("SENTRY_DSN"), !dsn.isEmpty else { return }

        let releaseName = plistString("CFBundleShortVersionString")
        let dist = plistString("CFBundleVersion")

        SentrySDK.start { options in
            options.dsn = dsn
            options.environment = resolvedEnvironment()
            if let releaseName, !releaseName.isEmpty {
                options.releaseName = releaseName
            }
            if let dist, !dist.isEmpty {
                options.dist = dist
            }
            options.tracesSampleRate = 0.2
            options.profilesSampleRate = 0.1
            options.enableAppHangTracking = true
            options.appHangTimeoutInterval = 2.0
            options.enableCaptureFailedRequests = true
            options.failedRequestStatusCodes = [HttpStatusCodeRange(min: 500, max: 599)]
            options.attachScreenshot = false
            options.attachViewHierarchy = false
            options.sendDefaultPii = false
            options.sessionReplay.sessionSampleRate = 0.01
            options.sessionReplay.onErrorSampleRate = 1.0
            options.sessionReplay.maskAllText = true
            options.sessionReplay.maskAllImages = true
            options.beforeSend = { event in
                if let request = event.request, let url = request.url {
                    var sanitized = url
                    for param in ["symbol", "proposal", "account", "token", "key", "secret"] {
                        sanitized = sanitized.replacingOccurrences(
                            of: "([?&]\(param)=)[^&#\\s]+",
                            with: "$1[REDACTED]",
                            options: .regularExpression
                        )
                    }
                    request.url = sanitized
                }
                return event
            }
        }
    }

    /// Info.plist string, treating unsubstituted `$(VAR)` build settings as missing.
    private static func plistString(_ key: String) -> String? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        if trimmed.hasPrefix("$(") { return nil }
        return trimmed
    }
}
