import Foundation

// MARK: - Coach chat

struct ChatHistoryResponse: Decodable {
    let turns: [ChatTurn]
}

struct ChatTurn: Decodable, Identifiable, Equatable {
    let id: String
    let role: String
    let text: String
    let citations: [String]
    let intent: String?
    let model: String?
    let createdAt: String?

    var isUser: Bool { role.lowercased() == "user" }

    private enum CodingKeys: String, CodingKey {
        case id, role, text, citations, intent, model, createdAt
    }

    init(
        id: String,
        role: String,
        text: String,
        citations: [String] = [],
        intent: String? = nil,
        model: String? = nil,
        createdAt: String? = nil
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.citations = citations
        self.intent = intent
        self.model = model
        self.createdAt = createdAt
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        role = try values.decodeIfPresent(String.self, forKey: .role) ?? "assistant"
        text = try values.decodeIfPresent(String.self, forKey: .text) ?? ""
        citations = try values.decodeIfPresent([String].self, forKey: .citations) ?? []
        intent = try values.decodeIfPresent(String.self, forKey: .intent)
        model = try values.decodeIfPresent(String.self, forKey: .model)
        createdAt = try values.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

struct ChatReply: Decodable {
    let text: String
    let draft: ChatDraft?
    let citations: [ChatCitation]
    let intent: String?
    let model: String?
    let learningCapture: ChatLearningCapture?

    private enum CodingKeys: String, CodingKey {
        case text, draft, citations, intent, model, learningCapture, error, message
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        if let error = try values.decodeIfPresent(String.self, forKey: .error),
           try values.decodeIfPresent(String.self, forKey: .text) == nil {
            throw DecodingError.dataCorruptedError(
                forKey: .text,
                in: values,
                debugDescription: error
            )
        }
        text = try values.decodeIfPresent(String.self, forKey: .text)
            ?? values.decodeIfPresent(String.self, forKey: .message)
            ?? ""
        draft = try values.decodeIfPresent(ChatDraft.self, forKey: .draft)
        citations = try values.decodeIfPresent([ChatCitation].self, forKey: .citations) ?? []
        intent = try values.decodeIfPresent(String.self, forKey: .intent)
        model = try values.decodeIfPresent(String.self, forKey: .model)
        learningCapture = try values.decodeIfPresent(ChatLearningCapture.self, forKey: .learningCapture)
    }
}

struct ChatCitation: Decodable, Identifiable, Hashable {
    var id: String { [source, evidenceRef, url].compactMap { $0 }.joined(separator: "|") }

    let source: String
    let evidenceRef: String?
    let url: String?

    private enum CodingKeys: String, CodingKey {
        case source
        case evidenceRef = "evidence_ref"
        case evidenceRefCamel = "evidenceRef"
        case url
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        source = try values.decodeIfPresent(String.self, forKey: .source) ?? "source"
        evidenceRef = try values.decodeIfPresent(String.self, forKey: .evidenceRef)
            ?? values.decodeIfPresent(String.self, forKey: .evidenceRefCamel)
        url = try values.decodeIfPresent(String.self, forKey: .url)
    }
}

struct ChatDraft: Decodable, Identifiable {
    var id: String { draftId }

    let draftId: String
    let symbol: String
    let side: String
    let quantity: Double?
    let orderType: String?
    let limitUsd: Double?
    let rationale: String?
    let accountLabel: String?
    let isReal: Bool?
    let blocked: Bool?
    let warnings: [String]

    private enum CodingKeys: String, CodingKey {
        case draftId = "draft_id"
        case symbol, side
        case qty
        case quantity
        case orderType = "order_type"
        case limitUsd = "limit_usd"
        case rationale
        case accountLabel = "account_label"
        case isReal = "is_real"
        case blocked
        case warnings
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        draftId = try values.decodeIfPresent(String.self, forKey: .draftId) ?? UUID().uuidString
        symbol = try values.decodeIfPresent(String.self, forKey: .symbol) ?? "—"
        side = try values.decodeIfPresent(String.self, forKey: .side) ?? ""
        quantity = try values.decodeIfPresent(Double.self, forKey: .qty)
            ?? values.decodeIfPresent(Double.self, forKey: .quantity)
        orderType = try values.decodeIfPresent(String.self, forKey: .orderType)
        limitUsd = try values.decodeIfPresent(Double.self, forKey: .limitUsd)
        rationale = try values.decodeIfPresent(String.self, forKey: .rationale)
        accountLabel = try values.decodeIfPresent(String.self, forKey: .accountLabel)
        isReal = try values.decodeIfPresent(Bool.self, forKey: .isReal)
        blocked = try values.decodeIfPresent(Bool.self, forKey: .blocked)
        warnings = try values.decodeIfPresent([String].self, forKey: .warnings) ?? []
    }
}

struct ChatLearningCapture: Decodable {
    let kind: String?
    let receipt: String?
}

struct ChatProvidersResponse: Decodable {
    let providers: [String: Bool]
}

/// Curated Coach models — ids must match `app/ui/llm-model-catalog.ts` / `chatProviderForModel`.
enum CoachModelCatalog {
    struct Option: Identifiable, Equatable {
        let id: String
        let label: String
        let provider: String
        let detail: String
    }

    static let storageKey = "console.assistant.model"

    static let options: [Option] = [
        .init(id: "gpt-mini-latest", label: "GPT Mini (5.4)", provider: "openai", detail: "low-cost OpenAI"),
        .init(id: "gpt-5.6-terra", label: "GPT Terra", provider: "openai", detail: "balanced OpenAI"),
        .init(id: "claude-haiku-latest", label: "Claude Haiku (4.5)", provider: "anthropic", detail: "fast Claude"),
        .init(id: "claude-sonnet-latest", label: "Claude Sonnet (5)", provider: "anthropic", detail: "balanced Claude"),
        .init(id: "grok-latest", label: "Grok (4.5)", provider: "xai", detail: "default Grok"),
        .init(id: "gemini-flash-latest", label: "Gemini Flash", provider: "gemini", detail: "stable Flash")
    ]

    static func provider(for model: String) -> String {
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if trimmed.hasPrefix("claude") { return "anthropic" }
        if trimmed.hasPrefix("grok") { return "xai" }
        if trimmed.hasPrefix("gemini") { return "gemini" }
        if trimmed.hasPrefix("mistral") || trimmed.hasPrefix("codestral") { return "mistral" }
        if trimmed.hasPrefix("deepseek") { return "deepseek" }
        if trimmed.hasPrefix("kimi") || trimmed.hasPrefix("moonshot") { return "moonshot" }
        return "openai"
    }

    static func firstAvailable(providers: [String: Bool]) -> Option? {
        options.first { providers[$0.provider] == true }
    }

    static func isAvailable(_ option: Option, providers: [String: Bool]) -> Bool {
        providers[option.provider] == true
    }
}

// MARK: - Scan

struct MarketScanResponse: Decodable {
    let topCandidates: [ScanCandidate]
    let asOf: String?
    let generatedAt: String?
    let scannedSymbols: Int?
    let returnedQuotes: Int?
    let warnings: [String]

    var hasUsableUniverse: Bool { !topCandidates.isEmpty }

    var lastGoodStamp: String? { asOf ?? generatedAt }

    private enum CodingKeys: String, CodingKey {
        case topCandidates
        case asOf
        case generatedAt
        case scannedAt
        case createdAt
        case scannedSymbols
        case returnedQuotes
        case warnings
    }

    init(
        topCandidates: [ScanCandidate],
        asOf: String? = nil,
        generatedAt: String? = nil,
        scannedSymbols: Int? = nil,
        returnedQuotes: Int? = nil,
        warnings: [String] = []
    ) {
        self.topCandidates = topCandidates
        self.asOf = asOf ?? generatedAt
        self.generatedAt = generatedAt
        self.scannedSymbols = scannedSymbols
        self.returnedQuotes = returnedQuotes
        self.warnings = warnings
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        topCandidates = try values.decodeIfPresent([ScanCandidate].self, forKey: .topCandidates) ?? []
        asOf = try values.decodeIfPresent(String.self, forKey: .asOf)
            ?? values.decodeIfPresent(String.self, forKey: .generatedAt)
            ?? values.decodeIfPresent(String.self, forKey: .scannedAt)
            ?? values.decodeIfPresent(String.self, forKey: .createdAt)
        generatedAt = try values.decodeIfPresent(String.self, forKey: .generatedAt)
        scannedSymbols = try values.decodeIfPresent(Int.self, forKey: .scannedSymbols)
        returnedQuotes = try values.decodeIfPresent(Int.self, forKey: .returnedQuotes)
        warnings = try values.decodeIfPresent([String].self, forKey: .warnings) ?? []
    }

    /// Same rule as `/console/scan`: a failed refresh never blanks a last-good table.
    func keepingLastGood(from previous: MarketScanResponse?) -> MarketScanResponse {
        if hasUsableUniverse { return self }
        guard let previous, previous.hasUsableUniverse else { return self }
        return previous
    }
}

struct ScanCandidate: Decodable, Identifiable {
    var id: String { symbol }

    let symbol: String
    let companyName: String?
    let price: Double?
    let score: Double?
    let intradayChangePct: Double?
    let sector: String?
    let industry: String?
    let volume: Double?
    let bid: Double?
    let ask: Double?

    private enum CodingKeys: String, CodingKey {
        case symbol, companyName, price, score, intradayChangePct, sector, industry, volume, bid, ask
    }

    init(
        symbol: String,
        companyName: String? = nil,
        price: Double? = nil,
        score: Double? = nil,
        intradayChangePct: Double? = nil,
        sector: String? = nil,
        industry: String? = nil,
        volume: Double? = nil,
        bid: Double? = nil,
        ask: Double? = nil
    ) {
        self.symbol = symbol
        self.companyName = companyName
        self.price = price
        self.score = score
        self.intradayChangePct = intradayChangePct
        self.sector = sector
        self.industry = industry
        self.volume = volume
        self.bid = bid
        self.ask = ask
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        symbol = try values.decodeIfPresent(String.self, forKey: .symbol) ?? "—"
        companyName = try values.decodeIfPresent(String.self, forKey: .companyName)
        price = try values.decodeIfPresent(Double.self, forKey: .price)
        score = try values.decodeIfPresent(Double.self, forKey: .score)
        intradayChangePct = try values.decodeIfPresent(Double.self, forKey: .intradayChangePct)
        sector = try values.decodeIfPresent(String.self, forKey: .sector)
        industry = try values.decodeIfPresent(String.self, forKey: .industry)
        volume = try values.decodeIfPresent(Double.self, forKey: .volume)
        bid = try values.decodeIfPresent(Double.self, forKey: .bid)
        ask = try values.decodeIfPresent(Double.self, forKey: .ask)
    }
}

// MARK: - Full policy (GET /api/policy)

struct FullPolicy: Decodable {
    let systemState: String?
    let strategyAuthority: String?
    let holdingHorizon: String?
    let runCadenceMinutes: Int?
    let runDuringExtendedHours: Bool?
    let maxOrderNotional: Double?
    let maxOrderPctOfNav: Double?
    let maxDailyNotional: Double?
    let maxDailyPctOfNav: Double?
    let maxDailyOrders: Int?
    let requireTypedConfirmation: Bool?
    let includedIndices: [String]?
    let additionalSymbols: [String]?
    let blocklist: [String]?
    let llmModel: String?
    let redTeamLlmModel: String?
    let llmFallbackModels: [String]?
    let sellToFundBuy: String?
    let socraticOverrideMode: String?
    let stopLossPct: Double?
    let trailingStopPct: Double?
    let shortStopLossPct: Double?
    let taxSettings: PolicyTaxSettings?

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        systemState = try values.decodeIfPresent(String.self, forKey: .systemState)
        strategyAuthority = try values.decodeIfPresent(String.self, forKey: .strategyAuthority)
        holdingHorizon = try values.decodeIfPresent(String.self, forKey: .holdingHorizon)
        runCadenceMinutes = try values.decodeIfPresent(Int.self, forKey: .runCadenceMinutes)
        runDuringExtendedHours = try values.decodeIfPresent(Bool.self, forKey: .runDuringExtendedHours)
        maxOrderNotional = try values.decodeIfPresent(Double.self, forKey: .maxOrderNotional)
        maxOrderPctOfNav = try values.decodeIfPresent(Double.self, forKey: .maxOrderPctOfNav)
        maxDailyNotional = try values.decodeIfPresent(Double.self, forKey: .maxDailyNotional)
        maxDailyPctOfNav = try values.decodeIfPresent(Double.self, forKey: .maxDailyPctOfNav)
        maxDailyOrders = try values.decodeIfPresent(Int.self, forKey: .maxDailyOrders)
        requireTypedConfirmation = try values.decodeIfPresent(Bool.self, forKey: .requireTypedConfirmation)
        includedIndices = try values.decodeIfPresent([String].self, forKey: .includedIndices)
        additionalSymbols = try values.decodeIfPresent([String].self, forKey: .additionalSymbols)
        blocklist = try values.decodeIfPresent([String].self, forKey: .blocklist)
        llmModel = try values.decodeIfPresent(String.self, forKey: .llmModel)
        redTeamLlmModel = try values.decodeIfPresent(String.self, forKey: .redTeamLlmModel)
        llmFallbackModels = try values.decodeIfPresent([String].self, forKey: .llmFallbackModels)
        sellToFundBuy = try values.decodeIfPresent(String.self, forKey: .sellToFundBuy)
        socraticOverrideMode = try values.decodeIfPresent(String.self, forKey: .socraticOverrideMode)
        let riskRules = try? values.nestedContainer(keyedBy: RiskRulesCodingKeys.self, forKey: .riskRules)
        stopLossPct = try riskRules?.decodeIfPresent(Double.self, forKey: .stopLossPct)
        trailingStopPct = try riskRules?.decodeIfPresent(Double.self, forKey: .trailingStopPct)
        shortStopLossPct = try riskRules?.decodeIfPresent(Double.self, forKey: .shortStopLossPct)
        taxSettings = try values.decodeIfPresent(PolicyTaxSettings.self, forKey: .taxSettings)
    }

    private enum RiskRulesCodingKeys: String, CodingKey {
        case stopLossPct, trailingStopPct, shortStopLossPct
    }

    private enum CodingKeys: String, CodingKey {
        case systemState, strategyAuthority, holdingHorizon, runCadenceMinutes
        case runDuringExtendedHours, maxOrderNotional, maxOrderPctOfNav
        case maxDailyNotional, maxDailyPctOfNav, maxDailyOrders
        case requireTypedConfirmation, includedIndices, additionalSymbols, blocklist
        case llmModel, redTeamLlmModel, llmFallbackModels, sellToFundBuy, socraticOverrideMode
        case riskRules
        case taxSettings
    }
}

struct PolicyTaxSettings: Decodable {
    let taxationType: String?
    let washSaleGuard: Bool?
    let washSaleHandling: String?
    let iraWashSaleHandling: String?
    let washSaleMinLossUsd: Double?
    let shortTermRatePct: Double?
    let longTermRatePct: Double?
}

// MARK: - Data sources

struct SourceFeaturesPatchAck: Decodable {
    let ok: Bool?
}

struct LlmBudgetToday: Decodable {
    let tokens: Double
    let costUsd: Double
}

struct LlmBudgetEffective: Decodable {
    let tokenLimit: Double?
    let costLimitUsd: Double?
    let tokenSource: String
    let costSource: String
}

struct LlmBudgetResponse: Decodable {
    let tokenBudget: Double?
    let costBudgetUsd: Double?
    let effective: LlmBudgetEffective
    let today: LlmBudgetToday
    let enforced: Bool

    private enum CodingKeys: String, CodingKey {
        case tokenBudget, costBudgetUsd, effective, today, enforced
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        tokenBudget = try values.decodeIfPresent(Double.self, forKey: .tokenBudget)
        costBudgetUsd = try values.decodeIfPresent(Double.self, forKey: .costBudgetUsd)
        effective = try values.decodeIfPresent(LlmBudgetEffective.self, forKey: .effective)
            ?? LlmBudgetEffective(tokenLimit: nil, costLimitUsd: nil, tokenSource: "none", costSource: "none")
        today = try values.decodeIfPresent(LlmBudgetToday.self, forKey: .today)
            ?? LlmBudgetToday(tokens: 0, costUsd: 0)
        enforced = try values.decodeIfPresent(Bool.self, forKey: .enforced) ?? false
    }
}

struct SourceFeaturesResponse: Decodable {
    let settings: [SourceSettingRow]
    let groups: [String: SourceSettingGroupInfo]

    private enum CodingKeys: String, CodingKey {
        case settings, groups
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        settings = try values.decodeIfPresent([SourceSettingRow].self, forKey: .settings) ?? []
        groups = try values.decodeIfPresent([String: SourceSettingGroupInfo].self, forKey: .groups) ?? [:]
    }
}

struct SourceSettingGroupInfo: Decodable {
    let title: String
    let blurb: String?
}

/// The one rule for what tapping away from a numeric settings field should do.
///
/// Extracted from the views because it is the whole of the behaviour worth pinning, and
/// because it was previously spread across two files that disagreed: `DataSourcesSettings`
/// silently dropped anything unparseable, while `LlmBudgetSection` showed a message —
/// and BOTH only ran on `.onSubmit`, which a `.decimalPad` can never fire because that
/// keyboard has no Return key.  A typed number was therefore discarded whenever the user
/// tapped away, on iPhone as much as iPad, with no PATCH sent and no way to tell.
enum NumberFieldCommit: Equatable {
    /// Parseable and already what the server has.  Do not spend a round trip — this is also
    /// what stops a Save button re-sending what a blur already saved.
    case unchanged
    /// Parseable and different.  `nil` clears the value, and is only ever produced for a
    /// field where empty is a real choice ("blank = no cap").
    case patch(Double?)
    /// Empty where empty is not allowed, or not a number at all.  Put the stored value back
    /// so the field shows what is actually saved rather than a phantom edit.
    case revert
}

enum NumberFieldEditor {
    static func decide(
        text: String,
        serverValue: Double?,
        allowsEmpty: Bool,
        minimum: Double? = 0
    ) -> NumberFieldCommit {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            guard allowsEmpty else { return .revert }
            return serverValue == nil ? .unchanged : .patch(nil)
        }
        guard let parsed = parse(trimmed), parsed.isFinite else { return .revert }
        if let minimum, parsed < minimum { return .revert }
        if let serverValue, parsed == serverValue { return .unchanged }
        return .patch(parsed)
    }

    /// `Double(_:)` is not enough on its own.  `.decimalPad` prints the DEVICE locale's
    /// decimal separator, which is a comma across much of the world, and `Double("1,5")` is
    /// nil — so a comma-locale user's input would be thrown away by the very blur-commit
    /// added here to stop input being thrown away.
    static func parse(_ text: String, locale: Locale = .current) -> Double? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let value = Double(trimmed) { return value }
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .decimal
        return formatter.number(from: trimmed)?.doubleValue
    }

    /// How a stored value is shown in the field.  A whole number loses its ".0", so the
    /// field does not visibly rewrite itself into "5.0" the moment it is committed.
    static func display(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "" }
        if value == value.rounded(), abs(value) < 1e15 { return String(Int(value)) }
        return String(value)
    }
}

struct SourceSettingRow: Decodable, Identifiable {
    let id: String
    let group: String
    let label: String
    let description: String?
    let type: String
    let advanced: Bool
    let caveat: String?
    let source: String?
    let value: SourceSettingValue

    private enum CodingKeys: String, CodingKey {
        case id, group, label, description, type, advanced, caveat, source, value
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        group = try values.decodeIfPresent(String.self, forKey: .group) ?? "other"
        label = try values.decodeIfPresent(String.self, forKey: .label) ?? id
        description = try values.decodeIfPresent(String.self, forKey: .description)
        type = try values.decodeIfPresent(String.self, forKey: .type) ?? "string"
        advanced = try values.decodeIfPresent(Bool.self, forKey: .advanced) ?? false
        caveat = try values.decodeIfPresent(String.self, forKey: .caveat)
        source = try values.decodeIfPresent(String.self, forKey: .source)
        value = try values.decodeIfPresent(SourceSettingValue.self, forKey: .value) ?? .none
    }
}

enum SourceSettingValue: Decodable, Equatable {
    case bool(Bool)
    case number(Double)
    case string(String)
    case none

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .none
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(Int.self) {
            self = .number(Double(value))
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else {
            self = .none
        }
    }

    var boolValue: Bool {
        if case .bool(let value) = self { return value }
        return false
    }

    var numberValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    var displayValue: String {
        switch self {
        case .bool(let value): return value ? "on" : "off"
        case .number(let value): return value.formatted(.number.precision(.fractionLength(0...2)))
        case .string(let value): return value.isEmpty ? "—" : value
        case .none: return "—"
        }
    }
}

enum SourceSettingGroupOrder {
    static let known = ["fmp", "sec", "web_sources", "rag", "transcripts", "enrichment"]

    static func title(for group: String, catalog: [String: SourceSettingGroupInfo]) -> String {
        if let title = catalog[group]?.title, !title.isEmpty { return title }
        switch group {
        case "fmp": return "Financial Modeling Prep"
        case "sec": return "SEC EDGAR & Filings"
        case "web_sources": return "Web Sources"
        case "rag": return "RAG / Retrieval"
        case "transcripts": return "Earnings Transcripts"
        case "enrichment": return "Enrichment Cascade"
        default: return group.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    static func sortedKeys(from settings: [SourceSettingRow]) -> [String] {
        let present = Array(Set(settings.map(\.group)))
        let known = known.filter(present.contains)
        let extra = present.filter { !known.contains($0) }.sorted()
        return known + extra
    }
}

// MARK: - Shared display helpers

enum DeskCopy {
    /// Roth / traditional IRA — same-account wash sales have no taxable loss deduction.
    /// Accepts wire slugs (`roth_ira`) and display words (`Roth IRA`) so a live tax card
    /// that already says Roth never still renders the taxable wash-sale guard.
    static func isIraTaxation(_ raw: String?) -> Bool {
        let collapsed = raw?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ") ?? ""
        if collapsed.isEmpty { return false }
        if collapsed == "roth ira" || collapsed == "traditional ira" { return true }
        return collapsed.contains("ira") && (collapsed.contains("roth") || collapsed.contains("traditional"))
    }

    /// True when any account / capability / policy tax signal is IRA.  A taxable leftover
    /// on `taxSettings.washSaleHandling` must not win just because one field is empty.
    static func isIraAccount(
        accountTaxation: String?,
        capabilityType: String?,
        policyTaxation: String?
    ) -> Bool {
        [accountTaxation, capabilityType, policyTaxation].contains { isIraTaxation($0) }
    }

    /// Connected-account taxation wins, then capability account type, then policy tax settings.
    static func resolvedTaxationType(
        accountTaxation: String?,
        capabilityType: String?,
        policyTaxation: String?
    ) -> String? {
        let candidates = [accountTaxation, capabilityType, policyTaxation]
        if let ira = candidates.first(where: { isIraTaxation($0) }) {
            return ira?.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        for raw in candidates {
            let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !trimmed.isEmpty { return trimmed }
        }
        return nil
    }

    /// Never show the `__rotate__` seat sentinel.  Owner: lowercase "rotate models".
    static func modelSeatValue(_ raw: String?, fallbacks _: [String] = []) -> String {
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if isRotationSentinel(trimmed) {
            return "rotate models"
        }
        if trimmed.isEmpty { return "—" }
        return trimmed.lowercased()
    }

    static func isRotationSentinel(_ raw: String?) -> Bool {
        raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "__rotate__"
    }

    /// Same-account IRA wash sales are N/A.  Cross-account: ignored / auto / blocked.
    static func iraWashSaleRows(handling: String?) -> (sameAccount: String, crossAccount: String) {
        let normalized = handling?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let cross: String
        if normalized == "block" {
            cross = "blocked"
        } else if normalized == "auto" {
            cross = "auto"
        } else {
            cross = "ignored"
        }
        return ("not applicable", cross)
    }

    /// Scan refresh failed.  Do not reuse the workspace "Check your connection" sentence —
    /// SnapshotScaffold already shows that for a stale snapshot, and Retry there reloads
    /// the snapshot, not `/api/scan`.
    static let genericConnectionMessage = "Check your connection and try again."
    static let scanRefreshing = "Refreshing the scan — this can take up to 45 seconds."
    static let scanEmptyUniverse =
        "The scan returned no ranked names.  Confirm the universe on Guardrails, then refresh."
    static let scanEmptyFilter = "Nothing in this scan matches that filter."
    static let weeklyScreensNote =
        "Native value and momentum screens from this account's scan tape.  Advisory data only — not a trade trigger."
    static let weeklyScreensValueEmpty = "No names pass the value screen."
    static let weeklyScreensMomentumEmpty = "Momentum is waiting on daily bars."
    static let equityWaitingOnBroker = "waiting on broker"
    static let portfolioSelectAccount =
        "Select a connected account or retry when the broker is reachable."
    static let portfolioBrokerUnreachable =
        "The broker did not return holdings for this account.  Pull to refresh."

    static func scanRefreshFailed(from message: String) -> String {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed == genericConnectionMessage {
            return "Couldn’t refresh the market scan.  Check your connection and try again."
        }
        return trimmed
    }

    static func shouldShowScanEmptyState(hasFilter: Bool, loadFailed: Bool) -> Bool {
        hasFilter || !loadFailed
    }

    static func portfolioUnavailableMessage(hasConnectedAccount: Bool) -> String {
        hasConnectedAccount ? portfolioBrokerUnreachable : portfolioSelectAccount
    }

    /// Authority is Autopilot / Ask-First.  Run state is Running / Paused / Stopped.
    /// Never blend the two — Autopilot can be paused when the market is closed.
    static func authorityVersusRunState(
        authority: String?,
        runState: RunStateWord
    ) -> String {
        let authorityWord = AppFormat.strategyAuthorityLabel(authority)
        switch runState {
        case .running:
            return "\(authorityWord) is the decision style.  Run state is Running — scheduled cycles are live."
        case .pausedMarketClosed:
            return "\(authorityWord) is the decision style.  Run state is Paused · market closed — scheduled cycles wait for the next regular session."
        case .exitOnly:
            return "\(authorityWord) is the decision style.  Run state is Exit-only — the agent will not open new risk on its own.  Approving an opening places it anyway."
        case .windingDown:
            return "\(authorityWord) is the decision style.  Run state is Winding down — only sells are submitted."
        case .stopped:
            return "\(authorityWord) is the decision style.  Run state is Stopped — the agent is not scheduling cycles."
        }
    }

    static func joinedList(_ values: [String]?) -> String {
        let trimmed = (values ?? []).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        return trimmed.isEmpty ? "none" : trimmed.joined(separator: ", ")
    }

    /// Same labels as `INDEX_UNIVERSES` / web `INDICES`.  Storage slugs stay off the row.
    static let indexUniverseLabels: [String: String] = [
        "sp100": "S&P 100",
        "sp500": "S&P 500",
        "nasdaq100": "Nasdaq 100",
        "nasdaqComposite": "Nasdaq Composite",
        "dow30": "Dow 30",
        "russell2000": "Russell 2000",
        "nyseComposite": "NYSE Composite",
        "ftWilshire5000": "FT Wilshire 5000"
    ]

    static func indexUniverseLabel(_ value: String) -> String? {
        let key = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return nil }
        return indexUniverseLabels[key]
    }

    static func joinedIndexList(_ values: [String]?) -> String {
        let labels = (values ?? []).compactMap(indexUniverseLabel)
        return labels.isEmpty ? "none" : labels.joined(separator: ", ")
    }

    /// Mirror of `src/lib/guardrail-copy.ts` — keep sentences aligned.
    static let guardrailsHeaderSuffix = "authority, caps, and adjustable preferences"
    static let paperAccountWord = "paper"
    static let proposalConfirmOrderTitle = "Confirm Order"
    static let proposalApproveOrderButton = "Approve Order"
    static let proposalTypedConfirmHint = "Typed confirmation required for this order"
    static let exitOnlyOwnerApproveNote =
        "This account is Exit-only, so the agent will not open new risk on its own.  Approving this opening places it anyway."

    static let openConnectionsButton = "Open Connections"
    static let openGuardrailsButton = "Open Guardrails"
    static let accountNeedsConnection =
        "Use Open Connections to connect a broker account on the website, then select the account here."
    static let accountNeedsConnectionInline =
        "Use Open Connections to connect a broker account on the website, then select it here."

    /// Same destination as web readiness (`/console/guardrails`).  The in-app
    /// Guardrails tab is the universe editor, not a Strategy Safari handoff.
    /// "always-include symbols" tracks the row label — those names are exempt from the
    /// universe floor, which "extra symbols" made sound like a plain append.
    static let universeNeedsIndex =
        "Choose at least one base index (e.g. S&P 500) or add always-include symbols so the strategy has names to scan."

    static let universeRefreshAfterGuardrails =
        "Add an index or always-include symbols on Guardrails, then pull to refresh here."

    static let universeInsightDetail =
        "Choose at least one base index (e.g. S&P 500) or add always-include symbols."

    /// `sellToFundBuy` wire values are `off` / `suggest` / `propose` / `automated`.
    /// The bare slug "propose" is indistinguishable from the unrelated propose/Ask-first
    /// authority concept, so every value is spelled out as what it does.
    static func sellToFundValue(_ raw: String?) -> String {
        switch raw?.lowercased() {
        case .none, .some(""), "off": return "off"
        case "suggest": return "suggest only"
        case "propose": return "propose sells first"
        case "automated": return "sells automatically"
        case .some(let other): return other.replacingOccurrences(of: "_", with: " ").lowercased()
        }
    }

    /// `socraticOverrideMode` wire values are `off` / `propose` / `execute`.  The raw
    /// enum used to print straight through.  "Decide" is never shown to users either —
    /// Autopilot is the user-facing word for that authority mode.
    static func socraticOverrideValue(_ raw: String?) -> String {
        switch raw?.lowercased() {
        case .none, .some(""), "off": return "off"
        case "propose": return "propose only"
        case "execute": return "execute in Autopilot"
        case .some(let other): return other.replacingOccurrences(of: "_", with: " ").lowercased()
        }
    }

    static func yesNo(_ value: Bool?) -> String {
        guard let value else { return "—" }
        return value ? "yes" : "no"
    }

    static func percentPoints(_ value: Double?) -> String {
        guard let value else { return "—" }
        return "\(value.formatted(.number.precision(.fractionLength(0...2))))%"
    }

    /// Watchlist count is never the scan universe.  "watched" stays watchlist-only.
    static func scanCountLine(names: Int, scanned: Int?, quotes: Int?, watched: Int) -> String {
        var parts = ["\(names) names"]
        if let scanned {
            parts.append("\(scanned) scanned")
        }
        if let quotes {
            parts.append("\(quotes) quotes")
        }
        parts.append("\(watched) watched")
        return parts.joined(separator: " · ")
    }

    static let scanUniverseNote =
        "Ranked candidates for the current universe.  Watchlist names are not the scan universe.  Adding or removing a watchlist name does not place an order."

    static func scanEmptyTitle(hasFilter: Bool) -> String {
        hasFilter ? "No Matching Names" : "No Candidates"
    }

    static func scanEmptyMessage(scanned: Int?, quotes: Int?, hasFilter: Bool) -> String {
        if hasFilter {
            return "Nothing in this scan matches that filter."
        }
        if (scanned ?? 0) == 0 {
            return "This universe has no symbols.  Choose a base index or add symbols on Guardrails, then refresh."
        }
        if (quotes ?? 0) == 0 {
            return "The scan could not price any names.  Refresh after quotes recover."
        }
        return "The scan returned no ranked names.  Refresh after quotes recover."
    }

    static let scanLoadingNote = "Refreshing the scan.  This can take about 40 seconds."

    /// Failed refresh stays a banner.  Last-good names stay on screen.
    static func scanRefreshFailedBanner(reason: String, lastGoodAt: String?) -> String {
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let lastGoodAt, !lastGoodAt.isEmpty else { return trimmed }
        let stamped = AppFormat.dateTime(lastGoodAt)
        if stamped == "—" { return trimmed }
        return "\(trimmed)  Showing the last good scan from \(stamped)."
    }
}
