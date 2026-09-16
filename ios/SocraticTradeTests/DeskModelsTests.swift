import XCTest
@testable import SocraticTrade

final class DeskModelsTests: XCTestCase {
    func testCoachProviderRoutingMatchesChatCatalog() {
        XCTAssertEqual(CoachModelCatalog.provider(for: "claude-sonnet-5"), "anthropic")
        XCTAssertEqual(CoachModelCatalog.provider(for: "grok-4.5"), "xai")
        XCTAssertEqual(CoachModelCatalog.provider(for: "gemini-flash-latest"), "gemini")
        XCTAssertEqual(CoachModelCatalog.provider(for: "mistral-medium"), "mistral")
        XCTAssertEqual(CoachModelCatalog.provider(for: "deepseek-reasoner"), "deepseek")
        XCTAssertEqual(CoachModelCatalog.provider(for: "kimi-latest"), "moonshot")
        XCTAssertEqual(CoachModelCatalog.provider(for: "gpt-5.4-mini"), "openai")
        // No "mock" branch.  PR #2887 removed the "Mock (offline)" option, its provider branch and
        // its availability bypass: a keyless offline model is exactly the mock/demo path the
        // product rules forbid.  An unrecognised id therefore falls through to the OpenAI-family
        // default rather than resolving to a fake provider.
        XCTAssertEqual(CoachModelCatalog.provider(for: "mock"), "openai")
        XCTAssertEqual(CoachModelCatalog.provider(for: "something-unrecognised"), "openai")
    }

    func testFirstAvailableRequiresAKeyedProvider() {
        XCTAssertEqual(
            CoachModelCatalog.firstAvailable(providers: ["anthropic": true])?.id,
            "claude-haiku-latest"
        )
        // With no key for any provider there is NO keyless option left to offer (#2887), so the
        // caller gets nil and must say "no model configured" rather than silently answering from
        // a fake one.
        XCTAssertNil(CoachModelCatalog.firstAvailable(providers: [:]))
        XCTAssertNil(CoachModelCatalog.firstAvailable(providers: ["anthropic": false]))
    }

    func testAuthorityCopyNeverCallsAutopilotARunState() {
        let copy = DeskCopy.authorityVersusRunState(authority: "decide", runState: .pausedMarketClosed)
        XCTAssertTrue(copy.contains("Autopilot"))
        XCTAssertTrue(copy.contains("Paused · market closed"))
        XCTAssertFalse(copy.contains("Autopilot is Running"))
    }

    func testScanCandidateDecodesSparseRows() throws {
        let json = Data(#"""
        {
          "topCandidates": [
            {"symbol":"AAPL","price":210.5,"score":81.2,"intradayChangePct":1.4,"sector":"Technology","industry":"Consumer Electronics","companyName":"Apple Inc."},
            {"symbol":"MSFT"}
          ],
          "asOf":"2026-08-13T15:00:00.000Z",
          "scannedSymbols": 503,
          "returnedQuotes": 498,
          "warnings": ["The delayed screener returned no quotes; the quote fallback priced 498 of 503 names."]
        }
        """#.utf8)
        let scan = try JSONDecoder().decode(MarketScanResponse.self, from: json)
        XCTAssertEqual(scan.topCandidates.count, 2)
        XCTAssertEqual(scan.topCandidates[0].symbol, "AAPL")
        XCTAssertEqual(scan.topCandidates[0].companyName, "Apple Inc.")
        XCTAssertEqual(scan.topCandidates[0].industry, "Consumer Electronics")
        XCTAssertEqual(scan.topCandidates[0].price, 210.5)
        XCTAssertEqual(scan.topCandidates[1].symbol, "MSFT")
        XCTAssertNil(scan.topCandidates[1].price)
        XCTAssertEqual(scan.asOf, "2026-08-13T15:00:00.000Z")
        XCTAssertEqual(scan.scannedSymbols, 503)
        XCTAssertEqual(scan.returnedQuotes, 498)
        XCTAssertEqual(scan.warnings.count, 1)
        XCTAssertEqual(
            DeskCopy.scanCountLine(names: 2, scanned: scan.scannedSymbols, quotes: scan.returnedQuotes, watched: 2),
            "2 names · 503 scanned · 498 quotes · 2 watched"
        )
    }

    func testScanQuotesUnavailable503DecodesAbortReceipt() throws {
        let json = Data(#"""
        {
          "error": "Quotes were unavailable for this universe.  Refresh after the quote feed recovers.",
          "code": "scan_quotes_unavailable",
          "scannedSymbols": 505,
          "returnedQuotes": 0,
          "warnings": [
            "This operation was aborted",
            "Live Nasdaq screener data was unavailable; showing the latest completed strategy scan as a stale fallback."
          ],
          "topCandidates": []
        }
        """#.utf8)
        let scan = try JSONDecoder().decode(MarketScanResponse.self, from: json)
        XCTAssertEqual(scan.scannedSymbols, 505)
        XCTAssertEqual(scan.returnedQuotes, 0)
        XCTAssertEqual(scan.topCandidates.count, 0)
        XCTAssertEqual(scan.warnings.first, "This operation was aborted")
        XCTAssertEqual(
            DeskCopy.scanCountLine(names: 0, scanned: scan.scannedSymbols, quotes: scan.returnedQuotes, watched: 2),
            "0 names · 505 scanned · 0 quotes · 2 watched"
        )
        // errorDescription is a pure function of `scan.warnings`: it joins EVERY non-empty warning
        // with the two-space sentence gap.  Showing only the first would hide the half that tells
        // the owner what they are actually looking at (a stale fallback scan), so the joined form
        // is the intended behavior and the assertion follows it.  The presence or absence of the
        // top-level "error"/"code" fields does not change this — see the second decode below.
        let error = MobileAPIError.scanQuotesUnavailable(scan)
        XCTAssertEqual(
            error.errorDescription,
            "This operation was aborted  Live Nasdaq screener data was unavailable; showing the latest completed strategy scan as a stale fallback."
        )
        XCTAssertFalse((error.errorDescription ?? "").localizedCaseInsensitiveContains("Guardrails"))
        XCTAssertFalse((error.errorDescription ?? "").localizedCaseInsensitiveContains("No Candidates"))

        let joinedJSON = Data(#"""
        {
          "scannedSymbols": 505,
          "returnedQuotes": 0,
          "warnings": [
            "This operation was aborted",
            "Live Nasdaq screener data was unavailable; showing the latest completed strategy scan as a stale fallback."
          ],
          "topCandidates": []
        }
        """#.utf8)
        // Same warnings, but a body with NO top-level "error"/"code" (an older or partial server
        // shape).  The message the owner sees must be identical either way — the warnings are the
        // only input.
        let joinedScan = try JSONDecoder().decode(MarketScanResponse.self, from: joinedJSON)
        let joined = MobileAPIError.scanQuotesUnavailable(joinedScan)
        XCTAssertEqual(
            joined.errorDescription,
            "This operation was aborted  Live Nasdaq screener data was unavailable; showing the latest completed strategy scan as a stale fallback."
        )
    }

    func testFailedRefreshKeepsLastGoodUniverse() {
        let lastGood = MarketScanResponse(
            topCandidates: [
                ScanCandidate(symbol: "BRK-B", companyName: "Berkshire Hathaway", price: 500, score: 88),
                ScanCandidate(symbol: "GOOG", price: 180, score: 86)
            ],
            asOf: "2026-08-18T19:25:13.000Z",
            generatedAt: "2026-08-18T19:25:13.000Z",
            scannedSymbols: 5073,
            returnedQuotes: 5069
        )
        let failed = MarketScanResponse(
            topCandidates: [],
            scannedSymbols: 5073,
            returnedQuotes: 0,
            warnings: ["This operation was aborted"]
        )
        let kept = failed.keepingLastGood(from: lastGood)
        XCTAssertEqual(kept.topCandidates.map(\.symbol), ["BRK-B", "GOOG"])
        XCTAssertEqual(kept.scannedSymbols, 5073)
        XCTAssertTrue(lastGood.hasUsableUniverse)
        XCTAssertFalse(failed.hasUsableUniverse)

        let banner = DeskCopy.scanRefreshFailedBanner(
            reason: MobileAPIError.serverError(statusCode: 503, message: nil).errorDescription ?? "",
            lastGoodAt: lastGood.lastGoodStamp
        )
        XCTAssertTrue(banner.contains("Showing the last good scan from"))
        XCTAssertFalse(banner.contains("503"))
        XCTAssertFalse(banner.lowercased().contains("http"))
    }

    func testChatTurnAndSourceValueDecode() throws {
        let turn = try JSONDecoder().decode(
            ChatTurn.self,
            from: Data(#"{"role":"assistant","text":"Hello","citations":["10-K"]}"#.utf8)
        )
        XCTAssertFalse(turn.isUser)
        XCTAssertEqual(turn.text, "Hello")
        XCTAssertEqual(turn.citations, ["10-K"])

        XCTAssertEqual(
            try JSONDecoder().decode(SourceSettingValue.self, from: Data("true".utf8)),
            .bool(true)
        )
        XCTAssertEqual(
            try JSONDecoder().decode(SourceSettingValue.self, from: Data("12".utf8)),
            .number(12)
        )
        XCTAssertEqual(
            try JSONDecoder().decode(SourceSettingValue.self, from: Data("null".utf8)),
            .none
        )
        XCTAssertEqual(
            try JSONDecoder().decode(SourceSettingValue.self, from: Data("12".utf8)).numberValue,
            12
        )
    }

    func testLlmBudgetResponseDecodesNullCaps() throws {
        let json = Data(#"""
        {
          "ok": true,
          "tokenBudget": null,
          "costBudgetUsd": 12.5,
          "effective": {
            "tokenLimit": null,
            "costLimitUsd": 12.5,
            "tokenSource": "none",
            "costSource": "user"
          },
          "today": { "tokens": 800, "costUsd": 1.25 },
          "enforced": true
        }
        """#.utf8)
        let budget = try JSONDecoder().decode(LlmBudgetResponse.self, from: json)
        XCTAssertNil(budget.tokenBudget)
        XCTAssertEqual(budget.costBudgetUsd, 12.5)
        XCTAssertEqual(budget.today.tokens, 800)
        XCTAssertTrue(budget.enforced)
        XCTAssertEqual(budget.effective.costSource, "user")
    }

    func testIraWashSaleCopyMatchesWebNA() {
        XCTAssertTrue(DeskCopy.isIraTaxation("roth_ira"))
        XCTAssertTrue(DeskCopy.isIraTaxation(" traditional_ira "))
        XCTAssertTrue(DeskCopy.isIraTaxation("Roth IRA"))
        XCTAssertTrue(DeskCopy.isIraTaxation("Traditional IRA"))
        XCTAssertFalse(DeskCopy.isIraTaxation("taxable"))
        XCTAssertFalse(DeskCopy.isIraTaxation("brokerage"))
        XCTAssertTrue(
            DeskCopy.isIraAccount(
                accountTaxation: nil,
                capabilityType: "brokerage",
                policyTaxation: "roth_ira"
            )
        )

        XCTAssertEqual(
            DeskCopy.resolvedTaxationType(
                accountTaxation: "roth_ira",
                capabilityType: "brokerage",
                policyTaxation: "taxable"
            ),
            "roth_ira"
        )

        let disregarded = DeskCopy.iraWashSaleRows(handling: "disregard")
        XCTAssertEqual(disregarded.sameAccount, "not applicable")
        XCTAssertEqual(disregarded.crossAccount, "ignored")

        let auto = DeskCopy.iraWashSaleRows(handling: "auto")
        XCTAssertEqual(auto.crossAccount, "auto")

        let blocked = DeskCopy.iraWashSaleRows(handling: "block")
        XCTAssertEqual(blocked.sameAccount, "not applicable")
        XCTAssertEqual(blocked.crossAccount, "blocked")

        let missing = DeskCopy.iraWashSaleRows(handling: nil)
        XCTAssertEqual(missing.crossAccount, "ignored")
    }

    /// web-ios-contract-drift (docs/reviews/2026-08-18-work-items.json): stopLossPct/
    /// trailingStopPct/shortStopLossPct live under `riskRules` in the real GET /api/policy
    /// payload (src/lib/types.ts's RiskRules interface).  The fixture this test decodes is NOT
    /// hand-typed — it is generated straight from that route's real output by
    /// test/policy-ios-contract-fixture.test.ts and checked in at
    /// ios/SocraticTradeTests/Fixtures/policy-contract.json, so a future server-side rename of
    /// `riskRules` (or of any of these three fields) changes the checked-in fixture and this
    /// test starts asserting against stale values — catching the drift in CI instead of on a
    /// phone screen.  Re-run `npm test -- policy-ios-contract-fixture` to refresh the fixture
    /// after any policy/riskRules shape change, then re-run this test.
    func testFullPolicyDecodesNestedRiskRulesFromGeneratedFixture() throws {
        guard let fixtureURL = Bundle(for: Self.self).url(forResource: "policy-contract", withExtension: "json") else {
            XCTFail(
                "ios/SocraticTradeTests/Fixtures/policy-contract.json not found in the test bundle. " +
                "Run `npm test -- policy-ios-contract-fixture` in the repo root to generate it, then commit the result."
            )
            return
        }
        let json = try Data(contentsOf: fixtureURL)
        let policy = try JSONDecoder().decode(FullPolicy.self, from: json)

        // Values the generator pins (test/policy-ios-contract-fixture.test.ts's
        // CONTRACT_RISK_RULES) — deliberately non-default so a decoder reading the wrong key,
        // or silently falling back to a default, is caught rather than coincidentally matching.
        XCTAssertEqual(policy.stopLossPct, 8)
        XCTAssertEqual(policy.trailingStopPct, 3)
        XCTAssertEqual(policy.shortStopLossPct, 5)
    }

    func testFullPolicyDecodesIraWashSaleHandling() throws {
        let json = Data(#"""
        {
          "taxSettings": {
            "taxationType": "roth_ira",
            "washSaleGuard": true,
            "washSaleHandling": "block",
            "iraWashSaleHandling": "disregard",
            "washSaleMinLossUsd": 50,
            "shortTermRatePct": 24,
            "longTermRatePct": 15
          }
        }
        """#.utf8)
        let policy = try JSONDecoder().decode(FullPolicy.self, from: json)
        XCTAssertEqual(policy.taxSettings?.taxationType, "roth_ira")
        XCTAssertEqual(policy.taxSettings?.iraWashSaleHandling, "disregard")
        XCTAssertEqual(policy.taxSettings?.washSaleMinLossUsd, 50)
        XCTAssertTrue(DeskCopy.isIraTaxation(policy.taxSettings?.taxationType))
    }

    func testFullPolicyDecodesNestedRiskRulesStopPercents() throws {
        let json = Data(#"""
        {
          "systemState": "enabled",
          "strategyAuthority": "propose",
          "holdingHorizon": "swing",
          "runCadenceMinutes": 60,
          "maxDailyOrders": 20,
          "riskRules": {
            "stopLossPct": 8,
            "trailingStopPct": 5,
            "shortStopLossPct": 10
          }
        }
        """#.utf8)
        let policy = try JSONDecoder().decode(FullPolicy.self, from: json)
        XCTAssertEqual(policy.stopLossPct, 8)
        XCTAssertEqual(policy.trailingStopPct, 5)
        XCTAssertEqual(policy.shortStopLossPct, 10)
    }

    func testModelSeatValueNeverShowsTheRotateSentinel() {
        XCTAssertEqual(DeskCopy.modelSeatValue("__rotate__"), "rotate models")
        XCTAssertEqual(DeskCopy.modelSeatValue(" __ROTATE__ "), "rotate models")
        XCTAssertEqual(
            DeskCopy.modelSeatValue("__rotate__", fallbacks: ["google/gemini-3.7-flash"]),
            "rotate models"
        )
        XCTAssertEqual(DeskCopy.modelSeatValue("claude-sonnet-5"), "claude-sonnet-5")
        XCTAssertEqual(DeskCopy.modelSeatValue(nil), "—")
        XCTAssertFalse(DeskCopy.modelSeatValue("__rotate__").contains("_"))
        XCTAssertFalse(DeskCopy.modelSeatValue("__rotate__").contains("rotate__"))
    }

    func testJoinedListAndYesNoAreSentenceCaseValues() {
        XCTAssertEqual(DeskCopy.joinedList(["QQQ", "SPY"]), "QQQ, SPY")
        XCTAssertEqual(DeskCopy.joinedList([]), "none")
        XCTAssertEqual(DeskCopy.yesNo(true), "yes")
        XCTAssertEqual(DeskCopy.yesNo(nil), "—")
    }

    func testIndexUniverseLabelsMatchTheWebMapAndNeverShowSlugs() {
        let expected: [(String, String)] = [
            ("sp100", "S&P 100"),
            ("sp500", "S&P 500"),
            ("nasdaq100", "Nasdaq 100"),
            ("nasdaqComposite", "Nasdaq Composite"),
            ("dow30", "Dow 30"),
            ("russell2000", "Russell 2000"),
            ("nyseComposite", "NYSE Composite"),
            ("ftWilshire5000", "FT Wilshire 5000")
        ]
        XCTAssertEqual(DeskCopy.indexUniverseLabels.count, expected.count)
        for (slug, label) in expected {
            XCTAssertEqual(DeskCopy.indexUniverseLabel(slug), label)
            XCTAssertNotEqual(label, slug)
        }
        XCTAssertEqual(DeskCopy.joinedIndexList(["sp500", "russell2000"]), "S&P 500, Russell 2000")
        XCTAssertTrue(DeskCopy.universeNeedsIndex.contains("S&P 500"))
        XCTAssertFalse(DeskCopy.universeNeedsIndex.contains("Strategy page"))
        XCTAssertEqual(DeskCopy.openGuardrailsButton, "Open Guardrails")
        XCTAssertEqual(
            DeskCopy.accountNeedsConnection,
            "Use Open Connections to connect a broker account on the website, then select the account here."
        )
        XCTAssertFalse(DeskCopy.accountNeedsConnection.contains("Alpaca"))
        XCTAssertFalse(DeskCopy.accountNeedsConnection.contains("Robinhood"))
        XCTAssertEqual(
            DeskCopy.joinedIndexList(["sp500", "nasdaqComposite", "dow30", "nyseComposite"]),
            "S&P 500, Nasdaq Composite, Dow 30, NYSE Composite"
        )
        XCTAssertEqual(DeskCopy.joinedIndexList(["sp500", "not-an-index"]), "S&P 500")
        XCTAssertEqual(DeskCopy.joinedIndexList([]), "none")
        XCTAssertEqual(DeskCopy.joinedIndexList(["mysteryIndex"]), "none")
        XCTAssertFalse(DeskCopy.joinedIndexList(["sp500", "nasdaq100"]).contains("sp500"))
        XCTAssertFalse(DeskCopy.joinedIndexList(["sp500", "nasdaq100"]).contains("nasdaq100"))
    }

    func testNewTabsStayCustomizableAndMoreDoesNot() {
        for tab in [AppTab.coach, .scan, .guardrails, .results] {
            XCTAssertTrue(AppTab.customizable.contains(tab), "\(tab)")
        }
        XCTAssertFalse(AppTab.customizable.contains(.more))
        XCTAssertFalse(AppTab.customizable.contains(.admin), "Admin is not a pin for a non-operator")
        XCTAssertTrue(AppTab.customizable(isAdmin: true).contains(.admin))
        XCTAssertEqual(AppTab.admin.title, "Admin")
        XCTAssertEqual(AppTab.coach.title, "Coach")
        XCTAssertEqual(AppTab.scan.title, "Scan")
        XCTAssertEqual(AppTab.guardrails.title, "Guardrails")
        XCTAssertEqual(AppTab.results.title, "Results")
        XCTAssertFalse(AppTab.markets.detail.lowercased().contains("price alert"))
        XCTAssertFalse(AppTab.customizable(isAdmin: true).contains(.more))
    }
}

/// Commit rule for every numeric settings field.  These exist because the bug they cover
/// was invisible: `commit()` ran only from `.onSubmit`, and a `.decimalPad` has no Return
/// key, so a typed number was discarded on tap-away with no PATCH and no message.
final class NumberFieldEditorTests: XCTestCase {
    // MARK: - The data-loss case (empty not allowed: data-source rows)

    func testTypedNumberIsSentWhenItDiffersFromTheStoredValue() {
        XCTAssertEqual(
            NumberFieldEditor.decide(text: "12", serverValue: 5, allowsEmpty: false),
            .patch(12)
        )
    }

    func testUnchangedValueCostsNoRoundTrip() {
        XCTAssertEqual(NumberFieldEditor.decide(text: "5", serverValue: 5, allowsEmpty: false), .unchanged)
        // …including when only the formatting differs.
        XCTAssertEqual(NumberFieldEditor.decide(text: " 5.0 ", serverValue: 5, allowsEmpty: false), .unchanged)
    }

    func testGarbageRevertsRatherThanSilentlyDoingNothing() {
        for text in ["", "   ", "abc", "1.2.3", "--4"] {
            XCTAssertEqual(
                NumberFieldEditor.decide(text: text, serverValue: 5, allowsEmpty: false),
                .revert,
                "\(text.debugDescription) should put the stored value back"
            )
        }
    }

    func testNegativeAndNonFiniteAreRefused() {
        XCTAssertEqual(NumberFieldEditor.decide(text: "-1", serverValue: 5, allowsEmpty: false), .revert)
        XCTAssertEqual(NumberFieldEditor.decide(text: "inf", serverValue: 5, allowsEmpty: false), .revert)
        XCTAssertEqual(NumberFieldEditor.decide(text: "nan", serverValue: 5, allowsEmpty: false), .revert)
        // A field that genuinely allows negatives opts out.
        XCTAssertEqual(
            NumberFieldEditor.decide(text: "-1", serverValue: 5, allowsEmpty: false, minimum: nil),
            .patch(-1)
        )
    }

    func testFirstEntryAgainstNoStoredValueStillSends() {
        XCTAssertEqual(NumberFieldEditor.decide(text: "3", serverValue: nil, allowsEmpty: false), .patch(3))
    }

    // MARK: - The "blank = no cap" case (LLM budget)

    func testBlankClearsTheValueWhereBlankIsMeaningful() {
        XCTAssertEqual(NumberFieldEditor.decide(text: "", serverValue: 100, allowsEmpty: true), .patch(nil))
    }

    func testBlankAgainstAnAlreadyEmptyValueSendsNothing() {
        // Otherwise merely focusing and leaving an empty cap field would PATCH null on
        // every pass, which is what the unchanged branch exists to prevent.
        XCTAssertEqual(NumberFieldEditor.decide(text: "", serverValue: nil, allowsEmpty: true), .unchanged)
        XCTAssertEqual(NumberFieldEditor.decide(text: "  ", serverValue: nil, allowsEmpty: true), .unchanged)
    }

    func testZeroIsAValueNotAnAbsence() {
        XCTAssertEqual(NumberFieldEditor.decide(text: "0", serverValue: nil, allowsEmpty: true), .patch(0))
        XCTAssertEqual(NumberFieldEditor.decide(text: "0", serverValue: 0, allowsEmpty: true), .unchanged)
    }

    // MARK: - Parsing

    func testCommaDecimalLocalesAreNotThrownAway() {
        // `.decimalPad` prints the DEVICE locale's separator, and `Double("1,5")` is nil —
        // without the formatter fallback the blur-commit added to STOP input being
        // discarded would itself discard input across much of the world.
        XCTAssertEqual(NumberFieldEditor.parse("1,5", locale: Locale(identifier: "de_DE")), 1.5)
        XCTAssertEqual(NumberFieldEditor.parse("1.5", locale: Locale(identifier: "en_US")), 1.5)
        XCTAssertNil(NumberFieldEditor.parse("abc", locale: Locale(identifier: "en_US")))
    }

    func testWholeNumbersDisplayWithoutATrailingPointZero() {
        // The field must not visibly rewrite "5" into "5.0" the instant it is committed.
        XCTAssertEqual(NumberFieldEditor.display(5), "5")
        XCTAssertEqual(NumberFieldEditor.display(5.25), "5.25")
        XCTAssertEqual(NumberFieldEditor.display(nil), "")
        XCTAssertEqual(NumberFieldEditor.display(.nan), "")
    }

    func testDisplayRoundTripsThroughDecideAsUnchanged() {
        for value in [0.0, 1, 5, 42.5, 1000, 0.25] {
            XCTAssertEqual(
                NumberFieldEditor.decide(
                    text: NumberFieldEditor.display(value),
                    serverValue: value,
                    allowsEmpty: false
                ),
                .unchanged,
                "\(value) rendered then re-read should be a no-op"
            )
        }
    }
}
