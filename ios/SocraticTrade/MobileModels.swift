import Foundation

struct MobileSnapshot: Decodable {
    let currentUser: CurrentUser?
    /// Server-advertised control catalog.  Optional: a server that predates it (or any
    /// payload where it is absent) leaves this nil and the app falls back to its built-in
    /// controls — see `MobileStore.serverAdvertises`.
    let catalog: ControlCatalog?
    let readiness: Readiness
    let policy: PolicySummary
    let marketSession: String
    let scheduler: SchedulerSummary
    let portfolio: PortfolioSummary?
    let positions: [Position]
    let orders: [EquityOrder]
    let pendingProposals: [PendingProposal]
    let dailyStats: DailyStats
    let performance: PerformanceSummary?
    let connectedAccounts: [ConnectedAccount]
    let watchlist: [WatchlistItem]
    let alerts: [PriceAlert]
    /// Persisted notification inbox (last 100).  Missing on older payloads.
    let notifications: [NotificationHistoryItem]
    /// Compact strategy-run rows for Activity → Strategy Runs.  Missing on older payloads.
    let strategyRuns: [StrategyRunItem]
    /// Compact unified-feed groups for Activity → Audit Log.  Missing on older payloads.
    let unifiedFeed: [ActivityAuditItem]
    let recentCommands: [MobileCommand]
    /// Last-good `/api/scan` universe.  Same seed `/console/scan` keeps when Refresh 503s.
    let latestScan: MarketScanResponse?
    /// Native weekly value + momentum screens.  Missing on older payloads.
    let weeklyMarketDigest: WeeklyMarketDigest?

    private enum CodingKeys: String, CodingKey {
        case currentUser
        case catalog
        case readiness
        case policy
        case marketSession
        case scheduler
        case portfolio
        case positions
        case orders
        case pendingProposals
        case dailyStats
        case performance
        case connectedAccounts
        case watchlist
        case alerts
        case notifications
        case strategyRuns
        case unifiedFeed
        case recentCommands
        case latestScan
        case weeklyMarketDigest
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        currentUser = try values.decodeIfPresent(CurrentUser.self, forKey: .currentUser)
        // `try?`, not `try`: `decodeIfPresent` returns nil only for a MISSING or null key — a
        // catalog of the wrong SHAPE (`"catalog": "v2"`, `commands` not an array, an element
        // without a string `type`) throws, and that throw would propagate out of this initializer
        // and fail the WHOLE snapshot decode, blanking the app over a field it treats as
        // optional.  A catalog that cannot be read must land on nil, which `serverAdvertises`
        // reads as "the server did not answer" and falls back to the built-in controls.
        catalog = (try? values.decodeIfPresent(ControlCatalog.self, forKey: .catalog)) ?? nil
        // Fail closed: a missing or wrong-shape `readiness` must not become a
        // snapshot that presents as consented (`needsAppConsent: false`).  Same
        // for `policy` — substituting `systemState: "stopped"` would hide an
        // actually active strategy.  Inner fields of a valid object still have
        // older-payload defaults in their own decoders.
        readiness = try values.decode(Readiness.self, forKey: .readiness)
        policy = try values.decode(PolicySummary.self, forKey: .policy)
        marketSession = try values.decodeIfPresent(String.self, forKey: .marketSession) ?? "unknown"
        scheduler = try values.decodeIfPresent(SchedulerSummary.self, forKey: .scheduler) ?? .empty
        portfolio = try values.decodeIfPresent(PortfolioSummary.self, forKey: .portfolio)
        positions = try values.decodeIfPresent([Position].self, forKey: .positions) ?? []
        orders = try values.decodeIfPresent([EquityOrder].self, forKey: .orders) ?? []
        pendingProposals = try values.decodeIfPresent([PendingProposal].self, forKey: .pendingProposals) ?? []
        dailyStats = try values.decodeIfPresent(DailyStats.self, forKey: .dailyStats) ?? .empty
        // try?: performance is display-only enrichment — a malformed sub-field (this is
        // exactly where the equity-curve date/timestamp mismatch lived) must degrade to
        // "no performance section", never blank the whole workspace.
        performance = (try? values.decodeIfPresent(PerformanceSummary.self, forKey: .performance)) ?? nil
        connectedAccounts = try values.decodeIfPresent([ConnectedAccount].self, forKey: .connectedAccounts) ?? []
        watchlist = try values.decodeIfPresent([WatchlistItem].self, forKey: .watchlist) ?? []
        alerts = try values.decodeIfPresent([PriceAlert].self, forKey: .alerts) ?? []
        notifications = try values.decodeIfPresent([NotificationHistoryItem].self, forKey: .notifications) ?? []
        // try?: a malformed new field must not blank the whole snapshot.
        strategyRuns = (try? values.decodeIfPresent([StrategyRunItem].self, forKey: .strategyRuns)) ?? []
        unifiedFeed = (try? values.decodeIfPresent([ActivityAuditItem].self, forKey: .unifiedFeed)) ?? []
        recentCommands = try values.decodeIfPresent([MobileCommand].self, forKey: .recentCommands) ?? []
        latestScan = try values.decodeIfPresent(MarketScanResponse.self, forKey: .latestScan)
        weeklyMarketDigest = try values.decodeIfPresent(WeeklyMarketDigest.self, forKey: .weeklyMarketDigest)
    }

    var unreadNotificationCount: Int {
        notifications.filter { !$0.read }.count
    }

    func inScopeNotifications(activeAccountId: String?) -> [NotificationHistoryItem] {
        guard let activeAccountId else { return notifications }
        return notifications.filter { item in
            guard let accountId = item.connectedAccountId else { return true }
            return accountId == activeAccountId
        }
    }
}

/// The server's own description of what this deployment's mobile control plane offers —
/// `catalog: mobileControlCatalog()` in app/api/mobile/snapshot/route.ts.  The catalog is
/// built in src/lib/mobile-api.ts:
///
///     commands: MOBILE_COMMAND_TYPES.map((type) => ({ type }))
///
/// so `commands[].type` is exactly the set of `commandType` values `/api/mobile/commands`
/// will accept (`isMobileCommandType`).  Only the fields the app actually acts on are
/// decoded; `auth`, `realtime`, and `accountDeletion` are deliberately left out rather than
/// mirrored into dead model surface.
struct ControlCatalog: Decodable, Equatable {
    struct Command: Decodable, Equatable {
        let type: String
    }

    let version: Int?
    let commands: [Command]?

    var advertisedCommandTypes: Set<String> {
        Set((commands ?? []).map(\.type))
    }

    /// Whether this catalog can answer "does the server support command X?".  A missing or
    /// empty `commands` array cannot, and must never be read as "the server supports
    /// nothing" — callers fall back to their built-in controls instead.
    var describesCommands: Bool {
        (commands?.isEmpty == false)
    }
}

struct CurrentUser: Decodable {
    let userId: String
    let email: String?
    let name: String?
    let imageUrl: String?
    let loginProvider: String?
    let isAdmin: Bool?
}

struct Readiness: Decodable {
    let hasAccount: Bool
    let hasUniverse: Bool
    let hasLlmKey: Bool?
    let systemState: String
    let strategyAuthority: String
    let selectedAccountNumber: String?
    let activeConnectedAccount: ConnectedAccount?
    let commandBacklog: CommandBacklog
    /// Missing on older payloads: treat as already accepted so a stale cache cannot lock the desk.
    let needsAppConsent: Bool?

    var requiresAppConsent: Bool { needsAppConsent == true }

    static let `default` = Readiness(
        hasAccount: false,
        hasUniverse: false,
        systemState: "stopped",
        strategyAuthority: "advisory",
        selectedAccountNumber: nil,
        activeConnectedAccount: nil,
        commandBacklog: CommandBacklog(queued: 0, running: 0),
        needsAppConsent: true
    )

    private enum CodingKeys: String, CodingKey {
        case hasAccount, hasUniverse, systemState, strategyAuthority, selectedAccountNumber, activeConnectedAccount, commandBacklog, needsAppConsent
    }

    init(
        hasAccount: Bool,
        hasUniverse: Bool,
        systemState: String,
        strategyAuthority: String,
        selectedAccountNumber: String?,
        activeConnectedAccount: ConnectedAccount?,
        commandBacklog: CommandBacklog,
        needsAppConsent: Bool?
    ) {
        self.hasAccount = hasAccount
        self.hasUniverse = hasUniverse
        self.systemState = systemState
        self.strategyAuthority = strategyAuthority
        self.selectedAccountNumber = selectedAccountNumber
        self.activeConnectedAccount = activeConnectedAccount
        self.commandBacklog = commandBacklog
        self.needsAppConsent = needsAppConsent
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        hasAccount = (try? values.decode(Bool.self, forKey: .hasAccount)) ?? false
        hasUniverse = (try? values.decode(Bool.self, forKey: .hasUniverse)) ?? false
        systemState = (try? values.decode(String.self, forKey: .systemState)) ?? "stopped"
        strategyAuthority = (try? values.decode(String.self, forKey: .strategyAuthority)) ?? "advisory"
        selectedAccountNumber = try? values.decodeIfPresent(String.self, forKey: .selectedAccountNumber)
        activeConnectedAccount = try? values.decodeIfPresent(ConnectedAccount.self, forKey: .activeConnectedAccount)
        commandBacklog = (try? values.decode(CommandBacklog.self, forKey: .commandBacklog)) ?? CommandBacklog(queued: 0, running: 0)
        // Missing/null is the legacy shape.  A present non-Boolean value is a
        // malformed consent contract and must reject the snapshot rather than
        // degrading to nil, which would present the user as already consented.
        needsAppConsent = try values.decodeIfPresent(Bool.self, forKey: .needsAppConsent)
    }
}

struct CommandBacklog: Decodable {
    let queued: Int
    let running: Int

    private enum CodingKeys: String, CodingKey {
        case queued, running
    }

    init(queued: Int, running: Int) {
        self.queued = queued
        self.running = running
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        queued = (try? values.decode(Int.self, forKey: .queued)) ?? 0
        running = (try? values.decode(Int.self, forKey: .running)) ?? 0
    }
}

struct ConnectedAccount: Decodable, Identifiable, Hashable {
    let id: String
    let label: String
    let broker: String
    let environment: String
    let accountNumber: String?
    let isActive: Bool?
    let isDraining: Bool?
    let capabilities: AccountCapabilities?
    /// Connected-account tax regime (`roth_ira` / `traditional_ira` / `taxable`).  Wins over
    /// `policy.taxSettings.taxationType` the same way the web desk resolves it.
    let taxationType: String?
}

struct AccountCapabilities: Decodable, Hashable {
    let equityTrading: Bool?
    let shortSelling: Bool?
    let optionsTrading: Bool?
    let optionsLevel: Int?
    let marginEnabled: Bool?
    let accountType: String?
}

struct PolicySummary: Decodable {
    let systemState: String
    let strategyAuthority: String
    let accountNumber: String?
    let connectedAccountId: String?
    let includedIndices: [String]?
    let additionalSymbols: [String]?
    let blocklist: [String]?
    let holdingHorizon: String?
    let runCadenceMinutes: Int?
    let maxOrderNotional: Double?
    let maxOrderPctOfNav: Double?
    let maxDailyNotional: Double?
    let maxDailyPctOfNav: Double?
    let maxDailyOrders: Int?
    let requireTypedConfirmation: Bool?
    /// Mirrors the server snapshot's policy.runDuringExtendedHours (app/api/mobile/snapshot).
    /// nil ≠ false: older payloads without the field cannot answer the market-window question.
    let runDuringExtendedHours: Bool?

    static let `default` = PolicySummary(
        systemState: "stopped",
        strategyAuthority: "advisory",
        accountNumber: nil,
        connectedAccountId: nil,
        includedIndices: [],
        additionalSymbols: [],
        blocklist: [],
        holdingHorizon: nil,
        runCadenceMinutes: 60,
        maxOrderNotional: nil,
        maxOrderPctOfNav: nil,
        maxDailyNotional: nil,
        maxDailyPctOfNav: nil,
        maxDailyOrders: nil,
        requireTypedConfirmation: true,
        runDuringExtendedHours: false
    )

    private enum CodingKeys: String, CodingKey {
        case systemState, strategyAuthority, accountNumber, connectedAccountId, includedIndices, additionalSymbols, blocklist, holdingHorizon, runCadenceMinutes, maxOrderNotional, maxOrderPctOfNav, maxDailyNotional, maxDailyPctOfNav, maxDailyOrders, requireTypedConfirmation, runDuringExtendedHours
    }

    init(
        systemState: String,
        strategyAuthority: String,
        accountNumber: String?,
        connectedAccountId: String?,
        includedIndices: [String]?,
        additionalSymbols: [String]?,
        blocklist: [String]?,
        holdingHorizon: String?,
        runCadenceMinutes: Int?,
        maxOrderNotional: Double?,
        maxOrderPctOfNav: Double?,
        maxDailyNotional: Double?,
        maxDailyPctOfNav: Double?,
        maxDailyOrders: Int?,
        requireTypedConfirmation: Bool?,
        runDuringExtendedHours: Bool?
    ) {
        self.systemState = systemState
        self.strategyAuthority = strategyAuthority
        self.accountNumber = accountNumber
        self.connectedAccountId = connectedAccountId
        self.includedIndices = includedIndices
        self.additionalSymbols = additionalSymbols
        self.blocklist = blocklist
        self.holdingHorizon = holdingHorizon
        self.runCadenceMinutes = runCadenceMinutes
        self.maxOrderNotional = maxOrderNotional
        self.maxOrderPctOfNav = maxOrderPctOfNav
        self.maxDailyNotional = maxDailyNotional
        self.maxDailyPctOfNav = maxDailyPctOfNav
        self.maxDailyOrders = maxDailyOrders
        self.requireTypedConfirmation = requireTypedConfirmation
        self.runDuringExtendedHours = runDuringExtendedHours
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        systemState = (try? values.decode(String.self, forKey: .systemState)) ?? "stopped"
        strategyAuthority = (try? values.decode(String.self, forKey: .strategyAuthority)) ?? "advisory"
        accountNumber = try? values.decodeIfPresent(String.self, forKey: .accountNumber)
        connectedAccountId = try? values.decodeIfPresent(String.self, forKey: .connectedAccountId)
        includedIndices = try? values.decodeIfPresent([String].self, forKey: .includedIndices)
        additionalSymbols = try? values.decodeIfPresent([String].self, forKey: .additionalSymbols)
        blocklist = try? values.decodeIfPresent([String].self, forKey: .blocklist)
        holdingHorizon = try? values.decodeIfPresent(String.self, forKey: .holdingHorizon)
        runCadenceMinutes = try? values.decodeIfPresent(Int.self, forKey: .runCadenceMinutes)
        maxOrderNotional = try? values.decodeIfPresent(Double.self, forKey: .maxOrderNotional)
        maxOrderPctOfNav = try? values.decodeIfPresent(Double.self, forKey: .maxOrderPctOfNav)
        maxDailyNotional = try? values.decodeIfPresent(Double.self, forKey: .maxDailyNotional)
        maxDailyPctOfNav = try? values.decodeIfPresent(Double.self, forKey: .maxDailyPctOfNav)
        maxDailyOrders = try? values.decodeIfPresent(Int.self, forKey: .maxDailyOrders)
        requireTypedConfirmation = try? values.decodeIfPresent(Bool.self, forKey: .requireTypedConfirmation)
        runDuringExtendedHours = try? values.decodeIfPresent(Bool.self, forKey: .runDuringExtendedHours)
    }
}

/// The console's shared run-state vocabulary (app/console/lib/derive.ts `deriveStateInfo`).
/// The words are load-bearing: this app must never say "Running" while the console says
/// "Paused · market closed" for the same account.
enum RunStateWord: String {
    case running = "Running"
    case pausedMarketClosed = "Paused · market closed"
    case exitOnly = "Exit-only"
    case windingDown = "Winding down"
    case stopped = "Stopped"
}

/// Pure mirror of the console's `deriveStateInfo` word selection, using the server-computed
/// `marketSession` instead of a client clock.  Rules, in console order:
/// - Only `active` is market-gated.  A closed/pre/post session with extended hours OFF means
///   scheduled runs are paused, so the word is "Paused · market closed".
/// - `runDuringExtendedHours == nil` (older payload) makes the market split unanswerable —
///   keep the plain "Running" claim rather than fabricate a pause.
/// - An unknown/absent session likewise cannot answer the question — keep "Running".
func deriveRunStateWord(
    systemState: String,
    runDuringExtendedHours: Bool?,
    marketSession: String?
) -> RunStateWord {
    switch systemState.lowercased() {
    case "active":
        guard let extendedHours = runDuringExtendedHours else { return .running }
        switch (marketSession ?? "").lowercased() {
        case "regular", "open":
            return .running
        case "pre", "post":
            return extendedHours ? .running : .pausedMarketClosed
        case "closed":
            return .pausedMarketClosed
        default:
            return .running
        }
    case "close_only":
        return .exitOnly
    case "liquidating":
        return .windingDown
    default:
        return .stopped
    }
}

/// Convenience over the snapshot's own policy + market session.
func deriveRunStateWord(snapshot: MobileSnapshot) -> RunStateWord {
    deriveRunStateWord(
        systemState: snapshot.readiness.systemState,
        runDuringExtendedHours: snapshot.policy.runDuringExtendedHours,
        marketSession: snapshot.marketSession
    )
}

struct PortfolioSummary: Decodable {
    let accountNumber: String?
    let totalMarketValue: Double?
    let buyingPower: Double?
    let equityMarketValue: Double?
    let optionMarketValue: Double?
    let cash: Double?
}

struct Position: Decodable, Identifiable, Equatable {
    var id: String { symbol }

    let symbol: String
    let quantity: Double
    let marketValue: Double
    let averageCost: Double?
    let sector: String?
    let industry: String?
}

enum AccountMetrics {
    static func usesLiveMetrics(environment: String?) -> Bool {
        environment?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "live"
    }

    /// Open P&L from the broker position list (mark − cost).  The fill-ledger
    /// unrealized fields report $0 when marks were never applied, which is why
    /// a Tradier Sandbox book with many positions looked like it had no P&L.
    static func unrealizedFromPositions(_ positions: [Position]) -> Double? {
        var total = 0.0
        var counted = 0
        for position in positions {
            guard let averageCost = position.averageCost else { continue }
            total += position.marketValue - position.quantity * averageCost
            counted += 1
        }
        return counted > 0 ? total : nil
    }

    static func displayedUnrealized(positions: [Position], ledger: Double?) -> Double? {
        if let fromPositions = unrealizedFromPositions(positions) {
            return fromPositions
        }
        return ledger
    }

    /// `$0.00` from an empty fill ledger is not a measured result — show "—".
    static func displayedRealized(ledger: Double?, hasFillHistory: Bool) -> Double? {
        if !hasFillHistory { return nil }
        return ledger
    }

    /// Win rate / avg return are `0` (not nil) from the server for an account with zero closed
    /// lots — a real "no data yet" state, not a genuine 0%.  Gate on the closed-lot count, not
    /// the value, so an account with exactly one break-even closed lot still shows its real 0%.
    static func displayedRateMetric(ledger: Double?, closedLotCount: Int?) -> Double? {
        guard let closedLotCount, closedLotCount > 0 else { return nil }
        return ledger
    }
}

struct EquityOrder: Decodable, Identifiable {
    let id: String
    let symbol: String
    let side: String
    let type: String
    let state: String
    let quantity: Double?
    let dollarAmount: Double?
    let filledQuantity: Double?
    let averagePrice: Double?
    let limitPrice: Double?
    let stopPrice: Double?
    let timeInForce: String?
    let createdAt: String?
    let updatedAt: String?
}

struct PendingProposal: Decodable, Identifiable {
    let id: String
    let createdAt: String?
    let accountNumber: String?
    let executionMode: String?
    let estimatedNotional: Double?
    let lastRevalidatedAt: String?
    let revalidationNote: String?
    let performanceSinceProposalPct: Double?
    let proposalReferencePrice: Double?
    let proposalCurrentPrice: Double?
    let delayedFallback: Bool?
    let quoteProvider: String?
    let proposal: Proposal
}

struct Proposal: Decodable {
    let symbol: String
    let side: String
    let type: String
    let quantity: Double?
    let dollarAmount: Double?
    let limitPrice: Double?
    let referencePrice: Double?
    let stopPrice: Double?
    let timeInForce: String?
    let rationale: String?
    let greenTeamRationale: String?
    let tradeThesisTag: String?
    let entryMarketRegime: String?
    let confidenceScore: Double?
    let proposedByModel: String?
    let reviewedByModel: String?
    let bracketTakeProfit: Double?
    let bracketStopLoss: Double?
    let exitPlan: String?
    let quoteDelayedFallback: Bool?
    let quoteProvider: String?
    let scorecard: ProposalScorecardSnippet?
    let redTeamVerdict: RedTeamVerdict?
}

/// Enough of the server scorecard to recover a target/stop when the bracket legs are missing.
struct ProposalScorecardSnippet: Decodable {
    let sniperPoints: SniperPoints?

    struct SniperPoints: Decodable {
        let takeProfit: Double?
        let stopLoss: Double?
        let idealBuy: Double?
    }
}

struct RedTeamVerdict: Decodable {
    let verdict: String?
    let rejected: Bool
    let available: Bool
    let reason: String
    let model: String?
    let overridden: Bool?
    let humanOverrideApplied: Bool?
    let failureKind: String?

    private enum CodingKeys: String, CodingKey {
        case verdict
        case decision
        case rejected
        case available
        case reason
        case rationale
        case model
        case overridden
        case humanOverrideApplied
        case failureKind
    }

    init(from decoder: Decoder) throws {
        if let value = try? decoder.singleValueContainer().decode(String.self) {
            let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            verdict = normalized.isEmpty ? nil : normalized
            rejected = normalized == "reject" || normalized == "rejected"
            available = !normalized.isEmpty
            reason = "Legacy adversarial verdict; no rationale was recorded."
            model = nil
            overridden = nil
            humanOverrideApplied = nil
            failureKind = nil
            return
        }

        let values = try decoder.container(keyedBy: CodingKeys.self)
        let decodedVerdict =
            try values.decodeIfPresent(String.self, forKey: .verdict) ??
            values.decodeIfPresent(String.self, forKey: .decision)
        let normalizedVerdict = decodedVerdict?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let decodedReason =
            try values.decodeIfPresent(String.self, forKey: .reason) ??
            values.decodeIfPresent(String.self, forKey: .rationale)
        let normalizedReason = decodedReason?.trimmingCharacters(in: .whitespacesAndNewlines)
        let decodedRejected = try values.decodeIfPresent(Bool.self, forKey: .rejected)

        verdict = normalizedVerdict?.isEmpty == false ? normalizedVerdict : nil
        // The oldest persisted review shape carried only `rejected`. It is still evidence that a
        // review happened, so never present it as an unavailable review merely because it predates
        // `available`, `verdict`, and the reviewer rationale.
        rejected = decodedRejected ??
            (verdict == "reject" || verdict == "rejected")
        available = try values.decodeIfPresent(Bool.self, forKey: .available) ??
            (verdict != nil || normalizedReason?.isEmpty == false || decodedRejected != nil)
        reason = normalizedReason?.isEmpty == false
            ? normalizedReason!
            : "No adversarial review rationale was recorded."
        model = try values.decodeIfPresent(String.self, forKey: .model)
        overridden = try values.decodeIfPresent(Bool.self, forKey: .overridden)
        humanOverrideApplied = try values.decodeIfPresent(Bool.self, forKey: .humanOverrideApplied)
        failureKind = try values.decodeIfPresent(String.self, forKey: .failureKind)
    }
}

func liveApprovalConfirmationText(forSymbol symbol: String) -> String {
    "APPROVE LIVE \(symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased())"
}

struct LiveApprovalConfirmation {
    let proposalId: String
    let accountNumber: String?
    let estimatedNotional: Double?
    let typedText: String

    var jsonObject: [String: Any] {
        var object: [String: Any] = [
            "proposalId": proposalId,
            "executionMode": "broker/live",
            "estimatedNotional": estimatedNotional ?? NSNull(),
            "typedText": typedText
        ]
        if let accountNumber {
            object["accountNumber"] = accountNumber
        }
        return object
    }
}

struct DailyStats: Decodable {
    let orderCount: Int
    let openingOrderCount: Int
    let notional: Double

    static let empty = DailyStats(orderCount: 0, openingOrderCount: 0, notional: 0)
}

struct PerformanceSummary: Decodable {
    let liveRealizedPnl: Double?
    let paperRealizedPnl: Double?
    let liveUnrealizedPnl: Double?
    let paperUnrealizedPnl: Double?
    let liveWinRate: Double?
    let paperWinRate: Double?
    let liveAverageReturnPct: Double?
    let paperAverageReturnPct: Double?
    /// Count of CLOSED lots behind liveWinRate/liveAverageReturnPct.  Zero for an account that has
    /// never closed a lot — winRate/averageReturn both compute to 0 (not nil) server-side for an
    /// empty lot list, so a real "no data yet" state must be read off this count, not the value.
    let liveClosedLotCount: Int?
    let paperClosedLotCount: Int?
    let liveEquityCurve: [EquityCurvePoint]?
    let paperEquityCurve: [EquityCurvePoint]?
    let benchmark: BenchmarkComparison?
    let fills: [FillEvent]?
}

struct EquityCurvePoint: Decodable, Identifiable, Equatable {
    var id: String { date }
    /// The server's shared EquityCurvePoint (src/lib/types.ts) keys points by
    /// `timestamp`; older payload shapes used `date`.  Accept either — requiring
    /// `date` alone made one curve point abort the WHOLE snapshot decode and
    /// blank the app with "Couldn't load your workspace" (2026-08-27).
    let date: String
    let equity: Double
    let cash: Double?
    let pnl: Double?
    let returnPct: Double?

    private enum CodingKeys: String, CodingKey {
        case date
        case timestamp
        case equity
        case cash
        case pnl
        case returnPct
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let decodedDate =
            try values.decodeIfPresent(String.self, forKey: .date) ??
            values.decodeIfPresent(String.self, forKey: .timestamp)
        guard let decodedDate else {
            throw DecodingError.keyNotFound(
                CodingKeys.date,
                DecodingError.Context(
                    codingPath: values.codingPath,
                    debugDescription: "Neither date nor timestamp present on equity curve point"
                )
            )
        }
        date = decodedDate
        equity = try values.decode(Double.self, forKey: .equity)
        cash = try values.decodeIfPresent(Double.self, forKey: .cash)
        pnl = try values.decodeIfPresent(Double.self, forKey: .pnl)
        returnPct = try values.decodeIfPresent(Double.self, forKey: .returnPct)
    }

    init(date: String, equity: Double, cash: Double? = nil, pnl: Double? = nil, returnPct: Double? = nil) {
        self.date = date
        self.equity = equity
        self.cash = cash
        self.pnl = pnl
        self.returnPct = returnPct
    }
}

struct BenchmarkDollarPoint: Decodable, Identifiable, Equatable {
    var id: String { date }
    let date: String
    let value: Double
}

struct BenchmarkComparison: Decodable {
    let accountReturnPct: Double
    let benchmarkReturnPct: Double
    let excessReturnPct: Double
    let startDate: String
    let endDate: String
    let points: Int
    let benchmarkSymbol: String
    let cashFlowAdjusted: Bool?
    let netExternalFlows: Double?
    let accountEquitySeries: [BenchmarkDollarPoint]?
    let shadowBenchmarkSeries: [BenchmarkDollarPoint]?
    let shadowValue: Double?
    let dollarExcess: Double?
}

struct FillEvent: Decodable, Identifiable, Equatable {
    let id: String
    let symbol: String
    let side: String
    let quantity: Double
    let price: Double
    let notional: Double
    let status: String
    let filledAt: String
}

struct SchedulerSummary: Decodable {
    let lastRunAt: String?
    let nextRunAt: String?

    static let empty = SchedulerSummary(lastRunAt: nil, nextRunAt: nil)
}

struct WatchlistItem: Decodable, Identifiable {
    var id: String { symbol }

    let symbol: String
    let addedAt: String
}

struct PriceAlert: Decodable, Identifiable {
    let id: String
    let symbol: String
    let op: String
    let price: Double
    let note: String?
    let status: String
    let createdAt: String?
    let triggeredAt: String?
    let triggeredPrice: Double?
}

/// One persisted inbox row from `/api/mobile/snapshot` `notifications`.
/// Title and body are already ordinary words — do not show `type` raw.
/// Older #2942 rows had `status` / `acknowledgedAt` and no `body` / `read`.
struct NotificationHistoryItem: Decodable, Identifiable, Equatable {
    let id: String
    let createdAt: String
    let type: String
    let title: String
    let body: String
    let read: Bool
    let status: String
    let acknowledgedAt: String?
    let connectedAccountId: String?
    let accountLabel: String?
    let channel: String?

    var readLabel: String { read ? "read" : "unread" }

    private enum CodingKeys: String, CodingKey {
        case id
        case createdAt
        case type
        case title
        case body
        case read
        case status
        case acknowledgedAt
        case connectedAccountId
        case accountLabel
        case channel
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        createdAt = try values.decode(String.self, forKey: .createdAt)
        type = try values.decode(String.self, forKey: .type)
        title = try values.decode(String.self, forKey: .title)
        body = try values.decodeIfPresent(String.self, forKey: .body) ?? ""
        acknowledgedAt = try values.decodeIfPresent(String.self, forKey: .acknowledgedAt)
        if let explicitRead = try values.decodeIfPresent(Bool.self, forKey: .read) {
            read = explicitRead
        } else {
            read = acknowledgedAt != nil
        }
        status = try values.decodeIfPresent(String.self, forKey: .status) ?? "sent"
        connectedAccountId = try values.decodeIfPresent(String.self, forKey: .connectedAccountId)
        accountLabel = try values.decodeIfPresent(String.self, forKey: .accountLabel)
        channel = try values.decodeIfPresent(String.self, forKey: .channel)
    }
}

/// Compact strategy-run row from `/api/mobile/snapshot` `strategyRuns`.
struct StrategyRunItem: Decodable, Identifiable, Equatable {
    let id: String
    let startedAt: String
    let finishedAt: String?
    let status: String
    let summary: String?
    let connectedAccountId: String?
    let placedCount: Int
    let paperCount: Int
    let blockedCount: Int
    let proposedCount: Int
    let totalCount: Int
    let failure: String?

    private enum CodingKeys: String, CodingKey {
        case id, startedAt, finishedAt, status, summary, connectedAccountId
        case placedCount, paperCount, blockedCount, proposedCount, totalCount, failure
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        startedAt = try values.decode(String.self, forKey: .startedAt)
        finishedAt = try values.decodeIfPresent(String.self, forKey: .finishedAt)
        status = try values.decodeIfPresent(String.self, forKey: .status) ?? "completed"
        summary = try values.decodeIfPresent(String.self, forKey: .summary)
        connectedAccountId = try values.decodeIfPresent(String.self, forKey: .connectedAccountId)
        placedCount = (try? values.decodeIfPresent(Int.self, forKey: .placedCount)) ?? 0
        paperCount = (try? values.decodeIfPresent(Int.self, forKey: .paperCount)) ?? 0
        blockedCount = (try? values.decodeIfPresent(Int.self, forKey: .blockedCount)) ?? 0
        proposedCount = (try? values.decodeIfPresent(Int.self, forKey: .proposedCount)) ?? 0
        totalCount = (try? values.decodeIfPresent(Int.self, forKey: .totalCount)) ?? 0
        failure = try values.decodeIfPresent(String.self, forKey: .failure)
    }
}

/// Compact unified-feed group from `/api/mobile/snapshot` `unifiedFeed` (Audit Log).
struct ActivityAuditItem: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let detail: String
    let status: String
    let updatedAt: String
    let accountLabel: String?
    let failure: String?

    private enum CodingKeys: String, CodingKey {
        case id, title, detail, status, updatedAt, accountLabel, failure
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        title = try values.decodeIfPresent(String.self, forKey: .title) ?? "Event"
        detail = try values.decodeIfPresent(String.self, forKey: .detail) ?? ""
        status = try values.decodeIfPresent(String.self, forKey: .status) ?? ""
        updatedAt = try values.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
        accountLabel = try values.decodeIfPresent(String.self, forKey: .accountLabel)
        failure = try values.decodeIfPresent(String.self, forKey: .failure)
    }
}

struct MobileCommandResult: Decodable {
    let status: String?
    let outcome: String?
    let reasons: [String]?
    let orderId: String?
}

struct MobileCommand: Decodable, Identifiable {
    let id: String
    let commandType: String
    let status: String
    let error: String?
    let result: MobileCommandResult?
    let createdAt: String
    let queuedAt: String?
    let startedAt: String?
    let finishedAt: String?
    let updatedAt: String

    var isTerminal: Bool {
        status == "succeeded" || status == "failed" || status == "cancelled"
    }

    var didFail: Bool {
        status == "failed" || status == "cancelled"
    }
}

/// On-demand single-symbol quote + fundamentals — the mobile counterpart of the web console's
/// `/api/quote` fetch used by the symbol drilldown drawer (app/console/ui/symbol-drilldown.tsx),
/// decoded from that same flattened response. Every field is optional and rendered as an honest
/// "—"/"n/a" (see `AppFormat`) when the provider cascade didn't return it — never fabricated.
struct SymbolQuoteInfo: Decodable {
    let symbol: String
    let companyName: String?
    let price: Double?
    let intradayChangePct: Double?
    let asOf: String?
    let sector: String?
    let industry: String?
    let volume: Double?
    let peRatio: Double?
    let eps: Double?
    let dividendYield: Double?
    let beta: Double?
    let fiftyTwoWeekHigh: Double?
    let fiftyTwoWeekLow: Double?
    let analystRating: String?
    let analystScore: Double?
    let targetMean: Double?
    let targetHigh: Double?
    let targetLow: Double?
    let daysToEarnings: Double?
}

/// Size+direction of the same symbol on another of this user's accounts, plus the
/// current account's persisted exit contract.  Decoded from GET `/api/symbol-desk`.
struct SymbolDeskInfo: Decodable {
    struct PeerAccount: Decodable, Identifiable {
        var id: String { accountId }
        let accountId: String
        let label: String
        let environment: String?
        let direction: String
        let quantity: Double
    }

    struct Exit: Decodable {
        let style: String?
        let rationale: String?
        let stopPrice: Double?
        let takeProfitPrice: Double?
        let trailPercent: Double?
        let resolvedStopPct: Double?
        let invalidation: String?
        let maxHoldingUntil: String?
        let trimBand: Double?
    }

    struct Pending: Decodable, Identifiable {
        let id: String
        let side: String
        let quantity: Double?
        let rationale: String?
    }

    struct LastCall: Decodable {
        let id: String
        let side: String?
        let status: String
        let green: String?
        let red: String?
        let outcome: String?
    }

    let symbol: String
    let peerAccounts: [PeerAccount]
    let exit: Exit?
    let pending: [Pending]
    let lastCall: LastCall?
}

struct CommandEnvelope: Decodable {
    let command: MobileCommand
    let deduped: Bool?
}

struct DeletionRequestEnvelope: Decodable {
    let deletionRequest: AccountDeletionRequest
}

struct AccountDeletionRequest: Decodable {
    // Read-only previews intentionally have no durable request id. The backend creates the
    // prepared request only inside the final confirmation action.
    let requestId: String?
    let userId: String
    let email: String?
    let requiredText: String
    // The current mobile deletion request contract does not return an expiry.
    // Keep this additive for compatibility with servers that add one later.
    let expiresAt: String?
    let steps: [String]
}

struct AccountDeletionResult: Decodable {
    let ok: Bool
    let counts: [String: Int]
    let logoutUrl: String?

    static let successfulHTTP = AccountDeletionResult(ok: true, counts: [:], logoutUrl: nil)

    private enum CodingKeys: String, CodingKey {
        case ok
        case counts
        case logoutUrl
    }

    init(ok: Bool, counts: [String: Int], logoutUrl: String?) {
        self.ok = ok
        self.counts = counts
        self.logoutUrl = logoutUrl
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        ok = try values.decodeIfPresent(Bool.self, forKey: .ok) ?? true
        counts = try values.decodeIfPresent([String: Int].self, forKey: .counts) ?? [:]
        logoutUrl = try values.decodeIfPresent(String.self, forKey: .logoutUrl)
    }
}

/// Native weekly value + momentum screens.  All arrays default empty so an older
/// payload, or a partial object, cannot fail the whole snapshot decode.
struct WeeklyDigestName: Decodable, Identifiable {
    var id: String { symbol }
    let symbol: String
    let companyName: String?
    let sector: String?
    let price: Double
    let marketCap: Double?
    let peRatio: Double?
    let pctAbove52wLow: Double?
    let return5d: Double?
    let rsi14: Double?
    let rsiZone: String?
    let vsSma20: String?
    let vsSma50: String?
    let vsSma200: String?

    private enum CodingKeys: String, CodingKey {
        case symbol, companyName, sector, price, marketCap, peRatio
        case pctAbove52wLow, return5d, rsi14, rsiZone, vsSma20, vsSma50, vsSma200
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        symbol = try values.decode(String.self, forKey: .symbol)
        companyName = try values.decodeIfPresent(String.self, forKey: .companyName)
        sector = try values.decodeIfPresent(String.self, forKey: .sector)
        price = try values.decodeIfPresent(Double.self, forKey: .price) ?? 0
        marketCap = try values.decodeIfPresent(Double.self, forKey: .marketCap)
        peRatio = try values.decodeIfPresent(Double.self, forKey: .peRatio)
        pctAbove52wLow = try values.decodeIfPresent(Double.self, forKey: .pctAbove52wLow)
        return5d = try values.decodeIfPresent(Double.self, forKey: .return5d)
        rsi14 = try values.decodeIfPresent(Double.self, forKey: .rsi14)
        rsiZone = try values.decodeIfPresent(String.self, forKey: .rsiZone)
        vsSma20 = try values.decodeIfPresent(String.self, forKey: .vsSma20)
        vsSma50 = try values.decodeIfPresent(String.self, forKey: .vsSma50)
        vsSma200 = try values.decodeIfPresent(String.self, forKey: .vsSma200)
    }
}

struct WeeklyMarketDigest: Decodable {
    let generatedAt: String?
    let status: String
    let value: [WeeklyDigestName]
    let momentum: [WeeklyDigestName]
    let overlap: [String]
    let warnings: [String]

    var hasRows: Bool { !value.isEmpty || !momentum.isEmpty }

    private enum CodingKeys: String, CodingKey {
        case generatedAt, status, value, momentum, overlap, warnings
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = try values.decodeIfPresent(String.self, forKey: .generatedAt)
        status = try values.decodeIfPresent(String.self, forKey: .status) ?? "pending"
        value = try values.decodeIfPresent([WeeklyDigestName].self, forKey: .value) ?? []
        momentum = try values.decodeIfPresent([WeeklyDigestName].self, forKey: .momentum) ?? []
        overlap = try values.decodeIfPresent([String].self, forKey: .overlap) ?? []
        warnings = try values.decodeIfPresent([String].self, forKey: .warnings) ?? []
    }
}
