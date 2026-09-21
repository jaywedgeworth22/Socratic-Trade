import XCTest
@testable import SocraticTrade

final class MobileModelsTests: XCTestCase {
    func testSnapshotDecodesEveryMobileDashboardSection() throws {
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(fullSnapshotJSON.utf8))

        XCTAssertEqual(snapshot.marketSession, "regular")
        XCTAssertEqual(snapshot.scheduler.nextRunAt, "2026-07-21T18:00:00.000Z")
        XCTAssertEqual(snapshot.positions.first?.symbol, "AAPL")
        XCTAssertEqual(snapshot.orders.first?.state, "filled")
        XCTAssertEqual(snapshot.dailyStats.openingOrderCount, 1)
        XCTAssertEqual(snapshot.performance?.liveRealizedPnl, 125.50)
        XCTAssertEqual(snapshot.performance?.benchmark?.excessReturnPct, 1.2)
        XCTAssertEqual(snapshot.performance?.benchmark?.shadowValue, 24000)
        XCTAssertEqual(snapshot.performance?.benchmark?.dollarExcess, 1000)
        XCTAssertEqual(snapshot.performance?.benchmark?.accountEquitySeries?.count, 2)
        XCTAssertEqual(snapshot.performance?.benchmark?.shadowBenchmarkSeries?.last?.value, 24000)
        XCTAssertEqual(snapshot.connectedAccounts.first?.environment, "live")
        XCTAssertEqual(snapshot.alerts.first?.triggeredPrice, 205)
        XCTAssertEqual(snapshot.pendingProposals.first?.proposal.tradeThesisTag, "quality")
        XCTAssertEqual(snapshot.pendingProposals.first?.proposal.proposedByModel, "openrouter/openai/gpt-5-mini")
        XCTAssertEqual(snapshot.pendingProposals.first?.proposal.redTeamVerdict?.verdict, "approve-at-half")
        XCTAssertEqual(snapshot.pendingProposals.first?.proposal.redTeamVerdict?.available, true)
        XCTAssertEqual(snapshot.pendingProposals.first?.proposal.bracketTakeProfit, 220)
        XCTAssertEqual(snapshot.pendingProposals.first?.proposal.bracketStopLoss, 190)
        XCTAssertEqual(snapshot.pendingProposals.first?.proposal.exitPlan, "Trim a third at 220; trail the rest.")
        XCTAssertEqual(snapshot.recentCommands.first?.status, "succeeded")
        XCTAssertNil(snapshot.latestScan)
        XCTAssertEqual(snapshot.notifications.first?.type, "run_failed")
        XCTAssertNil(snapshot.notifications.first?.acknowledgedAt)
        XCTAssertEqual(snapshot.notifications.first?.title, "Strategy Run Failed")
        XCTAssertEqual(snapshot.notifications.first?.body, "Sent")
        XCTAssertEqual(snapshot.notifications.first?.read, false)
        XCTAssertEqual(snapshot.unreadNotificationCount, 1)
        XCTAssertEqual(snapshot.inScopeNotifications(activeAccountId: "account-1").count, 1)
        XCTAssertTrue(snapshot.inScopeNotifications(activeAccountId: "other").isEmpty)
        XCTAssertEqual(snapshot.strategyRuns.first?.id, "run-1")
        XCTAssertEqual(snapshot.strategyRuns.first?.status, "failed")
        XCTAssertEqual(
            snapshot.strategyRuns.first?.failure,
            "This strategy run stopped because gathering market data took too long.  The next run will try again."
        )
        XCTAssertEqual(snapshot.unifiedFeed.first?.title, "Strategy Run Failed")
        XCTAssertEqual(snapshot.unifiedFeed.first?.status, "failed")
        XCTAssertNil(snapshot.notifications.first?.channel)
    }

    func testBenchmarkWithoutDollarSeriesStillDecodes() throws {
        // Installed TestFlight builds must keep reading a snapshot whose benchmark
        // predates the same-cash dollar series — those keys are additive.
        let json = #"""
        {"readiness":{"hasAccount":true,"hasUniverse":true,"systemState":"active","strategyAuthority":"decide","commandBacklog":{"queued":0,"running":0}},
         "policy":{"systemState":"active","strategyAuthority":"decide"},
         "performance":{"liveRealizedPnl":1,"benchmark":{"accountReturnPct":5,"benchmarkReturnPct":4,"excessReturnPct":1,"startDate":"2026-06-01","endDate":"2026-07-21","points":10,"benchmarkSymbol":"SPY"}}}
        """#
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(snapshot.performance?.benchmark?.excessReturnPct, 1)
        XCTAssertNil(snapshot.performance?.benchmark?.accountEquitySeries)
        XCTAssertNil(snapshot.performance?.benchmark?.shadowValue)
    }

    func testEquityCurveDecodesServerTimestampKeyedPoints() throws {
        // The live server keys curve points by `timestamp` (src/lib/types.ts
        // EquityCurvePoint); requiring `date` alone blanked the whole workspace.
        let json = #"""
        {"readiness":{"hasAccount":true,"hasUniverse":true,"systemState":"active","strategyAuthority":"decide","commandBacklog":{"queued":0,"running":0}},
         "policy":{"systemState":"active","strategyAuthority":"decide"},
         "performance":{"liveRealizedPnl":1,
           "liveEquityCurve":[{"timestamp":"2026-08-27T12:00:00.000Z","equity":1000,"cash":10,"positionsValue":990,"source":"live"}],
           "paperEquityCurve":[{"date":"2026-08-26","equity":900}]}}
        """#
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(snapshot.performance?.liveEquityCurve?.first?.date, "2026-08-27T12:00:00.000Z")
        XCTAssertEqual(snapshot.performance?.liveEquityCurve?.first?.equity, 1000)
        XCTAssertEqual(snapshot.performance?.paperEquityCurve?.first?.date, "2026-08-26")
    }

    func testMalformedPerformanceDegradesToNilInsteadOfBlankingSnapshot() throws {
        // performance is display-only enrichment: a curve point with neither
        // date nor timestamp (or any other malformed sub-field) must not abort
        // the whole snapshot decode.
        let json = #"""
        {"readiness":{"hasAccount":true,"hasUniverse":true,"systemState":"active","strategyAuthority":"decide","commandBacklog":{"queued":0,"running":0}},
         "policy":{"systemState":"active","strategyAuthority":"decide"},
         "performance":{"liveEquityCurve":[{"equity":1000}]}}
        """#
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(json.utf8))
        XCTAssertNil(snapshot.performance)
        XCTAssertEqual(snapshot.readiness.systemState, "active")
    }

    // 2026-09-20 MM (#3226): money-path collections (positions, orders, pendingProposals)
    // must drop a malformed element (counted) instead of blanking the whole snapshot.  The
    // drop marks `partialData = true` so the caller can refuse to render a confident view.
    func testMalformedPositionDropsThatItemAndMarksPartial() throws {
        let json = #"""
        {"readiness":{"hasAccount":true,"hasUniverse":true,"systemState":"active","strategyAuthority":"decide","commandBacklog":{"queued":0,"running":0}},
         "policy":{"systemState":"active","strategyAuthority":"decide"},
         "positions":[
            {"symbol":"AAPL","quantity":10,"marketValue":1500,"averageCost":100},
            {"symbol":"NOT-A-POSITION","junk":true},
            {"symbol":"GOOG","quantity":2,"marketValue":3000,"averageCost":1500}
         ]}
        """#
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(json.utf8))
        // The well-formed items survive.
        XCTAssertEqual(snapshot.positions.map(\.symbol), ["AAPL", "GOOG"])
        // One item was dropped and the drop was counted.
        XCTAssertEqual(snapshot.partialDropCounts.positions, 1)
        XCTAssertTrue(snapshot.partialData)
    }

    func testAllMoneyPathCollectionsMalformedStillDecodes() throws {
        // Every element of every money-path collection is broken.  The snapshot still
        // decodes with empty arrays + partial-data flag set.
        let json = #"""
        {"readiness":{"hasAccount":true,"hasUniverse":true,"systemState":"active","strategyAuthority":"decide","commandBacklog":{"queued":0,"running":0}},
         "policy":{"systemState":"active","strategyAuthority":"decide"},
         "positions":[{"junk":1}],
         "orders":[{"junk":2}],
         "pendingProposals":[{"junk":3}]}
        """#
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(json.utf8))
        XCTAssertTrue(snapshot.positions.isEmpty)
        XCTAssertTrue(snapshot.orders.isEmpty)
        XCTAssertTrue(snapshot.pendingProposals.isEmpty)
        XCTAssertEqual(snapshot.partialDropCounts.total, 3)
        XCTAssertTrue(snapshot.partialData)
    }

    func testCleanSnapshotHasPartialDataFalse() throws {
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(fullSnapshotJSON.utf8))
        XCTAssertFalse(snapshot.partialData)
        XCTAssertEqual(snapshot.partialDropCounts.total, 0)
    }

    func testMissingReadinessRejectsTheSnapshot() {
        let json = #"{"policy":{"systemState":"active","strategyAuthority":"decide"}}"#
        XCTAssertThrowsError(try JSONDecoder().decode(MobileSnapshot.self, from: Data(json.utf8)))
    }

    func testWrongShapeReadinessRejectsTheSnapshot() {
        let json = #"{"readiness":"ok","policy":{"systemState":"active","strategyAuthority":"decide"}}"#
        XCTAssertThrowsError(try JSONDecoder().decode(MobileSnapshot.self, from: Data(json.utf8)))
    }

    func testMissingPolicyRejectsTheSnapshot() {
        let json = #"""
        {"readiness":{"hasAccount":true,"hasUniverse":true,"systemState":"active","strategyAuthority":"decide","commandBacklog":{"queued":0,"running":0}}}
        """#
        XCTAssertThrowsError(try JSONDecoder().decode(MobileSnapshot.self, from: Data(json.utf8)))
    }

    func testWrongShapePolicyRejectsTheSnapshot() {
        let json = #"""
        {"readiness":{"hasAccount":true,"hasUniverse":true,"systemState":"active","strategyAuthority":"decide","commandBacklog":{"queued":0,"running":0}},"policy":"v1"}
        """#
        XCTAssertThrowsError(try JSONDecoder().decode(MobileSnapshot.self, from: Data(json.utf8)))
    }

    func testOlderReadinessWithoutConsentFieldDoesNotRequireConsent() throws {
        let json = #"""
        {"readiness":{"hasAccount":true,"hasUniverse":true,"systemState":"active","strategyAuthority":"decide","commandBacklog":{"queued":0,"running":0}},
         "policy":{"systemState":"active","strategyAuthority":"decide"}}
        """#
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(json.utf8))
        XCTAssertNil(snapshot.readiness.needsAppConsent)
        XCTAssertFalse(snapshot.readiness.requiresAppConsent)
    }

    func testMalformedConsentValueRejectsTheSnapshot() {
        let json = #"""
        {"readiness":{"hasAccount":true,"hasUniverse":true,"systemState":"active","strategyAuthority":"decide","commandBacklog":{"queued":0,"running":0},"needsAppConsent":"false"},
         "policy":{"systemState":"active","strategyAuthority":"decide"}}
        """#
        XCTAssertThrowsError(try JSONDecoder().decode(MobileSnapshot.self, from: Data(json.utf8)))
    }

    func testSnapshotDecodesCompactLatestScan() throws {
        let json = Data(#"""
        {
          "readiness": {
            "hasAccount": true,
            "hasUniverse": true,
            "systemState": "active",
            "strategyAuthority": "propose",
            "selectedAccountNumber": null,
            "activeConnectedAccount": null,
            "commandBacklog": {"queued": 0, "running": 0}
          },
          "policy": {
            "systemState": "active",
            "strategyAuthority": "propose"
          },
          "latestScan": {
            "generatedAt": "2026-08-18T19:25:13.000Z",
            "asOf": "2026-08-18T19:25:13.000Z",
            "scannedSymbols": 5073,
            "returnedQuotes": 5069,
            "warnings": ["Some ranked names are missing P/E."],
            "topCandidates": [
              {"symbol":"BRK-B","companyName":"Berkshire Hathaway","price":500,"score":88},
              {"symbol":"GOOG","price":180,"score":86}
            ]
          }
        }
        """#.utf8)
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: json)
        XCTAssertEqual(snapshot.latestScan?.topCandidates.map(\.symbol), ["BRK-B", "GOOG"])
        XCTAssertEqual(snapshot.latestScan?.scannedSymbols, 5073)
        XCTAssertEqual(snapshot.latestScan?.returnedQuotes, 5069)
        XCTAssertEqual(snapshot.latestScan?.asOf, "2026-08-18T19:25:13.000Z")
        XCTAssertTrue(snapshot.latestScan?.hasUsableUniverse == true)
    }

    func testSnapshotDecodesWithoutNotificationsAsEmptyInbox() throws {
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(minimalSnapshotJSON.utf8))
        XCTAssertTrue(snapshot.notifications.isEmpty)
        XCTAssertEqual(snapshot.unreadNotificationCount, 0)
        XCTAssertTrue(snapshot.strategyRuns.isEmpty)
        XCTAssertTrue(snapshot.unifiedFeed.isEmpty)
    }

    func testDeletionPreviewMatchesReadOnlyServerContract() throws {
        let envelope = try JSONDecoder().decode(
            DeletionRequestEnvelope.self,
            from: Data(#"{"deletionRequest":{"userId":"user-1","email":"owner@example.com","requiredText":"DELETE MY ACCOUNT","steps":["Export records","Confirm deletion"]}}"#.utf8)
        )

        XCTAssertNil(envelope.deletionRequest.requestId)
        XCTAssertNil(envelope.deletionRequest.expiresAt)
    }

    func testDeletionResultDecodesActualServerReceiptWithoutDeletedUserId() throws {
        let result = try JSONDecoder().decode(
            AccountDeletionResult.self,
            from: Data(#"{"ok":true,"counts":{"alerts":2,"connected_accounts":1},"logoutUrl":"/logout"}"#.utf8)
        )

        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.counts["alerts"], 2)
        XCTAssertEqual(result.logoutUrl, "/logout")
    }

    func testLegacyRedTeamVerdictsDecodeWithSafeDefaults() throws {
        let legacyObject = try JSONDecoder().decode(
            RedTeamVerdict.self,
            from: Data(#"{"decision":"reject","rationale":"Legacy objection"}"#.utf8)
        )
        let legacyString = try JSONDecoder().decode(
            RedTeamVerdict.self,
            from: Data(#""approve""#.utf8)
        )
        let emptyObject = try JSONDecoder().decode(
            RedTeamVerdict.self,
            from: Data(#"{}"#.utf8)
        )
        let oldestPersistedVerdict = try JSONDecoder().decode(
            RedTeamVerdict.self,
            from: Data(#"{"rejected":true}"#.utf8)
        )

        XCTAssertEqual(legacyObject.verdict, "reject")
        XCTAssertTrue(legacyObject.rejected)
        XCTAssertTrue(legacyObject.available)
        XCTAssertEqual(legacyObject.reason, "Legacy objection")
        XCTAssertEqual(legacyString.verdict, "approve")
        XCTAssertTrue(legacyString.available)
        XCTAssertFalse(emptyObject.available)
        XCTAssertFalse(emptyObject.rejected)
        XCTAssertFalse(emptyObject.reason.isEmpty)
        XCTAssertTrue(oldestPersistedVerdict.available)
        XCTAssertTrue(oldestPersistedVerdict.rejected)
    }

    func testPresentedMarketItemIdentifiesFillPositionAndCompany() throws {
        let fill = try JSONDecoder().decode(
            FillEvent.self,
            from: Data(#"{"id":"fill-1","symbol":"GOOG","side":"buy","quantity":2,"price":343.94,"notional":687.88,"status":"filled","filledAt":"2026-08-13T20:00:00.000Z"}"#.utf8)
        )
        let position = try JSONDecoder().decode(
            Position.self,
            from: Data(#"{"symbol":"GOOG","quantity":10,"marketValue":3439.4,"averageCost":300,"sector":"Technology","industry":"Internet Content & Information"}"#.utf8)
        )
        let quote = try JSONDecoder().decode(
            SymbolQuoteInfo.self,
            from: Data(#"{"symbol":"GOOG","companyName":"Alphabet Inc.","price":343.94,"peRatio":26.4,"eps":10.12,"dividendYield":0.32,"beta":1.01,"fiftyTwoWeekHigh":404.47,"fiftyTwoWeekLow":197.46}"#.utf8)
        )

        XCTAssertEqual(PresentedMarketItem.company("GOOG").id, "company:GOOG")
        XCTAssertEqual(PresentedMarketItem.fill(fill).id, "fill:fill-1")
        XCTAssertEqual(PresentedMarketItem.position(position).id, "position:GOOG")
        XCTAssertEqual(PresentedMarketItem.fill(fill).symbol, "GOOG")
        XCTAssertEqual(PresentedMarketItem.position(position).symbol, "GOOG")
        XCTAssertEqual(PresentedMarketItem.fill(fill).fill?.id, "fill-1")
        XCTAssertNil(PresentedMarketItem.company("GOOG").fill)
        XCTAssertEqual(PresentedMarketItem.position(position).position?.quantity, 10)
        XCTAssertEqual(quote.fiftyTwoWeekHigh, 404.47)
        XCTAssertEqual(quote.peRatio, 26.4)
        XCTAssertEqual(AppFormat.peRatioDisplay(peRatio: quote.peRatio, eps: quote.eps), "26.4")
        XCTAssertEqual(AppFormat.peRatioDisplay(peRatio: nil, eps: -1), "n/a")
        XCTAssertEqual(AppFormat.peRatioDisplay(peRatio: nil, eps: nil), "—")

        let desk = try JSONDecoder().decode(
            SymbolDeskInfo.self,
            from: Data(#"{"symbol":"GOOG","peerAccounts":[{"accountId":"ira","label":"Roth IRA","environment":"live","direction":"long","quantity":4}],"exit":{"style":"trailing","stopPrice":300,"takeProfitPrice":420,"trailPercent":6},"pending":[{"id":"p1","side":"buy","quantity":1,"rationale":"green team: still a hold"}]}"#.utf8)
        )
        XCTAssertEqual(desk.peerAccounts.first?.quantity, 4)
        XCTAssertEqual(desk.peerAccounts.first?.direction, "long")
        XCTAssertEqual(desk.exit?.style, "trailing")
        XCTAssertEqual(desk.pending.first?.side, "buy")
    }

    @MainActor
    func testCommandSafetyGatesReadinessAndStalenessButKeepsProtectiveActions() throws {
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(minimalSnapshotJSON.utf8))
        let store = MobileStore(
            client: MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!),
            previewSnapshot: snapshot
        )

        XCTAssertFalse(store.canSubmit("strategy.run_once"))
        XCTAssertFalse(store.canSubmit("strategy.start"))
        XCTAssertTrue(store.canSubmit("strategy.stop"))
        XCTAssertTrue(store.canSubmit("proposal.reject"))
        // Owner Approve stays available on a stale snapshot — Retry Red Team is a long
        // LLM, then `load()` can miss the 30s timeout and grey the button.  The server
        // re-validates the claim.
        XCTAssertTrue(store.canSubmit("proposal.approve", at: Date(timeIntervalSinceNow: 181)))
        XCTAssertTrue(store.canSubmit("proposal.approve"))
        // Account switch stays available even when the snapshot is stale — it is metadata-only
        // and the server executes it immediately outside the strategy.run_once queue.
        XCTAssertTrue(store.canSubmit("account.activate", at: Date(timeIntervalSinceNow: 181)))
        XCTAssertTrue(store.canSubmit("account.activate"))
        // Cancel is exempt too, and for a sharper reason: a stale snapshot usually means a flaky
        // connection, which is exactly when someone reaches for cancel.  Gating it there would
        // withhold the one lever that only ever reduces risk.  The server re-validates the order
        // (`requireWorkingOrder: true` → 404/409), so a stale tap collects an honest error rather
        // than cancelling the wrong thing.
        XCTAssertTrue(store.canSubmit("order.cancel", at: Date(timeIntervalSinceNow: 181)))
        XCTAssertTrue(store.canSubmit("order.cancel"))
        // Readiness gating is untouched by the exemption: this fixture has no account and no
        // universe, and the readiness-dependent commands above still refuse.
        XCTAssertFalse(store.canSubmit("strategy.run_once", at: Date(timeIntervalSinceNow: 181)))
    }

    func testSnapshotDefaultsOptionalCollectionsAndSummaries() throws {
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(minimalSnapshotJSON.utf8))

        XCTAssertTrue(snapshot.positions.isEmpty)
        XCTAssertTrue(snapshot.orders.isEmpty)
        XCTAssertTrue(snapshot.connectedAccounts.isEmpty)
        XCTAssertTrue(snapshot.alerts.isEmpty)
        XCTAssertEqual(snapshot.marketSession, "unknown")
        XCTAssertEqual(snapshot.dailyStats.orderCount, 0)
        XCTAssertNil(snapshot.scheduler.nextRunAt)
    }

    func testSSEAccumulatorDispatchesOncePerPayloadFrame() {
        var parser = SSEFrameAccumulator()
        let lines = [
            ": connected",
            "",
            "event: mobile.command",
            "data: {\"id\":\"one\"}",
            "",
            "event: dashboard.refresh",
            "data: {}",
            "",
            ": ping",
            ""
        ]

        let dispatches = lines.reduce(into: 0) { count, line in
            if parser.consume(line: line) { count += 1 }
        }

        XCTAssertEqual(dispatches, 2)
    }

    func testCloudflareOriginDownErrorsAreUserReadable() {
        let error = MobileAPIError.serverError(statusCode: 522, message: nil)
        let text = error.errorDescription ?? ""
        XCTAssertTrue(text.contains("unreachable"), text)
        XCTAssertFalse(text.lowercased().contains("cloudflare"), text)
        XCTAssertFalse(text.contains("522"), text)
        XCTAssertFalse(text.contains("/api/"), text)
    }

    func testMarketScanRequestOutlastsServerBudget() {
        let client = MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!)
        let request = client.marketScanRequest()

        XCTAssertEqual(request.url?.path, "/api/scan")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertGreaterThan(request.timeoutInterval, 20)
        XCTAssertGreaterThanOrEqual(request.timeoutInterval, MobileAPIClient.marketScanTimeout)
        XCTAssertEqual(MobileAPIClient.marketScanTimeout, 50)
    }

    func testEventsRequestUsesSSEAcceptAndLongTimeout() {
        let client = MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!)
        let request = client.eventsRequest()

        XCTAssertEqual(request.url?.path, "/api/mobile/events")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "accept"), "text/event-stream")
        XCTAssertEqual(request.value(forHTTPHeaderField: "cache-control"), "no-cache")
        XCTAssertGreaterThanOrEqual(request.timeoutInterval, 90)
        XCTAssertNotEqual(request.value(forHTTPHeaderField: "accept"), "application/json")
    }

    func testLiveApprovalPayloadMatchesBackendContract() {
        let confirmation = LiveApprovalConfirmation(
            proposalId: "proposal-1",
            accountNumber: nil,
            estimatedNotional: nil,
            typedText: "APPROVE LIVE AAPL"
        )

        XCTAssertEqual(confirmation.jsonObject["proposalId"] as? String, "proposal-1")
        XCTAssertEqual(confirmation.jsonObject["executionMode"] as? String, "broker/live")
        XCTAssertEqual(confirmation.jsonObject["typedText"] as? String, "APPROVE LIVE AAPL")
        XCTAssertNil(confirmation.jsonObject["accountNumber"])
        XCTAssertTrue(confirmation.jsonObject["estimatedNotional"] is NSNull)
    }

    func testLiveConfirmationPhraseNormalizesSymbol() {
        XCTAssertEqual(liveApprovalConfirmationText(forSymbol: " aapl "), "APPROVE LIVE AAPL")
    }

    // Rewritten 2026-08-12: this test predates the test target ever being RUNNABLE (a
    // TEST_HOST mismatch plus a module-name mismatch meant it had never executed), and
    // its original tail was authored against an imagined tracker that kept one attempt
    // per fingerprint.  The real tracker deliberately keeps ONE attempt per operationID
    // (a changed intent under the same operation REPLACES the old attempt — the old key
    // must never be reused for a different payload), while double-submit protection for
    // in-flight operations lives a layer up in MobileStore.busyOperations.  The
    // assertions below pin the real, safe semantics.
    func testCommandAttemptTrackerReusesOnlyTheSameUnresolvedAction() {
        var tracker = CommandAttemptTracker()
        let first = tracker.idempotencyKey(
            operationID: "proposal.approve:proposal-1",
            commandType: "proposal.approve",
            payload: ["proposalId": "proposal-1"]
        )
        let retry = tracker.idempotencyKey(
            operationID: "proposal.approve:proposal-1",
            commandType: "proposal.approve",
            payload: ["proposalId": "proposal-1"]
        )
        // Same operation, same intent: the key is reused so the server dedupes retries.
        XCTAssertEqual(first, retry)

        // A queued (non-terminal) command keeps the attempt alive: no resolution is
        // emitted and the key still dedupes further retries of the same intent.
        let queued = decodeCommand(
            #"{"id":"command-1","commandType":"proposal.approve","status":"queued","createdAt":"2026-07-21T17:30:00.000Z","updatedAt":"2026-07-21T17:30:00.000Z"}"#
        )
        tracker.track(queued, operationID: "proposal.approve:proposal-1")
        XCTAssertTrue(tracker.reconcile([queued]).isEmpty)
        XCTAssertEqual(
            first,
            tracker.idempotencyKey(
                operationID: "proposal.approve:proposal-1",
                commandType: "proposal.approve",
                payload: ["proposalId": "proposal-1"]
            )
        )

        // Changed intent under the same operation must NOT reuse the old key — the
        // stale attempt is replaced outright (one attempt per operationID).
        let changedIntent = tracker.idempotencyKey(
            operationID: "proposal.approve:proposal-1",
            commandType: "proposal.approve",
            payload: ["proposalId": "proposal-2"]
        )
        XCTAssertNotEqual(first, changedIntent)

        // A distinct operation tracks independently and resolves on its terminal
        // command; the resolved attempt is released, so a later retry of that same
        // operation mints a FRESH key (a retry after failure is a new command — the
        // server must not dedupe-swallow it).
        let secondOp = tracker.idempotencyKey(
            operationID: "proposal.approve:proposal-9",
            commandType: "proposal.approve",
            payload: ["proposalId": "proposal-9"]
        )
        let failed = decodeCommand(
            #"{"id":"command-9","commandType":"proposal.approve","status":"failed","error":"Proposal expired","createdAt":"2026-07-21T17:30:00.000Z","updatedAt":"2026-07-21T17:31:00.000Z"}"#
        )
        tracker.track(failed, operationID: "proposal.approve:proposal-9")
        XCTAssertEqual(
            tracker.reconcile([failed]),
            [CommandAttemptTracker.Resolution(
                operationID: "proposal.approve:proposal-9",
                status: "failed",
                error: "Proposal expired"
            )]
        )
        let resolvedThenRetried = tracker.idempotencyKey(
            operationID: "proposal.approve:proposal-9",
            commandType: "proposal.approve",
            payload: ["proposalId": "proposal-9"]
        )
        XCTAssertNotEqual(secondOp, resolvedThenRetried)
    }

    // Regression test for a hard crash: the server can legitimately report the same
    // command id twice in one snapshot (e.g. overlapping poll windows), and
    // `Dictionary(uniqueKeysWithValues:)` traps (fatalError, not catchable) on any
    // duplicate key. `reconcile` must fold duplicates instead of crashing.
    func testReconcileDoesNotCrashOnDuplicateCommandIdsAndKeepsTheFreshestByUpdatedAt() {
        var tracker = CommandAttemptTracker()
        _ = tracker.idempotencyKey(
            operationID: "proposal.approve:proposal-9",
            commandType: "proposal.approve",
            payload: ["proposalId": "proposal-9"]
        )
        let queued = decodeCommand(
            #"{"id":"command-9","commandType":"proposal.approve","status":"queued","createdAt":"2026-07-21T17:30:00.000Z","updatedAt":"2026-07-21T17:30:00.000Z"}"#
        )
        tracker.track(queued, operationID: "proposal.approve:proposal-9")

        // Two entries share id "command-9": a fresh terminal one and a stale queued
        // one. The stale (earlier `updatedAt`) duplicate is listed AFTER the fresh
        // one, so if this were picking by array position instead of the documented
        // last-wins-by-`updatedAt` policy, the assertion below would fail.
        let fresh = decodeCommand(
            #"{"id":"command-9","commandType":"proposal.approve","status":"failed","error":"Proposal expired","createdAt":"2026-07-21T17:30:00.000Z","updatedAt":"2026-07-21T17:32:00.000Z"}"#
        )
        let staleDuplicate = decodeCommand(
            #"{"id":"command-9","commandType":"proposal.approve","status":"queued","createdAt":"2026-07-21T17:30:00.000Z","updatedAt":"2026-07-21T17:30:00.000Z"}"#
        )

        let resolutions = tracker.reconcile([fresh, staleDuplicate])

        XCTAssertEqual(
            resolutions,
            [CommandAttemptTracker.Resolution(
                operationID: "proposal.approve:proposal-9",
                status: "failed",
                error: "Proposal expired"
            )]
        )
    }

    // Codex P2 (equal-timestamp tie): two versions of one command id can share an
    // `updatedAt` (server timestamps are ISO8601 at millisecond precision, so fast
    // transitions can collide).  The fold must prefer the terminal state on that tie —
    // otherwise a `[failed, queued]` pair with equal timestamps would keep the queued
    // entry and the tracked operation would never resolve.  Assert the terminal winner
    // for BOTH array orders, proving the fold is order-independent.
    func testReconcileDuplicateEqualUpdatedAtPrefersTerminalRegardlessOfArrayOrder() {
        let queued = decodeCommand(
            #"{"id":"command-9","commandType":"proposal.approve","status":"queued","createdAt":"2026-07-21T17:30:00.000Z","updatedAt":"2026-07-21T17:31:00.000Z"}"#
        )
        let failed = decodeCommand(
            #"{"id":"command-9","commandType":"proposal.approve","status":"failed","error":"Proposal expired","createdAt":"2026-07-21T17:30:00.000Z","updatedAt":"2026-07-21T17:31:00.000Z"}"#
        )
        for pair in [[failed, queued], [queued, failed]] {
            var tracker = CommandAttemptTracker()
            _ = tracker.idempotencyKey(
                operationID: "proposal.approve:proposal-9",
                commandType: "proposal.approve",
                payload: ["proposalId": "proposal-9"]
            )
            tracker.track(queued, operationID: "proposal.approve:proposal-9")
            XCTAssertEqual(
                tracker.reconcile(pair),
                [CommandAttemptTracker.Resolution(
                    operationID: "proposal.approve:proposal-9",
                    status: "failed",
                    error: "Proposal expired"
                )],
                "equal-updatedAt duplicates must resolve to the terminal entry in any array order"
            )
        }
    }

    // Codex P2 (shared duplicate handling): `proposalActionFeedback` reads the stored
    // `recentCommands`, while `reconcile` reads the same array through the tracker.  Both
    // now fold through `MobileCommand.foldDuplicate`, so pin the shared rule: freshest
    // `updatedAt` wins, and an exact `updatedAt` tie prefers the terminal state over a
    // queued one regardless of argument order.
    func testFoldDuplicateIsSharedDeterministicRuleAcrossLookups() {
        let oldQueued = decodeCommand(
            #"{"id":"command-9","commandType":"proposal.approve","status":"queued","createdAt":"2026-07-21T17:30:00.000Z","updatedAt":"2026-07-21T17:30:00.000Z"}"#
        )
        let oldFailed = decodeCommand(
            #"{"id":"command-9","commandType":"proposal.approve","status":"failed","error":"Proposal expired","createdAt":"2026-07-21T17:30:00.000Z","updatedAt":"2026-07-21T17:30:00.000Z"}"#
        )
        let newQueued = decodeCommand(
            #"{"id":"command-9","commandType":"proposal.approve","status":"queued","createdAt":"2026-07-21T17:30:00.000Z","updatedAt":"2026-07-21T17:32:00.000Z"}"#
        )
        // Freshest `updatedAt` wins even when the stale member is terminal.
        XCTAssertEqual(
            MobileCommand.foldDuplicate(existing: oldFailed, incoming: newQueued).updatedAt,
            newQueued.updatedAt
        )
        // Exact `updatedAt` tie: terminal wins in both argument orders.
        XCTAssertEqual(
            MobileCommand.foldDuplicate(existing: oldQueued, incoming: oldFailed).status,
            "failed"
        )
        XCTAssertEqual(
            MobileCommand.foldDuplicate(existing: oldFailed, incoming: oldQueued).status,
            "failed"
        )
        // Full tie (same timestamp, same terminality): existing wins — deterministic.
        XCTAssertEqual(
            MobileCommand.foldDuplicate(existing: newQueued, incoming: oldQueued).updatedAt,
            newQueued.updatedAt
        )
    }

    @MainActor
    func testSuccessfulDeletionHTTPAlwaysClearsLocalSessionWhenOptionalReceiptFieldsDrift() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MobileTestURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer {
            MobileTestURLProtocol.handler = nil
            session.invalidateAndCancel()
        }

        MobileTestURLProtocol.handler = { request in
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["content-type": "application/json"]
            )!
            if request.url?.path == "/api/mobile/account-deletion/request" {
                XCTAssertEqual(request.httpMethod, "GET")
                return (
                    response,
                    Data(#"{"deletionRequest":{"userId":"user-1","email":"owner@example.com","requiredText":"DELETE MY ACCOUNT","steps":["Confirm deletion"]}}"#.utf8)
                )
            }
            XCTAssertEqual(request.url?.path, "/api/mobile/account-deletion/confirm")
            XCTAssertEqual(request.httpMethod, "POST")
            // Current server fields are present, deletedUserId is intentionally absent, and the
            // optional logout URL is omitted to exercise the local fallback.
            return (response, Data(#"{"ok":true,"counts":{"alerts":1},"futureField":"ignored"}"#.utf8))
        }

        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(minimalSnapshotJSON.utf8))
        let store = MobileStore(
            client: MobileAPIClient(
                baseURL: URL(string: "https://socratictrade.com")!,
                session: session
            ),
            previewSnapshot: snapshot
        )

        await store.loadAccountDeletionPreview()
        XCTAssertNotNil(store.deletionRequest)
        let logoutURL = await store.confirmAccountDeletion(
            typedIdentity: "owner@example.com",
            typedText: "DELETE MY ACCOUNT"
        )

        XCTAssertFalse(store.isAuthenticated)
        XCTAssertNil(store.snapshot)
        XCTAssertEqual(logoutURL?.absoluteString, "https://socratictrade.com/logout")
    }

    @MainActor
    func testClearLocalSessionRemovesDiskSnapshot() throws {
        // The app caches the RAW response bytes (MobileStore.saveCachedSnapshot(rawData), fed by
        // client.snapshotData()); it never re-encodes a MobileSnapshot, which is why the model is
        // Decodable-only.  Seed the cache the same way the app writes it.
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(minimalSnapshotJSON.utf8))
        let data = Data(minimalSnapshotJSON.utf8)
        let cacheKey = "cached_mobile_snapshot_data"
        let cacheTimestampKey = "cached_mobile_snapshot_saved_at"
        let defaults = UserDefaults.standard
        defaults.set(data, forKey: cacheKey)
        defaults.set(Date(timeIntervalSince1970: 1_700_000_000).timeIntervalSince1970, forKey: cacheTimestampKey)

        let store = MobileStore(
            client: MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!),
            previewSnapshot: snapshot
        )
        store.clearLocalSession()

        XCTAssertNil(defaults.data(forKey: cacheKey))
        XCTAssertEqual(defaults.double(forKey: cacheTimestampKey), 0)
        XCTAssertFalse(store.isAuthenticated)
        XCTAssertNil(store.snapshot)
    }

    @MainActor
    func testInitUsesPersistedSnapshotTimestamp() throws {
        // The app caches the RAW response bytes (MobileStore.saveCachedSnapshot(rawData), fed by
        // client.snapshotData()); it never re-encodes a MobileSnapshot, which is why the model is
        // Decodable-only.  Seed the cache the same way the app writes it.
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(minimalSnapshotJSON.utf8))
        let data = Data(minimalSnapshotJSON.utf8)
        let cacheKey = "cached_mobile_snapshot_data"
        let cacheTimestampKey = "cached_mobile_snapshot_saved_at"
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let defaults = UserDefaults.standard
        defaults.set(data, forKey: cacheKey)
        defaults.set(savedAt.timeIntervalSince1970, forKey: cacheTimestampKey)
        defer {
            defaults.removeObject(forKey: cacheKey)
            defaults.removeObject(forKey: cacheTimestampKey)
        }

        let store = MobileStore(client: MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!))
        XCTAssertNotNil(store.snapshot)
        XCTAssertEqual(store.lastUpdatedAt?.timeIntervalSince1970, savedAt.timeIntervalSince1970)
    }

    @MainActor
    func testColdLaunchAfterSignOutDoesNotRestoreCachedSnapshot() throws {
        // The app caches the RAW response bytes (MobileStore.saveCachedSnapshot(rawData), fed by
        // client.snapshotData()); it never re-encodes a MobileSnapshot, which is why the model is
        // Decodable-only.  Seed the cache the same way the app writes it.
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(minimalSnapshotJSON.utf8))
        let data = Data(minimalSnapshotJSON.utf8)
        let cacheKey = "cached_mobile_snapshot_data"
        let cacheTimestampKey = "cached_mobile_snapshot_saved_at"
        let defaults = UserDefaults.standard
        defaults.set(data, forKey: cacheKey)
        defaults.set(Date().timeIntervalSince1970, forKey: cacheTimestampKey)

        let store = MobileStore(
            client: MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!),
            previewSnapshot: snapshot
        )
        store.clearLocalSession()

        let relaunched = MobileStore(client: MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!))
        XCTAssertNil(relaunched.snapshot)
        XCTAssertFalse(relaunched.isAuthenticated)
        XCTAssertNil(relaunched.lastUpdatedAt)

        defaults.removeObject(forKey: cacheKey)
        defaults.removeObject(forKey: cacheTimestampKey)
    }

    private func decodeCommand(_ json: String) -> MobileCommand {
        try! JSONDecoder().decode(MobileCommand.self, from: Data(json.utf8))
    }

    func testMobileCommandDecodesPlacementResult() throws {
        let command = decodeCommand(
            #"{"id":"cmd","commandType":"proposal.approve","status":"failed","error":"busy","result":{"status":"busy","outcome":"busy","reasons":["A strategy run is in progress."]},"createdAt":"2026-07-21T17:30:00.000Z","updatedAt":"2026-07-21T17:31:00.000Z"}"#
        )
        XCTAssertEqual(command.result?.status, "busy")
        XCTAssertEqual(command.result?.outcome, "busy")
        XCTAssertEqual(command.result?.reasons?.first, "A strategy run is in progress.")
    }

    private let minimalSnapshotJSON = #"""
    {
      "readiness": {
        "hasAccount": false,
        "hasUniverse": false,
        "systemState": "halted",
        "strategyAuthority": "propose",
        "selectedAccountNumber": null,
        "activeConnectedAccount": null,
        "commandBacklog": {"queued": 0, "running": 0}
      },
      "policy": {
        "systemState": "halted",
        "strategyAuthority": "propose"
      }
    }
    """#

    private let fullSnapshotJSON = #"""
    {
      "currentUser": {"userId":"user-1","email":"owner@example.com","name":"Owner","loginProvider":"apple","isAdmin":true},
      "readiness": {
        "hasAccount":true,
        "hasUniverse":true,
        "systemState":"active",
        "strategyAuthority":"propose",
        "selectedAccountNumber":"account-number",
        "activeConnectedAccount":{"id":"account-1","label":"Brokerage","broker":"robinhood","environment":"live","accountNumber":"account-number","isActive":true},
        "commandBacklog":{"queued":0,"running":0}
      },
      "policy": {
        "systemState":"active",
        "strategyAuthority":"propose",
        "accountNumber":"account-number",
        "connectedAccountId":"account-1",
        "includedIndices":["sp500"],
        "additionalSymbols":["AAPL"],
        "blocklist":[],
        "holdingHorizon":"swing",
        "runCadenceMinutes":30,
        "maxOrderNotional":2500,
        "maxOrderPctOfNav":5,
        "maxDailyNotional":10000,
        "maxDailyPctOfNav":20,
        "maxDailyOrders":8,
        "requireTypedConfirmation":true
      },
      "marketSession":"regular",
      "scheduler":{"lastRunAt":"2026-07-21T17:30:00.000Z","nextRunAt":"2026-07-21T18:00:00.000Z"},
      "portfolio":{"accountNumber":"account-number","totalMarketValue":25000,"buyingPower":7500,"equityMarketValue":20000,"optionMarketValue":0,"cash":5000},
      "positions":[{"symbol":"AAPL","quantity":10,"marketValue":2050,"averageCost":190,"sector":"Technology","industry":"Consumer Electronics"}],
      "orders":[{"id":"order-1","symbol":"AAPL","side":"buy","type":"limit","state":"filled","quantity":10,"filledQuantity":10,"averagePrice":190,"limitPrice":191,"timeInForce":"day","createdAt":"2026-07-21T15:00:00.000Z","updatedAt":"2026-07-21T15:01:00.000Z"}],
      "pendingProposals":[{"id":"proposal-1","createdAt":"2026-07-21T17:45:00.000Z","accountNumber":"account-number","executionMode":"broker/live","estimatedNotional":1500,"lastRevalidatedAt":"2026-07-21T17:50:00.000Z","revalidationNote":"Still valid","performanceSinceProposalPct":1.1,"proposalReferencePrice":200,"proposalCurrentPrice":202.2,"proposal":{"symbol":"AAPL","side":"buy","type":"limit","quantity":7,"limitPrice":201,"timeInForce":"day","rationale":"Rationale","greenTeamRationale":"Green rationale","tradeThesisTag":"quality","entryMarketRegime":"risk-on","confidenceScore":80,"proposedByModel":"openrouter/openai/gpt-5-mini","bracketTakeProfit":220,"bracketStopLoss":190,"exitPlan":"Trim a third at 220; trail the rest.","redTeamVerdict":{"verdict":"approve-at-half","rejected":false,"available":true,"reason":"Reduce concentration risk.","model":"openrouter/anthropic/claude-sonnet-4"}}}],
      "dailyStats":{"orderCount":2,"openingOrderCount":1,"notional":1500},
      "performance":{"liveRealizedPnl":125.5,"paperRealizedPnl":0,"liveUnrealizedPnl":40,"paperUnrealizedPnl":0,"liveWinRate":60,"paperWinRate":0,"liveAverageReturnPct":2.5,"paperAverageReturnPct":0,"benchmark":{"accountReturnPct":5.2,"benchmarkReturnPct":4,"excessReturnPct":1.2,"startDate":"2026-06-01","endDate":"2026-07-21","points":25,"benchmarkSymbol":"SPY","cashFlowAdjusted":true,"netExternalFlows":1000,"shadowValue":24000,"dollarExcess":1000,"accountEquitySeries":[{"date":"2026-06-01","value":20000},{"date":"2026-07-21","value":25000}],"shadowBenchmarkSeries":[{"date":"2026-06-01","value":20000},{"date":"2026-07-21","value":24000}]},"fills":[{"id":"fill-1","symbol":"AAPL","side":"buy","quantity":10,"price":190,"notional":1900,"status":"filled","filledAt":"2026-07-21T15:01:00.000Z"}]},
      "connectedAccounts":[{"id":"account-1","label":"Brokerage","broker":"robinhood","environment":"live","accountNumber":"account-number","isActive":true,"capabilities":{"equityTrading":true,"shortSelling":false,"optionsTrading":true,"optionsLevel":2,"marginEnabled":true,"accountType":"brokerage"}}],
      "watchlist":[{"symbol":"MSFT","addedAt":"2026-07-20T12:00:00.000Z"}],
      "alerts":[{"id":"alert-1","symbol":"AAPL","op":">","price":200,"note":"Breakout","status":"triggered","createdAt":"2026-07-20T12:00:00.000Z","triggeredAt":"2026-07-21T15:00:00.000Z","triggeredPrice":205}],
      "notifications":[{"id":"note-1","createdAt":"2026-07-21T17:32:00.000Z","type":"run_failed","title":"Strategy Run Failed","body":"Sent","read":false,"status":"sent","acknowledgedAt":null,"connectedAccountId":"account-1","accountLabel":"Brokerage"}],
      "strategyRuns":[{"id":"run-1","startedAt":"2026-07-21T17:30:00.000Z","finishedAt":"2026-07-21T17:31:00.000Z","status":"failed","summary":"strategy gather timeout","connectedAccountId":"account-1","placedCount":0,"paperCount":0,"blockedCount":0,"proposedCount":0,"totalCount":0,"failure":"This strategy run stopped because gathering market data took too long.  The next run will try again."}],
      "unifiedFeed":[{"id":"feed-1","title":"Strategy Run Failed","detail":"strategy gather timeout","status":"failed","updatedAt":"2026-07-21T17:31:00.000Z","accountLabel":"Brokerage","failure":"This strategy run stopped because gathering market data took too long.  The next run will try again."}],
      "recentCommands":[{"id":"command-1","commandType":"strategy.run_once","status":"succeeded","error":null,"createdAt":"2026-07-21T17:30:00.000Z","queuedAt":"2026-07-21T17:30:00.000Z","startedAt":"2026-07-21T17:30:01.000Z","finishedAt":"2026-07-21T17:31:00.000Z","updatedAt":"2026-07-21T17:31:00.000Z"}]
    }
    """#
}

private final class MobileTestURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
