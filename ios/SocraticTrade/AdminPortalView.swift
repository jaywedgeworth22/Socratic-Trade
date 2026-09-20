import SwiftUI
import WebKit

/// Native Admin tab: operator destinations as a first-class list, each page rendered in a
/// fenced WKWebView of that `/admin/...` URL.
///
/// The website admin shell has its own "Back to Console" link and a Next.js client router.
/// A full-page load of `/console` is already cancelled by the navigation fence; SPA
/// `history.pushState` is not, and that is what used to paint the whole website inside this
/// view.  Native chrome (sidebar / list) replaces the web rail, injected CSS hides the web
/// header, and both the fence and a script bridge route console returns back to the native
/// Home tab.
struct AdminPortalView: View {
    var onBackToConsole: () -> Void = {}

    @EnvironmentObject private var store: MobileStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    /// Optional so it matches SwiftUI `List(selection: Binding<Value?>)`.  Writes ignore
    /// nil (a sidebar deselect) so the pane never blanks.
    @State private var selectedPage: AdminPortalPage? = .overview
    @State private var sessionExpired = false
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var portalGeneration = 0

    private var isRegularWidth: Bool { AppLayout.isRegularWidth(horizontalSizeClass) }

    var body: some View {
        Group {
            if store.snapshot?.currentUser?.isAdmin != true {
                notAdmin
            } else if isRegularWidth {
                wideLayout
            } else {
                compactLayout
            }
        }
        .navigationTitle("Admin Portal")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: selectedPage) { _, _ in
            sessionExpired = false
            loadError = nil
            isLoading = true
        }
    }

    private var notAdmin: some View {
        ContentUnavailableView(
            "Admin Portal",
            systemImage: "lock.fill",
            description: Text("This screen is only available to operators with admin access.")
        )
    }

    private var wideLayout: some View {
        HStack(spacing: 0) {
            List(
                AdminPortalPage.allCases,
                id: \.self,
                selection: Binding(
                    get: { selectedPage },
                    set: { if let page = $0 { selectedPage = page } }
                )
            ) { page in
                Label(page.title, systemImage: page.systemImage)
                    .tag(Optional(page))
            }
            .listStyle(.sidebar)
            .frame(minWidth: 220, idealWidth: 260, maxWidth: 300)
            Divider()
            portalPane(for: selectedPage ?? .overview)
        }
        .background(AppPalette.background)
    }

    private var compactLayout: some View {
        List(AdminPortalPage.allCases) { page in
            NavigationLink {
                portalPane(for: page)
                    .navigationTitle(page.title)
                    .navigationBarTitleDisplayMode(.inline)
                    .appChrome()
            } label: {
                Label(page.title, systemImage: page.systemImage)
            }
        }
        .listStyle(.insetGrouped)
    }

    @ViewBuilder
    private func portalPane(for page: AdminPortalPage) -> some View {
        ZStack {
            if sessionExpired {
                VStack(spacing: 14) {
                    Image(systemName: "person.crop.circle.badge.exclamationmark")
                        .font(.appLargeTitle)
                        .foregroundStyle(AppPalette.warning)
                    Text("Session Expired")
                        .font(.appHeadline)
                    Text("The web session for the admin portal has expired.  Sign in again from the app's login screen, then reopen the portal.")
                        .font(.appSubheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button("Back to Home") { onBackToConsole() }
                        .buttonStyle(.borderedProminent)
                        .tint(AppPalette.accent)
                }
                .padding(28)
            } else {
                AdminPortalWebView(
                    pageURL: page.pageURL,
                    onSessionExpired: {
                        sessionExpired = true
                        isLoading = false
                    },
                    onFinished: {
                        isLoading = false
                        loadError = nil
                    },
                    onFailed: { message in
                        isLoading = false
                        loadError = message
                    },
                    onBackToConsole: onBackToConsole
                )
                .id("\(page.rawValue)-\(portalGeneration)")
                .opacity(isLoading || loadError != nil ? 0 : 1)
                .ignoresSafeArea(edges: .bottom)

                if let loadError {
                    VStack(spacing: 14) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.appLargeTitle)
                            .foregroundStyle(AppPalette.warning)
                        Text("Admin Portal Unavailable")
                            .font(.appHeadline)
                        Text(loadError)
                            .font(.appSubheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                        Button("Retry") { reloadPortal() }
                            .buttonStyle(.borderedProminent)
                            .tint(AppPalette.accent)
                    }
                    .padding(28)
                } else if isLoading {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("Loading Admin Portal")
                            .font(.appSubheadline)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AppPalette.background)
    }

    private func reloadPortal() {
        loadError = nil
        isLoading = true
        portalGeneration += 1
    }
}

/// One destination in the website admin rail (`app/admin/layout.tsx` NAV_ITEMS).
/// Titles are Title Case per fleet copy; the website's "Data catalog" is corrected here.
enum AdminPortalPage: String, CaseIterable, Identifiable, Hashable {
    case overview
    case connections
    case llmUsage
    case ragCoverage
    case enrichmentCoverage
    case dataCatalog
    case operations
    case factorBacktest
    case serverStats
    case backupStatus
    case chatTranscript

    var id: String { rawValue }

    var title: String {
        switch self {
        case .overview: return "Overview"
        case .connections: return "API Connections"
        case .llmUsage: return "LLM Usage & Cost"
        case .ragCoverage: return "RAG Coverage"
        case .enrichmentCoverage: return "Enrichment Coverage"
        case .dataCatalog: return "Data Catalog"
        case .operations: return "Operations"
        case .factorBacktest: return "Factor Backtest"
        case .serverStats: return "Server Stats"
        case .backupStatus: return "Backup Status"
        case .chatTranscript: return "Chat Transcript"
        }
    }

    var systemImage: String {
        switch self {
        case .overview: return "square.grid.2x2"
        case .connections: return "antenna.radiowaves.left.and.right"
        case .llmUsage: return "brain"
        case .ragCoverage: return "cylinder"
        case .enrichmentCoverage: return "square.stack.3d.up"
        case .dataCatalog: return "list.bullet.rectangle"
        case .operations: return "slider.horizontal.3"
        case .factorBacktest: return "chart.bar"
        case .serverStats: return "cpu"
        case .backupStatus: return "archivebox"
        case .chatTranscript: return "text.bubble"
        }
    }

    var path: String {
        switch self {
        case .overview: return "/admin"
        case .connections: return "/admin/connections"
        case .llmUsage: return "/admin/llm-usage"
        case .ragCoverage: return "/admin/rag-coverage"
        case .enrichmentCoverage: return "/admin/enrichment-coverage"
        case .dataCatalog: return "/admin/data-catalog"
        case .operations: return "/admin/operations"
        case .factorBacktest: return "/admin/backtest-ic"
        case .serverStats: return "/admin/server"
        case .backupStatus: return "/admin/backups"
        case .chatTranscript: return "/admin/transcript"
        }
    }

    var pageURL: URL {
        MobileAPIClient.productionBaseURL.appending(path: path)
    }
}

// Internal (not private) so the unit suite can pin the navigation fence.
struct AdminPortalWebView: UIViewRepresentable {
    static let portalURL = MobileAPIClient.productionBaseURL.appending(path: "/admin")
    static let allowedHost = MobileAPIClient.productionBaseURL.host!
    static let nativeMessageName = "socraticNative"

    var pageURL: URL
    let onSessionExpired: () -> Void
    var onFinished: () -> Void = {}
    var onFailed: (String) -> Void = { _ in }
    var onBackToConsole: () -> Void = {}

    func makeCoordinator() -> Coordinator {
        Coordinator(
            onSessionExpired: onSessionExpired,
            onFinished: onFinished,
            onFailed: onFailed,
            onBackToConsole: onBackToConsole
        )
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Ephemeral store: the session cookie is copied in fresh on every open, so persisting
        // it to disk buys nothing and would let the admin session outlive a native sign-out.
        configuration.websiteDataStore = .nonPersistent()
        let userController = configuration.userContentController
        userController.add(context.coordinator, name: Self.nativeMessageName)
        userController.addUserScript(WKUserScript(
            source: Self.bridgeScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        userController.addUserScript(WKUserScript(
            source: Self.chromeHideScript,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        context.coordinator.webView = webView
        context.coordinator.requestedURL = pageURL

        // Copy the native session cookies (the app talks to the API over URLSession.shared,
        // which persists into HTTPCookieStorage.shared) into the web view before first load.
        // Never wait forever on setCookie — a hung callback left the sheet blank.
        let cookieStore = configuration.websiteDataStore.httpCookieStore
        let sessionCookies = (HTTPCookieStorage.shared.cookies ?? []).filter { cookie in
            cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).hasSuffix(Self.allowedHost)
        }
        let group = DispatchGroup()
        for cookie in sessionCookies {
            group.enter()
            cookieStore.setCookie(cookie) { group.leave() }
        }
        var didStartLoad = false
        let startLoad = {
            guard !didStartLoad else { return }
            didStartLoad = true
            webView.load(URLRequest(url: pageURL))
        }
        group.notify(queue: .main, execute: startLoad)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: startLoad)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.onSessionExpired = onSessionExpired
        context.coordinator.onFinished = onFinished
        context.coordinator.onFailed = onFailed
        context.coordinator.onBackToConsole = onBackToConsole
        context.coordinator.webView = webView
        if context.coordinator.requestedURL?.path != pageURL.path {
            context.coordinator.requestedURL = pageURL
            webView.load(URLRequest(url: pageURL))
        }
    }

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: nativeMessageName)
    }

    /// Intercepts SPA navigations and "Back to Console" clicks that never become a full
    /// WKNavigation (Next.js client routing).
    static let bridgeScript = """
    (function() {
      function post(payload) {
        try { window.webkit.messageHandlers.socraticNative.postMessage(payload); } catch (e) {}
      }
      function isConsolePath(path) {
        return path === '/console' || path.indexOf('/console/') === 0 || path === '/';
      }
      function check() {
        var path = location.pathname || '';
        if (isConsolePath(path)) {
          post({ type: 'backToConsole', href: location.href });
        }
      }
      var push = history.pushState;
      var replace = history.replaceState;
      history.pushState = function() { push.apply(this, arguments); check(); };
      history.replaceState = function() { replace.apply(this, arguments); check(); };
      window.addEventListener('popstate', check);
      document.addEventListener('click', function(e) {
        var a = e.target && e.target.closest ? e.target.closest('a') : null;
        if (!a) return;
        var href = a.getAttribute('href') || '';
        if (href === '/console' || href.indexOf('/console') === 0) {
          e.preventDefault();
          e.stopPropagation();
          post({ type: 'backToConsole', href: href });
        }
      }, true);
    })();
    """

    /// Hide the website admin header/rail — native list + app chrome replace them, and the
    /// web "Back to Console" control is what used to load the full site in this view.
    static let chromeHideScript = """
    (function() {
      var style = document.createElement('style');
      style.textContent = [
        'header.sticky { display: none !important; }',
        'aside[aria-label="Admin navigation"] { display: none !important; }',
        '.con-scrim { display: none !important; }',
        'a[href="/console"] { display: none !important; }'
      ].join('');
      (document.head || document.documentElement).appendChild(style);
    })();
    """

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var onSessionExpired: () -> Void
        var onFinished: () -> Void
        var onFailed: (String) -> Void
        var onBackToConsole: () -> Void
        var requestedURL: URL?
        weak var webView: WKWebView?

        init(
            onSessionExpired: @escaping () -> Void,
            onFinished: @escaping () -> Void,
            onFailed: @escaping (String) -> Void,
            onBackToConsole: @escaping () -> Void
        ) {
            self.onSessionExpired = onSessionExpired
            self.onFinished = onFinished
            self.onFailed = onFailed
            self.onBackToConsole = onBackToConsole
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            // about:blank and friends appear during initial setup — harmless, allow.
            if url.scheme == "about" {
                decisionHandler(.allow)
                return
            }
            let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
            if isMainFrame, Self.isConsoleReturn(url) {
                // Full navigation to the website console: leave the native Admin tab.
                onBackToConsole()
                decisionHandler(.cancel)
                return
            }
            guard Self.isAllowed(url, isMainFrame: isMainFrame) else {
                decisionHandler(.cancel)
                return
            }
            if isMainFrame, url.path == "/login" || url.path.hasPrefix("/login/") {
                // The portal bounced to sign-in: the copied session is no longer valid.
                onSessionExpired()
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            onFinished()
            if let url = webView.url, Self.isConsoleReturn(url) {
                resetToRequestedPage()
                onBackToConsole()
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code == NSURLErrorCancelled { return }
            onFailed(error.localizedDescription)
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            if (error as NSError).code == NSURLErrorCancelled { return }
            onFailed(error.localizedDescription)
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == AdminPortalWebView.nativeMessageName else { return }
            let type = Self.messageType(message.body)
            guard type == "backToConsole" else { return }
            DispatchQueue.main.async { [weak self] in
                self?.resetToRequestedPage()
                self?.onBackToConsole()
            }
        }

        private func resetToRequestedPage() {
            guard let url = requestedURL else { return }
            webView?.load(URLRequest(url: url))
        }

        /// Main-frame: https + socratictrade.com + /admin (or the session-expiry bounce).
        /// Subframes / assets: any same-host path so `/_next` and `/api/*` can load.
        static func isAllowed(_ url: URL, isMainFrame: Bool = true) -> Bool {
            guard url.scheme == "https", url.host == AdminPortalWebView.allowedHost else { return false }
            if !isMainFrame { return true }
            let path = url.path
            if path == "/admin" || path.hasPrefix("/admin/") { return true }
            if path == "/login" || path.hasPrefix("/login/") { return true }
            if path.hasPrefix("/api/auth") || path.hasPrefix("/api/admin") { return true }
            if path.hasPrefix("/_next") { return true }
            return false
        }

        /// Paths that mean "leave Admin and return to the native console tabs".
        static func isConsoleReturn(_ url: URL) -> Bool {
            guard url.scheme == "https", url.host == AdminPortalWebView.allowedHost else { return false }
            let path = url.path
            if path == "/console" || path.hasPrefix("/console/") { return true }
            if path == "/" || path.isEmpty { return true }
            return false
        }

        static func messageType(_ body: Any) -> String? {
            if let dict = body as? [String: Any], let type = dict["type"] as? String {
                return type
            }
            return nil
        }
    }
}
