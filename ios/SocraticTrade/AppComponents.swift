import SwiftUI
import Charts

enum AppPalette {
    static let background = Color(uiColor: .systemGroupedBackground)
    static let card = Color(uiColor: .secondarySystemGroupedBackground)
    /// Brand teal — matches web `--brand-accent` (#12616f) and dark `--brand-accent-dark` (#58c7d3).
    static let accent = Color(uiColor: UIColor { traits in
        if traits.userInterfaceStyle == .dark {
            return UIColor(red: 0x58 / 255, green: 0xC7 / 255, blue: 0xD3 / 255, alpha: 1) // #58c7d3
        }
        return UIColor(red: 0x12 / 255, green: 0x61 / 255, blue: 0x6F / 255, alpha: 1) // #12616f
    })
    static let positive = Color(uiColor: UIColor { traits in
        if traits.userInterfaceStyle == .dark {
            return .systemGreen
        }
        return UIColor(red: 0x1A / 255, green: 0x7F / 255, blue: 0x37 / 255, alpha: 1) // #1a7f37
    })
    static let warning = Color(uiColor: UIColor { traits in
        if traits.userInterfaceStyle == .dark {
            return .systemOrange
        }
        return UIColor(red: 0x9A / 255, green: 0x67 / 255, blue: 0x00 / 255, alpha: 1) // #9a6700
    })
    static let negative = Color(uiColor: UIColor { traits in
        if traits.userInterfaceStyle == .dark {
            return .systemRed
        }
        return UIColor(red: 0xB3 / 255, green: 0x26 / 255, blue: 0x1E / 255, alpha: 1) // #b3261e
    })
}

enum AppFormat {
    /// Humanized mobile command types — mirrors PWA `commandLabel`. API ids stay dotted.
    private static let commandLabels: [String: String] = [
        "strategy.run_once": "Run Once",
        "strategy.start": "Start Agent",
        "strategy.stop": "Stop Agent",
        // Deliberately Title Case and NOT the state word "Exit-only": these are COMMAND
        // names, exactly like "Wind Down" below, whose state word is "Winding down".
        // Do not "unify" this with RunStateWord.exitOnly — the HomeView button of the
        // same name reads from this map, and the two forms are different parts of speech.
        "strategy.close_only": "Exit Only",
        "strategy.liquidating": "Wind Down",
        "proposal.approve": "Approve Proposal",
        "proposal.reject": "Reject Proposal",
        "proposal.retry_red_team": "Retry Red Team",
        "account.activate": "Switch Account",
        "order.cancel": "Cancel Order",
        "watchlist.add": "Add to Watchlist",
        "watchlist.remove": "Remove from Watchlist",
        "alert.create": "Create Alert",
        "alert.delete": "Delete Alert",
        // Neutral wording: the phone now edits in either direction, and Activity shows both.
        "policy.patch": "Policy Change"
    ]

    /// Full money by default (`$99,812.34`). Compact uses lowercase suffixes (`$99.8k`, `$1.2m`)
    /// to match web compact style when used.
    static func money(_ value: Double?, compact: Bool = false) -> String {
        guard let value else { return "—" }
        if compact, abs(value) >= 1_000 {
            let magnitude: Double
            let suffix: String
            if abs(value) >= 1_000_000_000 {
                magnitude = 1_000_000_000
                suffix = "b"
            } else if abs(value) >= 1_000_000 {
                magnitude = 1_000_000
                suffix = "m"
            } else {
                magnitude = 1_000
                suffix = "k"
            }
            let sign = value < 0 ? "−" : ""
            let scaled = abs(value) / magnitude
            return "\(sign)$\(scaled.formatted(.number.precision(.fractionLength(0...1))))\(suffix)"
        }
        return value.formatted(
            .currency(code: "USD")
                .precision(.fractionLength(0...2))
        )
    }

    static func number(_ value: Double?) -> String {
        guard let value else { return "—" }
        return value.formatted(.number.precision(.fractionLength(0...4)))
    }

    static func percent(_ value: Double?, signed: Bool = false) -> String {
        guard let value else { return "—" }
        let prefix = signed && value > 0 ? "+" : ""
        return "\(prefix)\(value.formatted(.number.precision(.fractionLength(1))))%"
    }

    static func dateTime(_ value: String?) -> String {
        guard let date = date(value) else { return "—" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    static func relative(_ value: String?) -> String {
        // Value/answer copy — sentence case, not a heading.
        guard let date = date(value) else { return "not scheduled" }
        return date.formatted(.relative(presentation: .named))
    }

    static func relative(_ date: Date?) -> String {
        guard let date else { return "never" }
        return date.formatted(.relative(presentation: .named))
    }

    /// Last strategy start.  Never talks about the cadence clock — a missing
    /// stamp is "never", not "not scheduled".
    static func lastRun(_ value: String?) -> String {
        guard let date = date(value) else { return "never" }
        return date.formatted(.relative(presentation: .named))
    }

    /// Next cadence fire.  "not scheduled" only when autonomy is off.  An
    /// Autopilot account with a missing stamp is due at the next session.
    static func nextRun(_ value: String?, autonomyActive: Bool) -> String {
        if let date = date(value) {
            return date.formatted(.relative(presentation: .named))
        }
        return autonomyActive ? "due at next session" : "not scheduled"
    }

    /// Authority glossary: never show raw propose/decide — Ask-first / Autopilot (console parity).
    /// This renders mid-sentence and inside status pills — both VALUE contexts, so it is
    /// sentence case, matching web `labels.ts` and its siblings "Exit-only" / "Winding down".
    /// Settings *values* use `strategyAuthorityValue`.
    static func strategyAuthorityLabel(_ value: String?) -> String {
        switch value?.lowercased() {
        case "propose": return "Ask-first"
        case "decide": return "Autopilot"
        case .none, .some(""): return "—"
        case .some(let raw): return raw.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    /// Settings / LabeledContent *value* — not a heading (owner: "ask-first", "intraday").
    static func strategyAuthorityValue(_ value: String?) -> String {
        switch value?.lowercased() {
        case "propose": return "ask-first"
        case "decide": return "autopilot"
        case .none, .some(""): return "—"
        case .some(let raw): return raw.replacingOccurrences(of: "_", with: " ").lowercased()
        }
    }

    /// Policy horizon value for settings (e.g. "intraday"), not title case.
    static func policyHorizonValue(_ value: String?) -> String {
        guard let value, !value.isEmpty else { return "—" }
        return value.replacingOccurrences(of: "_", with: " ").lowercased()
    }

    /// Cadence value, e.g. "every 60 min" (not "Every 60 min").
    static func cadenceMinutesValue(_ minutes: Int?) -> String {
        guard let minutes else { return "manual" }
        return "every \(minutes) min"
    }

    /// Order / stop type slug → readable words (`stop_market` → `Stop Market`).
    static func orderTypeLabel(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "—" }
        return raw
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }
            .joined(separator: " ")
    }

    /// Market session for status banner: "Market Closed", "Market Open", etc.
    static func marketSessionBannerLabel(_ session: String?) -> String {
        switch (session ?? "").lowercased() {
        case "regular", "open": return "Market Open"
        case "pre": return "Pre-Market"
        case "post": return "After Hours"
        case "closed": return "Market Closed"
        case "": return "Market Session"
        default:
            return (session ?? "")
                .replacingOccurrences(of: "_", with: " ")
                .capitalized
        }
    }

    /// Account environment annotation: live is unmarked (all money is real to the owner);
    /// paper is "Broker (paper)" with lowercase p.
    static func accountBrokerEnvironmentLine(broker: String, environment: String) -> String {
        let name = broker.trimmingCharacters(in: .whitespacesAndNewlines)
        let display = name.isEmpty ? "Broker" : name.prefix(1).uppercased() + name.dropFirst().lowercased()
        if environment.lowercased() == "paper" {
            return "\(display) (paper)"
        }
        return String(display)
    }

    /// Red Team failure-kind slug → console wording (src/lib/red-team-routing.ts
    /// `describeRedTeamFailureKind`): "not configured", "provider error", …, else "unavailable".
    static func redTeamFailureKindLabel(_ failureKind: String?) -> String {
        switch failureKind {
        case "not_configured": return "not configured"
        case "timeout": return "timeout"
        case "provider_error": return "provider error"
        case "rate_limited": return "rate limited"
        case "malformed_response": return "malformed response"
        default: return "unavailable"
        }
    }

    /// AccountCapabilities.accountType slug → console wording (app/console/settings/brokers.tsx
    /// TAXATION_WORD style): never render raw snake_case slugs like "roth_ira" to the user.
    static func accountTypeWord(_ accountType: String) -> String {
        switch accountType {
        case "brokerage": return "brokerage"
        case "roth_ira": return "Roth IRA"
        case "traditional_ira": return "traditional IRA"
        case "crypto_exchange": return "crypto exchange"
        default: return accountType.replacingOccurrences(of: "_", with: " ")
        }
    }

    /// Humanized command type for Activity / busy strips.
    static func commandLabel(_ commandType: String) -> String {
        if let known = commandLabels[commandType] { return known }
        return commandType
            .replacingOccurrences(of: ".", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { $0.capitalized }
            .joined(separator: " ")
    }

    /// Mirrors web `approval-card.tsx` placement toasts — same status strings, honest copy.
    static func placementApproveMessage(status: String, reasons: [String]?) -> String {
        let detail = reasons?
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let detail, !detail.isEmpty,
           status == "blocked" || status == "busy" || status == "not_placed" || status == "error" {
            return detail
        }
        switch status {
        case "filled":
            return "Order filled — waiting for desk refresh."
        case "placed":
            return "Order placed — waiting for desk refresh."
        case "paper":
            return "Paper trade filled — waiting for desk refresh."
        case "blocked":
            return detail ?? "Blocked at approval time."
        case "busy":
            return detail ?? "Approval is still busy — wait for the run to finish, then approve again."
        case "not_placed":
            return detail ?? "Order not placed — safe to retry."
        default:
            return detail ?? placementStatusLabel(status)
        }
    }

    static func placementStatusLabel(_ status: String) -> String {
        switch status.lowercased() {
        case "filled": return "Filled"
        case "placed": return "Placed"
        case "paper": return "Paper trade"
        case "blocked": return "Blocked"
        case "busy": return "Busy"
        case "not_placed": return "Not placed — safe to retry"
        case "error": return "Placement failed"
        case "rejected", "rejected_by_broker": return "Rejected by broker"
        default:
            return status
                .replacingOccurrences(of: "_", with: " ")
                .split(separator: " ")
                .map { $0.capitalized }
                .joined(separator: " ")
        }
    }

    static func placementApproveColor(status: String) -> Color {
        switch status {
        case "filled", "placed", "paper":
            return AppPalette.positive
        case "blocked", "busy":
            return AppPalette.warning
        default:
            return AppPalette.accent
        }
    }

    static func placementApproveSystemImage(status: String) -> String {
        switch status {
        case "filled", "placed", "paper":
            return "checkmark.circle.fill"
        case "blocked", "busy":
            return "exclamationmark.triangle.fill"
        default:
            return "info.circle.fill"
        }
    }

    /// Central time, explicitly labeled — fleet convention for any user-facing timestamp that
    /// shows a timezone. Used by SymbolInfoSheet's quote-as-of line; other mobile timestamps
    /// intentionally stay device-local (unchanged, out of scope here).
    static func dateTimeCentral(_ value: String?) -> String {
        guard let date = date(value) else { return "—" }
        let central = TimeZone(identifier: "America/Chicago") ?? .current
        return date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, timeZone: central)) + " CT"
    }

    /// P/E display per the repo's P/E honesty convention (mirrors
    /// app/console/ui/drilldown-data.ts `peDisplay`): eps decides the no-ratio state first —
    /// negative/zero trailing earnings render "n/a" (a real, computed "no ratio" state, not
    /// missing data); a strictly positive ratio renders as a number; anything else means the
    /// data simply wasn't available.
    static func peRatioDisplay(peRatio: Double?, eps: Double?) -> String {
        if let eps, eps <= 0 { return "n/a" }
        if let peRatio, peRatio > 0 { return peRatio.formatted(.number.precision(.fractionLength(1))) }
        return "—"
    }

    private static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        if let parsed = ISO8601DateFormatter.withFractionalSeconds.date(from: value) {
            return parsed
        }
        return ISO8601DateFormatter.standard.date(from: value)
    }
}

private extension ISO8601DateFormatter {
    static let standard = ISO8601DateFormatter()

    static let withFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

struct AppCard<Content: View>: View {
    private let content: Content
    private let padding: CGFloat

    init(padding: CGFloat = 16, @ViewBuilder content: () -> Content) {
        self.padding = padding
        self.content = content()
    }

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(padding)
            .background(AppPalette.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(Color.primary.opacity(0.06), lineWidth: 1)
            }
    }
}

struct SectionHeading: View {
    let title: String
    let subtitle: String?

    init(_ title: String, subtitle: String? = nil) {
        self.title = title
        self.subtitle = subtitle
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.appTitle3.weight(.semibold))
            if let subtitle {
                Text(subtitle)
                    .font(.appCaption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityAddTraits(.isHeader)
    }
}

/// Where the optional metric detail sits relative to the large value.
enum MetricTileDetailPlacement: Sendable {
    /// Under the value (default).
    case below
    /// Same row, smaller type to the right of the value (e.g. Positions: "14" + "open holdings").
    case trailing
}

struct MetricTile: View {
    let title: String
    let value: String
    let detail: String?
    let detailPlacement: MetricTileDetailPlacement
    let tint: Color

    init(
        title: String,
        value: String,
        detail: String? = nil,
        detailPlacement: MetricTileDetailPlacement = .below,
        tint: Color = AppPalette.accent
    ) {
        self.title = title
        self.value = value
        self.detail = detail
        self.detailPlacement = detailPlacement
        self.tint = tint
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.appCaption)
                .foregroundStyle(.secondary)
            if let detail, detailPlacement == .trailing {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(value)
                        .font(.appTitle3.weight(.semibold))
                        .foregroundStyle(tint)
                        .fixedSize(horizontal: true, vertical: true)
                    Text(detail)
                        .font(.appCaption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Spacer(minLength: 0)
                }
            } else {
                Text(value)
                    .font(.appTitle3.weight(.semibold))
                    .foregroundStyle(tint)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail {
                    Text(detail)
                        .font(.appCaption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(tint.opacity(0.09), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// Company logo for a ticker (same open ticker-icons source as the web console).
/// Falls back to a 1–2 letter monogram when the image is missing or fails to load.
struct TickerLogo: View {
    let symbol: String
    var size: CGFloat = 22

    @State private var failed = false

    private var normalized: String {
        symbol.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "$", with: "")
            .uppercased()
    }

    private var monogram: String {
        let base = normalized.split { $0 == "." || $0 == "-" || $0 == "_" }.first.map(String.init) ?? normalized
        return String(base.prefix(2))
    }

    private var logoURL: URL? {
        guard !normalized.isEmpty else { return nil }
        // Parity with src/lib/ticker-logos.ts TICKER_LOGO_BASE_URL
        return URL(string: "https://raw.githubusercontent.com/davidepalazzo/ticker-logos/main/ticker_icons/\(normalized).png")
    }

    var body: some View {
        Group {
            if failed || logoURL == nil {
                monogramView
            } else if let logoURL {
                AsyncImage(url: logoURL) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFit()
                            .padding(2)
                    case .failure:
                        monogramView
                            .onAppear { failed = true }
                    case .empty:
                        ProgressView()
                            .controlSize(.mini)
                    @unknown default:
                        monogramView
                    }
                }
            }
        }
        .frame(width: size, height: size)
        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        .accessibilityHidden(true)
        .onChange(of: normalized) { _, _ in failed = false }
    }

    private var monogramView: some View {
        Text(monogram)
            .font(.custom(AppFont.bold, size: max(9, size * 0.38)))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Identifiable wrapper for `.sheet(item:)` presentation of `SymbolInfoSheet` from any list row.
/// Each screen that shows symbols (Activity, Markets) owns one `@State private var
/// presentedSymbol: PresentedSymbol?` and threads it down as a `Binding` to `SymbolTapButton`.
struct PresentedSymbol: Identifiable, Equatable {
    let symbol: String
    var id: String { symbol }
}

/// Sheet payload for a company quote, a fill, or a position. Fill/position cards
/// present `.fill` / `.position` so tapping anywhere on the card opens trade or
/// position facts plus the same company stats the logo used to open alone.
enum PresentedMarketItem: Identifiable, Equatable {
    case company(String)
    case fill(FillEvent)
    case position(Position)

    var id: String {
        switch self {
        case .company(let symbol): return "company:\(symbol)"
        case .fill(let fill): return "fill:\(fill.id)"
        case .position(let position): return "position:\(position.symbol)"
        }
    }

    var symbol: String {
        switch self {
        case .company(let symbol): return symbol
        case .fill(let fill): return fill.symbol
        case .position(let position): return position.symbol
        }
    }

    var fill: FillEvent? {
        if case .fill(let fill) = self { return fill }
        return nil
    }

    var position: Position? {
        if case .position(let position) = self { return position }
        return nil
    }
}

/// Tappable ticker logo + symbol text that opens `SymbolInfoSheet` for `symbol` — the mobile
/// counterpart to the web console's `SymbolButton` (app/console/ui/symbol-drilldown.tsx). Wrap
/// wherever a row shows a symbol; pass `action` to set the screen's `presentedSymbol` state.
/// A real button (not a bare tap gesture), so it carries button accessibility traits for free —
/// only the accessible label needs to be supplied here.
struct SymbolTapButton: View {
    let symbol: String
    var logoSize: CGFloat = 26
    var font: Font = .headline
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                TickerLogo(symbol: symbol, size: logoSize)
                Text(symbol)
                    .font(font)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(symbol) company info")
    }
}

struct StatusPill: View {
    let text: String
    let color: Color
    let systemImage: String?

    init(_ text: String, color: Color, systemImage: String? = nil) {
        self.text = text
        self.color = color
        self.systemImage = systemImage
    }

    var body: some View {
        HStack(spacing: 5) {
            if let systemImage {
                Image(systemName: systemImage)
            }
            Text(text)
        }
        .font(.appCaption.weight(.semibold))
        .foregroundStyle(color)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(color.opacity(0.12), in: Capsule())
    }
}

struct EmptyStateCard: View {
    let title: String
    let message: String
    let systemImage: String

    var body: some View {
        AppCard {
            VStack(spacing: 10) {
                Image(systemName: systemImage)
                    .font(.appTitle2)
                    .foregroundStyle(.secondary)
                Text(title)
                    .font(.appHeadline)
                Text(message)
                    .font(.appSubheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
        }
    }
}

struct InlineErrorBanner: View {
    let message: String
    let retry: () -> Void
    let dismiss: () -> Void

    var body: some View {
        AppCard {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(AppPalette.warning)
                VStack(alignment: .leading, spacing: 8) {
                    Text(message)
                        .font(.appSubheadline)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Button("Retry", action: retry)
                            .buttonStyle(.bordered)
                        Button("Dismiss", action: dismiss)
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
        }
    }
}

/// Presents `MobileStore` operation feedback as alerts anchored to the presenting view.
/// Snapshot refresh no longer clears these messages, so guardrail edits and queued commands
/// can surface failures after `load()` completes.
struct StoreTransientAlerts: ViewModifier {
    @EnvironmentObject private var store: MobileStore

    func body(content: Content) -> some View {
        content
            .alert(
                "Something Went Wrong",
                isPresented: Binding(
                    get: { store.error != nil },
                    set: { if !$0 { store.dismissError() } }
                )
            ) {
                Button("OK") { store.dismissError() }
            } message: {
                Text(store.error ?? "")
            }
            .alert(
                "Saved",
                isPresented: Binding(
                    get: { store.successMessage != nil },
                    set: { if !$0 { store.dismissSuccess() } }
                )
            ) {
                Button("OK") { store.dismissSuccess() }
            } message: {
                Text(store.successMessage ?? "")
            }
    }
}

extension View {
    func storeTransientAlerts() -> some View {
        modifier(StoreTransientAlerts())
    }
}

struct SnapshotScaffold<Content: View>: View {
    @EnvironmentObject private var store: MobileStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    let content: (MobileSnapshot) -> Content
    /// Optional `.id(_:)` value inside `content` to scroll into view — used by deep links that
    /// point at one row (a specific proposal).  Screens that never take a link pass nothing.
    private let scrollTarget: String?
    /// Scan (and any other screen with its own Retry) must not stack a second
    /// workspace banner that reloads the snapshot instead of this screen's data.
    private let hidesWorkspaceError: Bool

    /// Live width of the scroll area, so the card flow can pick its column count.  Starts at
    /// zero, which resolves to one column — the phone layout — until the first measurement
    /// lands, so nothing ever flashes a wide layout on a narrow screen.
    @State private var scrollWidth: CGFloat = 0

    init(
        scrollTarget: String? = nil,
        hidesWorkspaceError: Bool = false,
        @ViewBuilder content: @escaping (MobileSnapshot) -> Content
    ) {
        self.scrollTarget = scrollTarget
        self.hidesWorkspaceError = hidesWorkspaceError
        self.content = content
    }

    /// Width the cards themselves get: the scroll area, clamped so a 27-inch Mac window keeps
    /// margins instead of 2000pt-wide cards, less the horizontal padding.
    private var cardAreaWidth: CGFloat {
        max(0, min(scrollWidth, ContentColumns.maximumContentWidth) - ContentColumns.horizontalPadding * 2)
    }

    private var columns: Int {
        ContentColumns.count(width: cardAreaWidth, isRegularWidth: AppLayout.isRegularWidth(horizontalSizeClass))
    }

    /// Fixed once, so the 30s refresh schedule counts from first appearance.
    @State private var scheduleAnchor = Date()

    var body: some View {
        ZStack {
            AppPalette.background.ignoresSafeArea()

            ScrollViewReader { proxy in
                ScrollView {
                    cards()
                        .padding(.horizontal, ContentColumns.horizontalPadding)
                        .padding(.vertical, 12)
                        .frame(maxWidth: ContentColumns.maximumContentWidth)
                        // Second frame centres the clamped column in a wide window.
                        .frame(maxWidth: .infinity)
                }
                .refreshable {
                    await store.load()
                }
                .onGeometryChange(for: CGFloat.self) { proxy in
                    proxy.size.width
                } action: { width in
                    scrollWidth = width
                }
                .onAppear { scroll(with: proxy) }
                .onChange(of: scrollTarget) { _, _ in scroll(with: proxy) }
                // The target row may only exist after the next snapshot lands.
                .onChange(of: store.lastUpdatedAt) { _, _ in scroll(with: proxy) }
            }

            if store.snapshot == nil {
                InitialSnapshotState()
            }
        }
    }

    /// One column keeps the exact phone layout — a `LazyVStack`, unchanged, so nothing about
    /// iPhone rendering or its laziness moves.  Two or three columns switch to the card flow,
    /// which only an iPad or a wide Mac window ever reaches.
    @ViewBuilder
    private func cards() -> some View {
        if columns > 1 {
            CardColumns(columns: columns) {
                if let snapshot = store.snapshot {
                    SnapshotStatusBanner(snapshot: snapshot)
                        .cardSpansAllColumns()
                    if store.partialData {
                        PartialDataBanner(dropCounts: snapshot.partialDropCounts)
                            .cardSpansAllColumns()
                    }
                    content(snapshot)
                }
            }
        } else {
            LazyVStack(spacing: 14) {
                if let snapshot = store.snapshot {
                    SnapshotStatusBanner(snapshot: snapshot)
                    if store.partialData {
                        PartialDataBanner(dropCounts: snapshot.partialDropCounts)
                    }
                    content(snapshot)
                }
            }
        }
    }

    private func refresh() {
        Task { await store.load() }
    }

    private func scroll(with proxy: ScrollViewProxy) {
        guard let scrollTarget else { return }
        withAnimation(.easeInOut(duration: 0.25)) {
            proxy.scrollTo(scrollTarget, anchor: .top)
        }
    }
}

private struct InitialSnapshotState: View {
    @EnvironmentObject private var store: MobileStore

    var body: some View {
        VStack(spacing: 16) {
            if store.isRefreshing || store.isInitialLoading {
                ProgressView()
                    .controlSize(.large)
                Text("Loading your trading workspace…")
                    .font(.appSubheadline)
                    .foregroundStyle(.secondary)
            } else {
                Image(systemName: "wifi.exclamationmark")
                    .font(.appLargeTitle)
                    .foregroundStyle(AppPalette.warning)
                Text("Couldn’t load your workspace")
                    .font(.appHeadline)
                Text(store.error ?? "Check your connection and try again.")
                    .font(.appSubheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("Try Again") {
                    Task { await store.load() }
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(28)
    }
}

private struct SnapshotStatusBanner: View {
    @EnvironmentObject private var store: MobileStore

    let snapshot: MobileSnapshot
    @State private var scheduleAnchor = Date()

    var body: some View {
        TimelineView(.periodic(from: scheduleAnchor, by: 30)) { context in
            let stale = store.isSnapshotStale(at: context.date)
            HStack(spacing: 8) {
                StatusPill(
                    stale ? "Stale" : "Updated",
                    color: stale ? AppPalette.warning : AppPalette.positive,
                    systemImage: stale ? "clock.badge.exclamationmark" : "checkmark.circle.fill"
                )
                Text("\(AppFormat.relative(store.lastUpdatedAt))")
                    .font(.appCaption)
                    .foregroundStyle(.secondary)
                Spacer()
                if store.isRefreshing {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("Refreshing")
                } else {
                    Image(systemName: store.isStreamConnected ? "dot.radiowaves.left.and.right" : "arrow.triangle.2.circlepath")
                        .foregroundStyle(store.isStreamConnected ? AppPalette.positive : .secondary)
                        .accessibilityLabel(store.isStreamConnected ? "Live" : "Updating")
                }
                // Keep the circlepath / radio glyph; label is "Market Closed" etc. on every tab.
                Text(AppFormat.marketSessionBannerLabel(snapshot.marketSession))
                    .font(.appCaption.weight(.medium))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 4)
        }
    }
}

/// 2026-09-23 MM (held-batch): surfaces the partial-decode state from the most recent
/// snapshot decode so the user understands why Owner Approve is disabled.  Renders only when
/// `store.partialData == true` (the parent view guards the insert).  Drops are item-level,
/// not whole-collection — every money-path collection that lost an item is listed in the
/// message so the user can judge whether to refresh-and-retry or back off.
private struct PartialDataBanner: View {
    @EnvironmentObject private var store: MobileStore
    let dropCounts: MobileSnapshot.PartialDropCounts

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(AppPalette.warning)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text("Partial data — approvals paused")
                    .font(.appSubheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                Text(message)
                    .font(.appCaption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Button {
                Task { await store.load() }
            } label: {
                Label("Refresh", systemImage: "arrow.triangle.2.circlepath")
                    .labelStyle(.titleAndIcon)
                    .font(.appCaption.weight(.medium))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .accessibilityLabel("Refresh workspace")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(AppPalette.warning.opacity(0.08))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(AppPalette.warning.opacity(0.35), lineWidth: 1)
        )
    }

    private var message: String {
        var parts: [String] = []
        if dropCounts.positions > 0 {
            parts.append("\(dropCounts.positions) position\(dropCounts.positions == 1 ? "" : "s")")
        }
        if dropCounts.orders > 0 {
            parts.append("\(dropCounts.orders) order\(dropCounts.orders == 1 ? "" : "s")")
        }
        if dropCounts.pendingProposals > 0 {
            parts.append("\(dropCounts.pendingProposals) pending proposal\(dropCounts.pendingProposals == 1 ? "" : "s")")
        }
        let which = parts.isEmpty ? "snapshot items" : parts.joined(separator: ", ")
        return "\(which) were dropped during decode. Owner Approve is paused until a clean refresh lands — a pending proposal might not be visible right now."
    }
}

/// Centralized haptic feedback helper for iOS touch actions.
enum AppHaptics {
    static func success() {
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(.success)
    }

    static func warning() {
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(.warning)
    }

    static func error() {
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(.error)
    }

    static func light() {
        let generator = UIImpactFeedbackGenerator(style: .light)
        generator.prepare()
        generator.impactOccurred()
    }

    static func medium() {
        let generator = UIImpactFeedbackGenerator(style: .medium)
        generator.prepare()
        generator.impactOccurred()
    }

    static func heavy() {
        let generator = UIImpactFeedbackGenerator(style: .heavy)
        generator.prepare()
        generator.impactOccurred()
    }
}

/// Presentation for the shared run-state vocabulary (tones mirror console deriveStateInfo:
/// running=pos, paused=muted, exit-only/winding-down=warn, stopped=neg).
extension RunStateWord {
    var pillColor: Color {
        switch self {
        case .running: return AppPalette.positive
        case .pausedMarketClosed: return .secondary
        case .exitOnly, .windingDown: return AppPalette.warning
        case .stopped: return AppPalette.negative
        }
    }

    var pillSystemImage: String {
        switch self {
        case .running: return "bolt.fill"
        case .pausedMarketClosed: return "moon.zzz.fill"
        case .exitOnly, .windingDown: return "arrow.down.right.circle"
        case .stopped: return "pause.fill"
        }
    }
}

/// Trailing swipe-reveal action for card rows inside ScrollView stacks (SwiftUI's
/// `.swipeActions` is List-only).  Swiping left reveals one action button; tapping it fires
/// `perform` and closes.  The gesture needs a mostly-horizontal drag, so vertical scrolling
/// keeps working.  This adds a faster path to EXISTING actions only — same handlers, same
/// ceremony — never a new kind of confirmation.
struct SwipeRevealAction: ViewModifier {
    let title: String
    let systemImage: String
    let tint: Color
    let isEnabled: Bool
    let perform: () -> Void

    @State private var offset: CGFloat = 0
    @State private var isOpen = false

    private let actionWidth: CGFloat = 88

    func body(content: Content) -> some View {
        content
            // Both of these are gated on `isEnabled`, not just the closure inside the
            // action.  They were attached unconditionally with a `guard isEnabled else
            // { return }` inside — so a row whose action is disabled still ADVERTISED the
            // rotor entry (silently doing nothing when invoked) and still promised a swipe
            // gesture that is switched off.  `accessibilityActions` has a conditional form;
            // `accessibilityAction(named:)` does not, which is why the guard was there.
            // Nothing is lost when it is off — the in-row Cancel and trash buttons are
            // separately labelled and still present.
            .accessibilityActions {
                if isEnabled {
                    Button(title) { perform() }
                }
            }
            .accessibilityHint(isEnabled ? "Swipe left to \(title.lowercased()), or use this action." : "")
            .offset(x: offset)
            .background(alignment: .trailing) {
                if offset < 0 {
                    Button(action: fire) {
                        VStack(spacing: 5) {
                            Image(systemName: systemImage)
                                .font(.appBody.weight(.semibold))
                            Text(title)
                                .font(.appCaption.weight(.semibold))
                        }
                        .foregroundStyle(.white)
                        .frame(width: actionWidth)
                        .frame(maxHeight: .infinity)
                        .background(tint, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(title)
                }
            }
            // Plain .gesture (not highPriority): the ScrollView keeps winning vertical pans.
            .gesture(dragGesture, including: isEnabled ? .all : .subviews)
            .onTapGesture {
                if isOpen { close() }
            }
            .animation(.snappy(duration: 0.22), value: offset)
    }

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 24, coordinateSpace: .local)
            .onChanged { value in
                guard isEnabled else { return }
                // Mostly-horizontal drags only, so the scroll view keeps vertical swipes.
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                let base = isOpen ? -actionWidth : 0
                offset = min(0, max(-actionWidth - 26, base + value.translation.width))
            }
            .onEnded { value in
                guard isEnabled else { return }
                if offset < -actionWidth * 0.55 {
                    offset = -actionWidth
                    isOpen = true
                } else {
                    close()
                }
            }
    }

    private func fire() {
        close()
        perform()
    }

    private func close() {
        offset = 0
        isOpen = false
    }
}

extension View {
    /// See `SwipeRevealAction`.
    func swipeRevealAction(
        title: String,
        systemImage: String,
        tint: Color,
        isEnabled: Bool = true,
        perform: @escaping () -> Void
    ) -> some View {
        modifier(SwipeRevealAction(
            title: title,
            systemImage: systemImage,
            tint: tint,
            isEnabled: isEnabled,
            perform: perform
        ))
    }
}

/// Horizontal wrap that sizes each child to its intrinsic width.
/// Used by watchlist chips so a logo + ticker + remove control is never
/// forced into a too-narrow equal-width grid cell (which wrapped `SPCX`
/// onto two lines).  Layout math is in `WrappingHStackLayout` so XCTest
/// can cover wrap vs. single-line without hosting SwiftUI.
struct WrappingHStack: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        return WrappingHStackLayout.place(
            widths: sizes.map(\.width),
            heights: sizes.map(\.height),
            containerWidth: proposal.width ?? .infinity,
            spacing: spacing,
            lineSpacing: lineSpacing
        ).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        let result = WrappingHStackLayout.place(
            widths: sizes.map(\.width),
            heights: sizes.map(\.height),
            containerWidth: bounds.width,
            spacing: spacing,
            lineSpacing: lineSpacing
        )
        for index in subviews.indices {
            subviews[index].place(
                at: CGPoint(
                    x: bounds.minX + result.origins[index].x,
                    y: bounds.minY + result.origins[index].y
                ),
                proposal: ProposedViewSize(sizes[index])
            )
        }
    }
}

enum WrappingHStackLayout {
    struct Result: Equatable {
        var size: CGSize
        var origins: [CGPoint]
    }

    static func place(
        widths: [CGFloat],
        heights: [CGFloat],
        containerWidth: CGFloat,
        spacing: CGFloat,
        lineSpacing: CGFloat
    ) -> Result {
        precondition(widths.count == heights.count)
        guard !widths.isEmpty else {
            return Result(size: .zero, origins: [])
        }

        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        var maxX: CGFloat = 0
        var origins: [CGPoint] = []
        origins.reserveCapacity(widths.count)

        for index in widths.indices {
            let width = widths[index]
            let height = heights[index]
            if x > 0 && x + width > containerWidth {
                y += lineHeight + lineSpacing
                x = 0
                lineHeight = 0
            }
            origins.append(CGPoint(x: x, y: y))
            x += width
            maxX = max(maxX, x)
            x += spacing
            lineHeight = max(lineHeight, height)
        }

        return Result(
            size: CGSize(width: maxX, height: y + lineHeight),
            origins: origins
        )
    }
}

/// Breakpoints for the dashboard card flow.
///
/// Widths here are the CARD AREA — the scroll width already clamped and stripped of its
/// horizontal padding — not the window.  Kept as plain numbers so XCTest can pin the
/// iPad Air 11" cases (820pt portrait, 1180pt landscape) without hosting SwiftUI.
enum ContentColumns {
    /// Padding `SnapshotScaffold` puts on each side of the card area.
    static let horizontalPadding: CGFloat = 16
    /// Cards stop widening here.  Past it a Mac window gets margins rather than 1400pt-wide
    /// lines of text nobody can track back to the next row.
    static let maximumContentWidth: CGFloat = 1360
    /// Below this a second column makes both halves narrower than a phone card.
    static let twoColumnMinimum: CGFloat = 680
    /// At and above this a third column still leaves every card wider than an iPhone's.
    static let threeColumnMinimum: CGFloat = 1100
    /// Widest a single column of prose or chat may get before lines stop being trackable.
    /// Used by screens that are one conversation rather than a wall of cards.
    static let readableWidth: CGFloat = 760
    /// Widest a full-bleed primary action should be drawn.  A 1300pt-wide button is not a
    /// bigger target, it is a banner nobody reads as a button.
    static let maximumActionWidth: CGFloat = 520

    /// - Parameter isRegularWidth: compact width — every iPhone, an iPad in Slide Over — always
    ///   gets one column, whatever the measurement says.
    static func count(width: CGFloat, isRegularWidth: Bool) -> Int {
        guard isRegularWidth, width.isFinite, width > 0 else { return 1 }
        if width >= threeColumnMinimum { return 3 }
        if width >= twoColumnMinimum { return 2 }
        return 1
    }
}

private struct CardSpanKey: LayoutValueKey {
    static let defaultValue: Bool = false
}

extension View {
    /// Marks a card that must span every column of the dashboard flow.  Reserved for the few
    /// things that read as a header rather than as one card among many — the freshness banner
    /// and the Home hero.  A no-op in the one-column phone layout.
    func cardSpansAllColumns(_ spans: Bool = true) -> some View {
        layoutValue(key: CardSpanKey.self, value: spans)
    }
}

/// Card flow for the dashboard scaffold: cards drop into the shortest column so one long card
/// cannot leave a column empty, and anything marked `.cardSpansAllColumns()` takes the full
/// width and starts a fresh row.  Only ever instantiated with two or three columns — the phone
/// keeps its `LazyVStack` — but it degrades to a plain stack at one column anyway.
///
/// Layout math is in `CardColumnsLayout` so XCTest can cover balancing, spans, and total height
/// without hosting SwiftUI — the same split `WrappingHStack` uses.
struct CardColumns: Layout {
    var columns: Int
    var spacing: CGFloat = 14
    var columnSpacing: CGFloat = 14

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 0
        return layout(subviews: subviews, containerWidth: width).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = layout(subviews: subviews, containerWidth: bounds.width)
        for index in subviews.indices {
            let frame = result.frames[index]
            subviews[index].place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                proposal: ProposedViewSize(width: frame.width, height: frame.height)
            )
        }
    }

    private func layout(subviews: Subviews, containerWidth: CGFloat) -> CardColumnsLayout.Result {
        let spans = subviews.map { $0[CardSpanKey.self] }
        let columnWidth = CardColumnsLayout.columnWidth(
            containerWidth: containerWidth,
            columns: columns,
            columnSpacing: columnSpacing
        )
        var heights: [CGFloat] = []
        heights.reserveCapacity(subviews.count)
        for index in subviews.indices {
            let full = columns <= 1 || spans[index]
            let proposed = ProposedViewSize(width: full ? containerWidth : columnWidth, height: nil)
            heights.append(subviews[index].sizeThatFits(proposed).height)
        }
        return CardColumnsLayout.place(
            heights: heights,
            spans: spans,
            containerWidth: containerWidth,
            columns: columns,
            spacing: spacing,
            columnSpacing: columnSpacing
        )
    }
}

enum CardColumnsLayout {
    struct Result: Equatable {
        var size: CGSize
        var frames: [CGRect]
    }

    static func columnWidth(containerWidth: CGFloat, columns: Int, columnSpacing: CGFloat) -> CGFloat {
        let count = max(1, columns)
        guard count > 1 else { return max(0, containerWidth) }
        let gutters = CGFloat(count - 1) * columnSpacing
        return max(0, (containerWidth - gutters) / CGFloat(count))
    }

    static func place(
        heights: [CGFloat],
        spans: [Bool],
        containerWidth: CGFloat,
        columns: Int,
        spacing: CGFloat,
        columnSpacing: CGFloat
    ) -> Result {
        precondition(heights.count == spans.count)
        guard !heights.isEmpty else {
            return Result(size: .zero, frames: [])
        }

        let count = max(1, columns)
        let width = columnWidth(containerWidth: containerWidth, columns: count, columnSpacing: columnSpacing)
        var bottoms = [CGFloat](repeating: 0, count: count)
        var frames: [CGRect] = []
        frames.reserveCapacity(heights.count)

        for index in heights.indices {
            let height = heights[index]
            if count == 1 || spans[index] {
                // A spanning card clears every column, then resets them all to its own bottom.
                let y = bottoms.max() ?? 0
                frames.append(CGRect(x: 0, y: y, width: max(0, containerWidth), height: height))
                let next = y + height + spacing
                for column in bottoms.indices {
                    bottoms[column] = next
                }
            } else {
                // Shortest column wins; a near-tie keeps reading order by staying left.
                var target = 0
                for column in 1..<count where bottoms[column] + 0.5 < bottoms[target] {
                    target = column
                }
                let y = bottoms[target]
                frames.append(CGRect(
                    x: CGFloat(target) * (width + columnSpacing),
                    y: y,
                    width: width,
                    height: height
                ))
                bottoms[target] = y + height + spacing
            }
        }

        // Every bottom carries a trailing gap that is not part of the content.
        let total = max(0, (bottoms.max() ?? 0) - spacing)
        return Result(size: CGSize(width: max(0, containerWidth), height: total), frames: frames)
    }
}

/// Metric-tile grid that widens with the card it sits in rather than with the screen.  A phone
/// card and a two-column iPad card both hold two tiles; a full-width card on a wide Mac window
/// holds four.  Measuring its own width (not the window's) is the point: the same card is
/// narrow in a column and wide when it spans.
struct AppMetricGrid<Content: View>: View {
    /// Narrowest a tile may get before the grid drops a column.
    var minimumTileWidth: CGFloat = 178
    var spacing: CGFloat = 10
    private let content: Content

    init(
        minimumTileWidth: CGFloat = 178,
        spacing: CGFloat = 10,
        @ViewBuilder content: () -> Content
    ) {
        self.minimumTileWidth = minimumTileWidth
        self.spacing = spacing
        self.content = content()
    }

    @State private var width: CGFloat = 0

    var body: some View {
        LazyVGrid(columns: columns, spacing: spacing) {
            content
        }
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.width
        } action: { measured in
            width = measured
        }
    }

    private var columns: [GridItem] {
        // `GridItem(.flexible())` with no explicit spacing, exactly as every one of these grids
        // was written before — so a phone renders the identical two-up tile row it did.
        Array(repeating: GridItem(.flexible()), count: AppMetricGridColumns.count(
            width: width,
            minimumTileWidth: minimumTileWidth,
            spacing: spacing
        ))
    }
}

enum AppMetricGridColumns {
    /// Two is both the floor and the pre-measurement answer, so a phone renders exactly what it
    /// rendered before this grid existed and never reflows after the first layout pass.
    static let minimum = 2
    static let maximum = 4

    static func count(width: CGFloat, minimumTileWidth: CGFloat, spacing: CGFloat) -> Int {
        guard width.isFinite, width > 0, minimumTileWidth > 0 else { return minimum }
        let fits = Int(((width + spacing) / (minimumTileWidth + spacing)).rounded(.down))
        return min(maximum, max(minimum, fits))
    }
}

struct CommandButton: View {
    let title: String
    let systemImage: String
    let isBusy: Bool
    let isDisabled: Bool
    let role: ButtonRole?
    let prominent: Bool
    let action: () -> Void

    init(
        _ title: String,
        systemImage: String,
        isBusy: Bool,
        isDisabled: Bool = false,
        role: ButtonRole? = nil,
        prominent: Bool = false,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.systemImage = systemImage
        self.isBusy = isBusy
        self.isDisabled = isDisabled
        self.role = role
        self.prominent = prominent
        self.action = action
    }

    @ViewBuilder
    var body: some View {
        if prominent {
            button
                .buttonStyle(.borderedProminent)
        } else {
            button
                .buttonStyle(.bordered)
        }
    }

    private var button: some View {
        Button(role: role, action: action) {
            HStack(spacing: 7) {
                if isBusy {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: systemImage)
                }
                Text(title)
                    .fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: 44)
        }
        .disabled(isBusy || isDisabled)
    }
}

// MARK: - Justified paragraph

/// A paragraph set with `NSTextAlignment.justified`: every line but the last stretches to
/// the same right edge, and the last line is left alone (no stretched final row).
///
/// SwiftUI has no justified case — `TextAlignment` is leading/center/trailing only, and
/// `Text` ignores an `NSParagraphStyle` carried on an `AttributedString` — so this is the
/// one place the app drops to UIKit for type.  Used for the login legal block, where a
/// ragged right edge under three equal-width buttons reads as sloppy.
///
/// Sizes itself against the width SwiftUI proposes, scales with Dynamic Type (explicitly,
/// via `UIFontMetrics` — `adjustsFontForContentSizeCategory` on top of an already-scaled
/// font double-scales), and hands VoiceOver the plain string.
struct JustifiedText: UIViewRepresentable {
    private let text: String
    private let font: UIFont
    private let textStyle: UIFont.TextStyle
    private let color: UIColor
    private let lineSpacing: CGFloat

    /// Reading the environment here is what makes SwiftUI re-run `sizeThatFits` when the
    /// user changes text size; the label alone would resize without the layout following.
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(
        _ text: String,
        font: UIFont = AppFont.uiFont(12),
        textStyle: UIFont.TextStyle = .caption1,
        color: UIColor = .secondaryLabel,
        lineSpacing: CGFloat = 1.5
    ) {
        self.text = text
        self.font = font
        self.textStyle = textStyle
        self.color = color
        self.lineSpacing = lineSpacing
    }

    func makeUIView(context: Context) -> UILabel {
        let label = UILabel()
        label.numberOfLines = 0
        label.lineBreakMode = .byWordWrapping
        // SwiftUI owns the width; the label must not argue for a wider intrinsic one.
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        label.setContentHuggingPriority(.required, for: .vertical)
        return label
    }

    func updateUIView(_ label: UILabel, context: Context) {
        label.attributedText = attributed()
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView label: UILabel, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0, width < .greatestFiniteMagnitude else {
            return nil
        }
        // Measure off a throwaway label rather than the live one: `updateUIView` has not
        // necessarily run for this pass yet, so the on-screen label can still be holding the
        // previous string and would measure the wrong height.
        let probe = UILabel()
        probe.numberOfLines = 0
        probe.lineBreakMode = .byWordWrapping
        probe.attributedText = attributed()
        let fitted = probe.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: ceil(fitted.height))
    }

    private func attributed() -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .justified
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.lineSpacing = lineSpacing
        return NSAttributedString(
            string: text,
            attributes: [
                .font: UIFontMetrics(forTextStyle: textStyle).scaledFont(for: font),
                .foregroundColor: color,
                .paragraphStyle: paragraph
            ]
        )
    }
}

/// Shared layout truth for iPad / Mac Catalyst vs iPhone.
enum AppLayout {
    /// Regular horizontal size class AND not a phone.  A Max-class iPhone in landscape can
    /// report `.regular`; those windows keep the compact chrome.
    static func isRegularWidth(_ sizeClass: UserInterfaceSizeClass?) -> Bool {
        sizeClass == .regular && UIDevice.current.userInterfaceIdiom != .phone
    }
}

private enum AppChromeSheet: String, Identifiable {
    case settings
    case notifications

    var id: String { rawValue }
}

/// Bell (leading) and settings gear (trailing) on every tab, including Admin and More.
///
/// The website console puts the inbox and the account control in the header on every
/// screen; this is the native counterpart.  Per-tab trailing items (Scan refresh, Coach
/// options) still appear — the gear is added as an additional trailing item so it stays
/// top-right on every tab.
struct AppChromeModifier: ViewModifier {
    @EnvironmentObject private var store: MobileStore
    @State private var sheet: AppChromeSheet?

    private var unreadCount: Int {
        store.snapshot?.unreadNotificationCount ?? 0
    }

    func body(content: Content) -> some View {
        content
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        sheet = .notifications
                    } label: {
                        Image(systemName: unreadCount > 0 ? "bell.badge.fill" : "bell")
                    }
                    .accessibilityLabel(
                        unreadCount > 0
                            ? "Notifications, \(unreadCount) unread"
                            : "Notifications"
                    )
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        sheet = .settings
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Account and Settings")
                }
            }
            .sheet(item: $sheet) { item in
                switch item {
                case .settings:
                    AccountSettingsView()
                        .adaptiveWideSheet(phoneDetents: [.large])
                case .notifications:
                    NotificationsInboxView()
                        .adaptiveWideSheet(phoneDetents: [.medium, .large])
                }
            }
    }
}

/// Larger sheet on iPad and wide Mac windows so Account & Settings is not a tiny card.
/// Compact (iPhone, narrow Mac window) keeps a standard phone sheet.
struct AdaptiveWideSheet: ViewModifier {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    var phoneDetents: Set<PresentationDetent>

    private var isWide: Bool { AppLayout.isRegularWidth(horizontalSizeClass) }

    func body(content: Content) -> some View {
        if isWide {
            content
                .presentationSizing(.form)
                .frame(minWidth: 560, idealWidth: 640, minHeight: 680, idealHeight: 760)
                .presentationDragIndicator(.visible)
        } else {
            content
                .presentationDetents(phoneDetents)
                .presentationDragIndicator(.visible)
        }
    }
}

extension View {
    func appChrome() -> some View {
        modifier(AppChromeModifier())
    }

    func adaptiveWideSheet(
        phoneDetents: Set<PresentationDetent> = [.large]
    ) -> some View {
        modifier(AdaptiveWideSheet(phoneDetents: phoneDetents))
    }
}

// MARK: - Equity Chart Component

struct EquityChartView: View {
    let points: [EquityCurvePoint]
    var title: String = "Equity Curve"
    var isLive: Bool = true

    @State private var selectedPoint: EquityCurvePoint?

    private var chartColor: Color {
        isLive ? AppPalette.positive : AppPalette.accent
    }

    private var gradientFill: LinearGradient {
        LinearGradient(
            colors: [
                chartColor.opacity(0.35),
                chartColor.opacity(0.0)
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if let selected = selectedPoint {
                    HStack(spacing: 4) {
                        Text(selected.date)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text(AppFormat.money(selected.equity))
                            .font(.caption.weight(.bold).monospacedDigit())
                            .foregroundStyle(chartColor)
                    }
                } else if let last = points.last {
                    Text(AppFormat.money(last.equity))
                        .font(.caption.weight(.bold).monospacedDigit())
                        .foregroundStyle(chartColor)
                }
            }

            if points.isEmpty {
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color(uiColor: .tertiarySystemFill))
                    .frame(height: 120)
                    .overlay {
                        Text("No equity history recorded yet")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
            } else {
                Chart {
                    ForEach(points) { point in
                        AreaMark(
                            x: .value("Date", point.date),
                            y: .value("Equity", point.equity)
                        )
                        .foregroundStyle(gradientFill)
                        .interpolationMethod(.monotone)

                        LineMark(
                            x: .value("Date", point.date),
                            y: .value("Equity", point.equity)
                        )
                        .foregroundStyle(chartColor)
                        .lineStyle(StrokeStyle(lineWidth: 2))
                        .interpolationMethod(.monotone)
                    }

                    if let selected = selectedPoint {
                        RuleMark(x: .value("Date", selected.date))
                            .foregroundStyle(Color.secondary.opacity(0.5))
                            .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))

                        PointMark(
                            x: .value("Date", selected.date),
                            y: .value("Equity", selected.equity)
                        )
                        .foregroundStyle(chartColor)
                        .symbolSize(36)
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 4)) {
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [2, 2]))
                            .foregroundStyle(Color.secondary.opacity(0.2))
                        AxisTick()
                        AxisValueLabel()
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { value in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [2, 2]))
                            .foregroundStyle(Color.secondary.opacity(0.2))
                        AxisTick()
                        if let val = value.as(Double.self) {
                            AxisValueLabel {
                                Text(AppFormat.money(val, compact: true))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .chartOverlay { proxy in
                    GeometryReader { geo in
                        Rectangle()
                            .fill(.clear)
                            .contentShape(Rectangle())
                            .gesture(
                                DragGesture(minimumDistance: 0)
                                    .onChanged { value in
                                        guard let plotFrame = proxy.plotFrame else { return }
                                        let origin = geo[plotFrame].origin
                                        let location = CGPoint(
                                            x: value.location.x - origin.x,
                                            y: value.location.y - origin.y
                                        )
                                        if let date: String = proxy.value(atX: location.x) {
                                            selectedPoint = points.first(where: { $0.date == date }) ?? points.last
                                        }
                                    }
                                    .onEnded { _ in
                                        selectedPoint = nil
                                    }
                            )
                    }
                }
                .frame(height: 140)
            }
        }
    }
}

// MARK: - Account vs same-cash S&P chart

struct BenchmarkCompareChart: View {
    let account: [BenchmarkDollarPoint]
    let shadow: [BenchmarkDollarPoint]
    var accountLabel: String = "Your Account"
    var benchmarkLabel: String = "SPY"

    @State private var selectedDate: String?

    private var selectedAccount: BenchmarkDollarPoint? {
        guard let selectedDate else { return nil }
        return account.first(where: { $0.date == selectedDate }) ?? account.last
    }

    private var selectedShadow: BenchmarkDollarPoint? {
        guard let selectedDate else { return nil }
        return shadow.first(where: { $0.date == selectedDate }) ?? shadow.last
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Account vs \(benchmarkLabel)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if let accountPoint = selectedAccount, let shadowPoint = selectedShadow {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(accountPoint.date)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text("\(accountLabel) \(AppFormat.money(accountPoint.value))")
                            .font(.caption.weight(.bold).monospacedDigit())
                            .foregroundStyle(AppPalette.accent)
                        Text("\(benchmarkLabel) \(AppFormat.money(shadowPoint.value))")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                } else if let lastAccount = account.last, let lastShadow = shadow.last {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("\(accountLabel) \(AppFormat.money(lastAccount.value))")
                            .font(.caption.weight(.bold).monospacedDigit())
                            .foregroundStyle(AppPalette.accent)
                        Text("\(benchmarkLabel) \(AppFormat.money(lastShadow.value))")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if account.count < 2 || shadow.count < 2 {
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color(uiColor: .tertiarySystemFill))
                    .frame(height: 140)
                    .overlay {
                        Text("Not enough overlapping history to draw \(benchmarkLabel) yet")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 12)
                    }
            } else {
                Chart {
                    ForEach(shadow) { point in
                        LineMark(
                            x: .value("Date", point.date),
                            y: .value(benchmarkLabel, point.value)
                        )
                        .foregroundStyle(.secondary)
                        .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
                        .interpolationMethod(.linear)
                    }
                    ForEach(account) { point in
                        LineMark(
                            x: .value("Date", point.date),
                            y: .value(accountLabel, point.value)
                        )
                        .foregroundStyle(AppPalette.accent)
                        .lineStyle(StrokeStyle(lineWidth: 2))
                        .interpolationMethod(.linear)
                    }
                    if let selected = selectedAccount {
                        RuleMark(x: .value("Date", selected.date))
                            .foregroundStyle(Color.secondary.opacity(0.5))
                            .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 4)) {
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [2, 2]))
                            .foregroundStyle(Color.secondary.opacity(0.2))
                        AxisTick()
                        AxisValueLabel()
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { value in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [2, 2]))
                            .foregroundStyle(Color.secondary.opacity(0.2))
                        AxisTick()
                        if let val = value.as(Double.self) {
                            AxisValueLabel {
                                Text(AppFormat.money(val, compact: true))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .chartOverlay { proxy in
                    GeometryReader { geo in
                        Rectangle()
                            .fill(.clear)
                            .contentShape(Rectangle())
                            .gesture(
                                DragGesture(minimumDistance: 0)
                                    .onChanged { value in
                                        guard let plotFrame = proxy.plotFrame else { return }
                                        let origin = geo[plotFrame].origin
                                        let location = CGPoint(
                                            x: value.location.x - origin.x,
                                            y: value.location.y - origin.y
                                        )
                                        if let date: String = proxy.value(atX: location.x) {
                                            selectedDate = date
                                        }
                                    }
                                    .onEnded { _ in
                                        selectedDate = nil
                                    }
                            )
                    }
                }
                .frame(height: 140)
            }
        }
    }
}
