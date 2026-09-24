import Foundation

/// One of the five Activity screens.  Query `?tab=` on `/console/activity` selects this.
/// Path-only `/console/activity` stays `.tab(.activity)` so older contract rows keep passing.
enum ActivitySection: String, Equatable, CaseIterable, Identifiable {
    case alerts
    case notifications
    case runs
    case fills
    case audit

    var id: String { rawValue }

    var title: String {
        switch self {
        case .alerts: return "Alerts Center"
        case .notifications: return "Notifications"
        case .runs: return "Strategy Runs"
        case .fills: return "Order Fills"
        case .audit: return "Audit Log"
        }
    }

    var systemImage: String {
        switch self {
        case .alerts: return "bell.badge"
        case .notifications: return "bell"
        case .runs: return "arrow.triangle.2.circlepath"
        case .fills: return "tray.full"
        case .audit: return "list.bullet.rectangle"
        }
    }
}

/// Where an incoming link lands inside the app.
enum DeepLinkDestination: Equatable {
    case tab(AppTab)
    /// The Proposals tab, scrolled to and highlighting one proposal.
    case proposal(id: String)
    /// The Assets tab, scrolled to one ticker (orders / watchlist query).
    case symbol(String)
    /// Activity, opened on a specific section (`?tab=`).
    case activity(ActivitySection)

    /// The tab that must be selected to show this destination.
    var tab: AppTab {
        switch self {
        case .tab(let tab): return tab
        case .proposal: return .proposals
        case .symbol: return .markets
        case .activity: return .activity
        }
    }

    var proposalId: String? {
        if case .proposal(let id) = self { return id }
        return nil
    }

    var focusedSymbol: String? {
        if case .symbol(let symbol) = self { return symbol }
        return nil
    }

    var activitySection: ActivitySection? {
        if case .activity(let section) = self { return section }
        return nil
    }
}

/// URL → destination mapping for `onOpenURL`.
///
/// Two link families reach this app and they are deliberately NOT treated alike:
/// - `https://socratictrade.com/...` universal links carry CONTENT routes.  The domain claims
///   the app through `applinks:socratictrade.com` (entitlement + the AASA file served from
///   app/.well-known/apple-app-site-association/route.ts), so only paths listed there can
///   arrive this way.
/// - `socratictrade://` stays AUTH-CALLBACK-ONLY.  That scheme is consumed inside
///   `ASWebAuthenticationSession` (LoginView), which never routes through `onOpenURL`, and any
///   app on the device can register the same scheme — so a content route arriving on it is
///   either a mistake or a spoof.  It is rejected here rather than honoured.
///
/// Pure and total: no I/O, no app state, every unrecognized input maps to nil.
enum DeepLink {
    /// The one host the app claims.  Subdomains (console./mobile.) and `www.` are not claimed
    /// in the entitlement, so accepting them here would be a lie about what iOS will deliver.
    static let universalLinkHost = MobileAPIClient.productionBaseURL.host!
    /// Reserved for the OAuth callback — never a content route.  See above.
    static let authCallbackScheme = "socratictrade"

    private static let maximumProposalIdLength = 64

    static func destination(for url: URL) -> DeepLinkDestination? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        // https only: `http` is never a universal link, and honouring it would let a
        // downgraded link drive the app.
        guard components.scheme?.lowercased() == "https" else { return nil }
        guard components.host?.lowercased() == universalLinkHost else { return nil }

        let segments = components.percentEncodedPath
            .split(separator: "/", omittingEmptySubsequences: true)
            .map(String.init)
        guard segments.count >= 2, segments[0].lowercased() == "console" else { return nil }

        switch segments[1].lowercased() {
        case "approvals":
            if segments.count == 2 {
                let queryId = components.queryItems?.first(where: { $0.name.lowercased() == "proposal" })?.value
                if let id = normalizedProposalId(queryId) {
                    return .proposal(id: id)
                }
                return .tab(.proposals)
            }
            if segments.count == 3 {
                // A malformed id still belongs on the Proposals tab — landing on the list is
                // better than dropping the link.
                if let id = normalizedProposalId(segments[2].removingPercentEncoding ?? segments[2]) {
                    return .proposal(id: id)
                }
                return .tab(.proposals)
            }
            return nil
        case "orders", "watchlist":
            // Holdings, orders, and watchlist live on the Assets tab.
            // A `?symbol=` query still lands here; path-only stays `.tab(.markets)` so
            // the APNs contract rows that only assert the tab keep passing.
            guard segments.count == 2 else { return nil }
            if let symbol = normalizedSymbol(
                components.queryItems?.first(where: { $0.name.lowercased() == "symbol" })?.value
            ) {
                return .symbol(symbol)
            }
            return .tab(.markets)
        case "activity":
            guard segments.count == 2 else { return nil }
            if let raw = components.queryItems?.first(where: { $0.name.lowercased() == "tab" })?.value?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased(),
               !raw.isEmpty
            {
                switch raw {
                case "alerts":
                    return .activity(.alerts)
                case "notifications":
                    return .activity(.notifications)
                case "runs":
                    return .activity(.runs)
                case "fills":
                    return .activity(.fills)
                case "audit", "all":
                    return .activity(.audit)
                default:
                    return .tab(.activity)
                }
            }
            return .tab(.activity)
        case "assistant", "coach":
            return segments.count == 2 ? .tab(.coach) : nil
        case "scan":
            return segments.count == 2 ? .tab(.scan) : nil
        case "guardrails":
            return segments.count == 2 ? .tab(.guardrails) : nil
        case "results":
            return segments.count == 2 ? .tab(.results) : nil
        default:
            return nil
        }
    }

    /// Accepts only ids that could plausibly be a proposal id (the server mints UUIDs).
    private static func normalizedProposalId(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        guard trimmed.count <= maximumProposalIdLength else { return nil }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")
        guard trimmed.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { return nil }
        return trimmed
    }

    /// Uppercases a ticker and accepts the same charset the website parser uses.
    private static func normalizedSymbol(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        let upper = trimmed.uppercased()
        guard upper.count <= 10 else { return nil }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-")
        guard upper.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { return nil }
        return upper
    }
}

/// Website pages the phone cannot edit (broker connect on Connections).
///
/// Universe lives on the in-app Guardrails tab (`DeepLink` → `.tab(.guardrails)`).
/// `/console/strategy` is not where indices or always-include symbols are added.
///
/// Connections is intentionally absent from `DeepLink.destination(for:)` and from the AASA
/// file (`app/.well-known/apple-app-site-association/route.ts`).  Claiming it would swallow
/// the tap back into the app and land nowhere.  `openURL` therefore opens Safari.
enum ConsoleHandoff {
    static let connections = MobileAPIClient.productionBaseURL.appending(path: "/console/connections")

    /// True when this URL is a Safari-only console page, not an in-app universal link.
    static func isSafariOnly(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https" else { return false }
        guard url.host?.lowercased() == DeepLink.universalLinkHost else { return false }
        let segments = url.path
            .split(separator: "/", omittingEmptySubsequences: true)
            .map { $0.lowercased() }
        guard segments.count == 2, segments[0] == "console" else { return false }
        switch segments[1] {
        case "connections":
            return true
        default:
            return false
        }
    }
}
