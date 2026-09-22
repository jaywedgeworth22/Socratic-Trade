import UserNotifications
import XCTest
@testable import SocraticTrade

/// The parts of push that can be wrong silently: which APNs environment a token belongs to,
/// what gets sent to the server, and what a payload means.  `UNUserNotificationCenter` itself
/// is not unit-testable, so everything that decides an outcome is pulled out into pure
/// functions and pinned here.
final class APNSEnvironmentTests: XCTestCase {
    func testDevelopmentSigningMeansSandbox() {
        XCTAssertEqual(
            APNSEnvironment.resolve(entitlementValue: "development", isSimulator: false),
            .sandbox
        )
    }

    /// The bug this whole type exists to prevent: TestFlight is a Release build signed with a
    /// DISTRIBUTION profile, whose aps-environment is `production`.  Treating it as sandbox
    /// makes every push 400 BadDeviceToken with no visible error anywhere.
    func testDistributionSigningMeansProductionIncludingTestFlight() {
        XCTAssertEqual(
            APNSEnvironment.resolve(entitlementValue: "production", isSimulator: false),
            .production
        )
    }

    func testUnreadableProfileOnADeviceFallsBackToProduction() {
        // A shipped build is the only realistic reason a device cannot read its own profile,
        // and shipped builds are production.  Guessing sandbox here would be the silent
        // failure again.
        XCTAssertEqual(APNSEnvironment.resolve(entitlementValue: nil, isSimulator: false), .production)
        XCTAssertEqual(APNSEnvironment.resolve(entitlementValue: "", isSimulator: false), .production)
        XCTAssertEqual(
            APNSEnvironment.resolve(entitlementValue: "something-else", isSimulator: false),
            .production
        )
    }

    func testSimulatorIsAlwaysSandboxWhateverItWasSignedWith() {
        // The simulator gets no real APNs token, so it must never claim a production
        // registration the server would then try to push to.
        XCTAssertEqual(APNSEnvironment.resolve(entitlementValue: "production", isSimulator: true), .sandbox)
        XCTAssertEqual(APNSEnvironment.resolve(entitlementValue: nil, isSimulator: true), .sandbox)
    }

    func testEntitlementValueIsReadLenientlyForCaseAndWhitespace() {
        XCTAssertEqual(
            APNSEnvironment.resolve(entitlementValue: "  Development \n", isSimulator: false),
            .sandbox
        )
        XCTAssertEqual(
            APNSEnvironment.resolve(entitlementValue: "PRODUCTION", isSimulator: false),
            .production
        )
    }

    // MARK: - Provisioning-profile parsing

    /// `embedded.mobileprovision` is a CMS envelope with an XML plist buried inside, so the
    /// parser has to find the plist between binary signature bytes on both sides.
    private func wrappedProfile(entitlements: String) -> Data {
        var data = Data([0x30, 0x82, 0x0A, 0xBC, 0x00, 0xFF])
        data.append(Data("""
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>Name</key>
            <string>Socratic Trade</string>
            <key>Entitlements</key>
            <dict>
        \(entitlements)
            </dict>
        </dict>
        </plist>
        """.utf8))
        data.append(Data([0x00, 0x01, 0x02, 0xFE]))
        return data
    }

    func testReadsApsEnvironmentOutOfAWrappedProfile() {
        let profile = wrappedProfile(entitlements: """
                    <key>aps-environment</key>
                    <string>production</string>
        """)
        XCTAssertEqual(APNSEnvironment.apsEnvironment(inProvisioningProfile: profile), "production")
    }

    func testReadsDevelopmentProfiles() {
        let profile = wrappedProfile(entitlements: """
                    <key>application-identifier</key>
                    <string>CC8UTF7ATG.trade.socratic.ios</string>
                    <key>aps-environment</key>
                    <string>development</string>
        """)
        XCTAssertEqual(APNSEnvironment.apsEnvironment(inProvisioningProfile: profile), "development")
        XCTAssertEqual(
            APNSEnvironment.resolve(
                entitlementValue: APNSEnvironment.apsEnvironment(inProvisioningProfile: profile),
                isSimulator: false
            ),
            .sandbox
        )
    }

    func testProfileWithoutPushCapabilityYieldsNil() {
        let profile = wrappedProfile(entitlements: """
                    <key>get-task-allow</key>
                    <true/>
        """)
        XCTAssertNil(APNSEnvironment.apsEnvironment(inProvisioningProfile: profile))
    }

    func testGarbageAndEmptyDataYieldNilRatherThanCrashing() {
        XCTAssertNil(APNSEnvironment.apsEnvironment(inProvisioningProfile: Data()))
        XCTAssertNil(APNSEnvironment.apsEnvironment(inProvisioningProfile: Data([0x00, 0xFF, 0x10])))
        XCTAssertNil(
            APNSEnvironment.apsEnvironment(inProvisioningProfile: Data("<plist not really".utf8))
        )
    }
}

final class PushRegistrationRequestTests: XCTestCase {
    func testDeviceTokenIsLowercaseHexWithoutSeparators() {
        let token = Data([0x00, 0x0f, 0xa1, 0xff, 0x10])
        XCTAssertEqual(PushRegistrationRequest.hexEncoded(token), "000fa1ff10")
    }

    func testFullLengthTokenRoundTripsToSixtyFourHexCharacters() {
        let request = PushRegistrationRequest(
            deviceToken: Data(repeating: 0xAB, count: 32),
            environment: .production,
            bundleId: "trade.socratic.ios"
        )
        XCTAssertEqual(request?.token.count, 64)
        XCTAssertEqual(request?.token, String(repeating: "ab", count: 32))
    }

    func testEmptyTokenIsRefused() {
        // A blank token would become a server row that can never be delivered to and never
        // invalidated, because APNs never answers 410 for something it never issued.
        XCTAssertNil(
            PushRegistrationRequest(deviceToken: Data(), environment: .production, bundleId: "trade.socratic.ios")
        )
    }

    func testBodyCarriesTokenEnvironmentAndBundleId() {
        let request = PushRegistrationRequest(
            token: "abc123",
            environment: .sandbox,
            bundleId: "trade.socratic.ios"
        )
        XCTAssertEqual(
            request.jsonBody,
            ["token": "abc123", "environment": "sandbox", "bundleId": "trade.socratic.ios"]
        )
    }

    func testEnvironmentIsSentAsTheWireStringsTheServerSwitchesOn() {
        XCTAssertEqual(APNSEnvironment.sandbox.rawValue, "sandbox")
        XCTAssertEqual(APNSEnvironment.production.rawValue, "production")
    }

    func testMissingBundleIdIsOmittedRatherThanSentEmpty() {
        XCTAssertEqual(
            PushRegistrationRequest(token: "abc123", environment: .production, bundleId: nil).jsonBody,
            ["token": "abc123", "environment": "production"]
        )
        XCTAssertEqual(
            PushRegistrationRequest(token: "abc123", environment: .production, bundleId: "   ").jsonBody,
            ["token": "abc123", "environment": "production"]
        )
    }
}

final class PushPayloadTests: XCTestCase {
    private func payload(_ object: [String: Any]) -> [AnyHashable: Any] {
        var userInfo: [AnyHashable: Any] = ["aps": ["alert": ["title": "Proposal ready"], "badge": 1]]
        for (key, value) in object {
            userInfo[key] = value
        }
        return userInfo
    }

    func testReadsTheLinkFromTheAcceptedRootKeys() {
        for key in PushPayload.linkKeys {
            XCTAssertEqual(
                PushPayload.deepLinkURL(in: payload([key: "https://socratictrade.com/console/activity"]))?
                    .absoluteString,
                "https://socratictrade.com/console/activity",
                key
            )
        }
    }

    func testReadsTheLinkFromANestedDataObject() {
        XCTAssertEqual(
            PushPayload.destination(
                in: payload(["data": ["url": "https://socratictrade.com/console/approvals"]])
            ),
            .tab(.proposals)
        )
    }

    func testRootKeyWinsOverNestedData() {
        XCTAssertEqual(
            PushPayload.destination(
                in: payload([
                    "url": "https://socratictrade.com/console/activity",
                    "data": ["url": "https://socratictrade.com/console/orders"]
                ])
            ),
            .tab(.activity)
        )
    }

    func testProposalNotificationsCarryTheProposalThrough() {
        XCTAssertEqual(
            PushPayload.destination(
                in: payload(["url": "https://socratictrade.com/console/approvals/proposal-77"])
            ),
            .proposal(id: "proposal-77")
        )
    }

    func testPayloadWithoutALinkRoutesNowhere() {
        XCTAssertNil(PushPayload.deepLinkURL(in: payload([:])))
        XCTAssertNil(PushPayload.deepLinkURL(in: payload(["url": "   "])))
        XCTAssertNil(PushPayload.deepLinkURL(in: payload(["url": 42])))
        XCTAssertNil(PushPayload.destination(in: payload([:])))
    }

    /// The payload is data off the network, so a tap must not be able to drive the app
    /// anywhere `DeepLink` would not already send a universal link.  One router, one policy.
    func testUnroutableAndHostileLinksAreDroppedByTheSharedRouter() {
        XCTAssertNil(PushPayload.destination(in: payload(["url": "https://evil.example.com/console/approvals"])))
        XCTAssertNil(PushPayload.destination(in: payload(["url": "http://socratictrade.com/console/approvals"])))
        XCTAssertNil(PushPayload.destination(in: payload(["url": "socratictrade://console/approvals"])))
        XCTAssertNil(PushPayload.destination(in: payload(["url": "https://socratictrade.com/console/settings"])))
    }
}

final class PushPresentationTests: XCTestCase {
    /// While the SSE stream is up the screen already reflects the event, so a banner would
    /// restate what the owner is looking at.  It still reaches Notification Center and the
    /// badge, so nothing is lost.
    func testForegroundBannerIsSuppressedWhileTheLiveStreamIsUp() {
        let options = PushNotificationCoordinator.foregroundPresentationOptions(isLiveStreamConnected: true)
        XCTAssertFalse(options.contains(.banner))
        XCTAssertFalse(options.contains(.sound))
        XCTAssertTrue(options.contains(.list))
        XCTAssertTrue(options.contains(.badge))
    }

    /// With the stream down the screen is stale, so the notification is the only way the owner
    /// hears about it — suppressing it there would hide real news.
    func testForegroundBannerIsShownWhenTheLiveStreamIsDown() {
        let options = PushNotificationCoordinator.foregroundPresentationOptions(isLiveStreamConnected: false)
        XCTAssertTrue(options.contains(.banner))
        XCTAssertTrue(options.contains(.list))
        XCTAssertTrue(options.contains(.badge))
    }
}

final class PushAlertStateTests: XCTestCase {
    /// Only a completed server registration may read as working.  Everything else — including
    /// "the owner allowed it but no token arrived" — must not be presented as alerts being on.
    func testOnlyARegisteredTokenCountsAsWorking() {
        XCTAssertTrue(PushAlertState.registered(environment: .production).isWorking)
        XCTAssertFalse(PushAlertState.awaitingToken.isWorking)
        XCTAssertFalse(PushAlertState.notRequested.isWorking)
        XCTAssertFalse(PushAlertState.denied.isWorking)
        XCTAssertFalse(PushAlertState.failed("boom").isWorking)
        XCTAssertFalse(PushAlertState.unknown.isWorking)
    }

    func testSummariesStayOrdinaryAppLanguage() {
        XCTAssertTrue(PushAlertState.denied.summary.contains("iOS Settings"))
        XCTAssertEqual(PushAlertState.registered(environment: .sandbox).summary, "Alerts on.")
        XCTAssertEqual(PushAlertState.registered(environment: .production).summary, "Alerts on.")
        XCTAssertFalse(PushAlertState.registered(environment: .production).summary.lowercased().contains("production"))
        XCTAssertFalse(PushAlertState.registered(environment: .sandbox).summary.lowercased().contains("sandbox"))
        XCTAssertFalse(PushAlertState.registered(environment: .production).summary.contains("APNs"))
        XCTAssertEqual(
            PushAlertState.failed("Apple returned an empty device token.").summary,
            "Alerts are off.  Try again, or check Notifications in iOS Settings."
        )
        XCTAssertEqual(PushAlertState.failed("token rejected").summary, "Alerts are off.  Try again.")
    }
}

/// CROSS-LANGUAGE CONTRACT — the server's push deep links vs this app's router.
///
/// The two halves of push were built in parallel and can only fail together silently: the server
/// picks a URL, iOS decides what it means, and nothing at build time connects them.  A URL the
/// parser rejects produces a notification that opens the app and lands nowhere — no crash, no log,
/// nothing to notice.
///
/// So the table below is the single source of truth for that pairing, and it is checked from BOTH
/// sides: this file asserts every URL routes to the stated destination, and
/// `test/apns-deep-link-contract.test.ts` parses these very rows out of this file and asserts
/// `pushDeepLink()` in `src/lib/push-deep-links.ts` emits exactly these strings for exactly these
/// event types — including that every `NOTIFICATION_EVENT_TYPES` member appears here.  Adding an
/// event type on the server, or changing a URL shape on either side, fails one of the two.
///
/// ROW FORMAT IS PARSED — one row per line, `Row("<event>", "<url>", .<tab>, <proposalId?>)`.
/// Keep it that way; do not reflow.
final class PushDeepLinkContractTests: XCTestCase {
    struct Row {
        let event: String
        let url: String
        let tab: AppTab
        let proposalId: String?

        init(_ event: String, _ url: String, _ tab: AppTab, _ proposalId: String? = nil) {
            self.event = event
            self.url = url
            self.tab = tab
            self.proposalId = proposalId
        }
    }

    /// CONTRACT TABLE — parsed verbatim by test/apns-deep-link-contract.test.ts.
    static let contract: [Row] = [
        Row("pending_approval", "https://socratictrade.com/console/approvals?proposal=6a1f0f1e-2f2a-4c8b-9d0e-3b7a5c1d2e4f", .proposals, "6a1f0f1e-2f2a-4c8b-9d0e-3b7a5c1d2e4f"),
        Row("proposal_withdrawn", "https://socratictrade.com/console/approvals?proposal=6a1f0f1e-2f2a-4c8b-9d0e-3b7a5c1d2e4f", .proposals, "6a1f0f1e-2f2a-4c8b-9d0e-3b7a5c1d2e4f"),
        Row("fill", "https://socratictrade.com/console/orders?symbol=AAPL", .markets),
        Row("limit_order_stale", "https://socratictrade.com/console/orders?symbol=NVDA", .markets),
        Row("price_alert", "https://socratictrade.com/console/watchlist?symbol=TSLA", .markets),
        Row("run_failed", "https://socratictrade.com/console/activity?tab=alerts", .activity),
        Row("kill_switch", "https://socratictrade.com/console/activity?tab=alerts", .activity),
        Row("block", "https://socratictrade.com/console/activity?tab=notifications", .activity),
        Row("provider_degraded", "https://socratictrade.com/console/activity?tab=notifications", .activity),
        Row("liveness_warning", "https://socratictrade.com/console/activity?tab=notifications", .activity),
        Row("budget_alert", "https://socratictrade.com/console/activity?tab=notifications", .activity),
        Row("learning_review", "https://socratictrade.com/console/activity?tab=notifications", .activity),
        Row("deterministic_bear_veto", "https://socratictrade.com/console/activity?tab=notifications", .activity),
        Row("red_team_veto_override_requested", "https://socratictrade.com/console/activity?tab=notifications", .activity),
        Row("red_team_veto_overridden", "https://socratictrade.com/console/activity?tab=notifications", .activity),
        Row("prompt_injection_suspected", "https://socratictrade.com/console/activity?tab=notifications", .activity),
        Row("evidence_age_anomaly", "https://socratictrade.com/console/activity?tab=notifications", .activity),
        Row("storage_warning", "https://socratictrade.com/console/activity?tab=notifications", .activity),
        Row("autonomy_halted_on_boot", "https://socratictrade.com/console/activity?tab=notifications", .activity),
        Row("option_alert", "https://socratictrade.com/console/activity?tab=notifications", .activity),
        Row("earningscalls_entitlement_blocked", "https://socratictrade.com/console/activity?tab=notifications", .activity),
        Row("roic_status_advisory", "https://socratictrade.com/console/activity?tab=notifications", .activity),
        Row("risk_advisory", "https://socratictrade.com/console/activity?tab=notifications", .activity),
        Row("protective_exit_failing", "https://socratictrade.com/console/activity?tab=notifications", .activity),
        Row("signal_health", "https://socratictrade.com/console/activity?tab=notifications", .activity),
        Row("watchlist_digest", "https://socratictrade.com/console/activity?tab=notifications", .activity),
        // The lookahead audit's findings panel lives on the WEB Results page, which this app has
        // no screen for and the AASA file does not claim.  Routing the tap at /console/results
        // would satisfy "points at the right web page" and fail the only thing that matters here:
        // DeepLink.destination(for:) rejects it, so the tap would open the app and stop.  Activity
        // is where the notification itself is listed, and the body already names the Results page
        // for anyone reading it on the web.
        Row("lookahead_leak", "https://socratictrade.com/console/activity?tab=notifications", .activity)
    ]

    /// Every URL the server can emit routes somewhere.  A nil here is a push that opens the app
    /// and does nothing — the exact silent failure this table exists to catch.
    func testEveryServerEmittedURLRoutesToItsStatedDestination() {
        for row in Self.contract {
            guard let url = URL(string: row.url) else {
                XCTFail("\(row.event): not a URL — \(row.url)")
                continue
            }
            guard let destination = DeepLink.destination(for: url) else {
                XCTFail("\(row.event): the router rejects the URL the server sends — \(row.url)")
                continue
            }
            XCTAssertEqual(destination.tab, row.tab, row.event)
            XCTAssertEqual(destination.proposalId, row.proposalId, row.event)
        }
    }

    /// The same URLs arriving the way they actually arrive: inside an APNs payload, read by
    /// `PushPayload`, not handed straight to the parser.
    func testTheSameURLsRouteWhenTheyArriveInsideAnAPNsPayload() {
        for row in Self.contract {
            let userInfo: [AnyHashable: Any] = [
                "aps": ["alert": ["title": "Socratic Trade", "body": row.event]],
                "kind": row.event,
                "url": row.url
            ]
            XCTAssertEqual(PushPayload.destination(in: userInfo)?.tab, row.tab, row.event)
        }
    }

    /// Guards the parse the TypeScript side depends on: if this table ever stops being one row
    /// per event, the cross-language check would silently start covering less than it claims.
    func testTableCoversEachEventTypeExactlyOnce() {
        let events = Self.contract.map(\.event)
        XCTAssertEqual(Set(events).count, events.count, "duplicate event type in the contract table")
        XCTAssertFalse(events.isEmpty)
    }
}
