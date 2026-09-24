import SwiftUI

@main
struct SocraticTradeApp: App {
    /// UIKit hands back the APNs device token nowhere else — see `PushAppDelegate`.
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
    @StateObject private var store = SocraticTradeApp.makeStore()

    /// DEBUG App Store shots: `-ASCScreenshots` / `ASC_SCREENSHOTS=1` / UserDefaults `ascScreenshots`.
    static var isScreenshotMode: Bool {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-ASCScreenshots") { return true }
        if ProcessInfo.processInfo.environment["ASC_SCREENSHOTS"] == "1" { return true }
        if UserDefaults.standard.bool(forKey: "ascScreenshots") { return true }
        return false
        #else
        return false
        #endif
    }

    private static func makeStore() -> MobileStore {
        #if DEBUG
        if isScreenshotMode { return MobileStore.preview }
        #endif
        return MobileStore(client: MobileAPIClient(baseURL: MobileAPIClient.productionBaseURL))
    }

    init() {
        SentryTelemetry.start()
        // Nav bars and tab items are drawn by UIKit and never see SwiftUI's .font, so the
        // Lato swap has to be installed here or the chrome stays on SF while content moves.
        AppAppearance.applyFonts()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .environmentObject(PushNotificationCoordinator.shared)
                // Owner 2026-08-10: light is the product default (no theme
                // picker on this app yet — do not follow OS dark by default).
                .preferredColorScheme(.light)
                // Default face for any Text that doesn't name a style of its own. The
                // .app* twins in AppTypography.swift cover the ones that do.
                .environment(\.font, .appBody)
                .appUpdatePrompt()
        }
    }
}

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var store: MobileStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The splash's own floor, independent of the network. Without it a warm launch (cached
    /// session, snapshot back in ~200ms) shows the wordmark for a single frame, which reads as
    /// a flicker rather than a brand moment. With it, a fast launch still gets the full
    /// animation and a slow one is never held back — the splash leaves when BOTH are done.
    @State private var minimumSplashElapsed = false

    private var showSplash: Bool { !store.hasInitialized || !minimumSplashElapsed }

    /// Set by `onOpenURL` AND by a tapped push notification, consumed (and cleared) by the tab
    /// shell.  Held here rather than inside the shell so a link that arrives before sign-in
    /// still routes: the shell exists in this ZStack the whole time and applies the
    /// destination as soon as it is set, so the right screen is already showing when
    /// authentication completes.
    @State private var pendingDeepLink: DeepLinkDestination?

    var body: some View {
        ZStack {
            // BUILT conditionally, not held at opacity 0.
            //
            // Both screens used to sit here permanently with an opacity switch.  That is
            // invisible on iOS, but not on Mac Catalyst: a TabView's bar and a
            // NavigationStack's title are promoted into the WINDOW's own chrome, which an
            // opacity modifier inside the scene never reaches.  So the Mac login screen
            // shipped with a live "Home · Proposals · Assets · Activity · More" bar across
            // the top of it and "Home" in the title bar, for an app you were not signed in
            // to.  It also meant the login wordmark's TimelineView kept ticking behind the
            // whole app for the entire session.
            //
            // The deep-link guarantee the opacity switch was protecting still holds:
            // `pendingDeepLink` lives in THIS view, not in the shell, so a link that
            // arrives before sign-in survives, and the shell applies it from `onAppear`
            // the moment it is created.
            if store.hasInitialized && !store.isAuthenticated {
                LoginView()
                    .transition(.opacity)
            }

            if store.isAuthenticated {
                MobileControlView(pendingDeepLink: $pendingDeepLink)
                    .transition(.opacity)
                    .storeTransientAlerts()
                    .fullScreenCover(isPresented: Binding(
                        get: { store.needsAppConsent },
                        set: { _ in }
                    )) {
                        LegalConsentSheet()
                            .environmentObject(store)
                    }
            }

            if showSplash {
                LaunchStateView()
                    // Slides up and off, uncovering the app behind it — the native counterpart
                    // of the web console's MobileBrandRow, which holds the same candlestick
                    // wordmark at the top of the screen and then slides it away. Reduced motion
                    // gets a plain cross-fade instead of travel.
                    .transition(
                        reduceMotion
                            ? .opacity
                            : .move(edge: .top).combined(with: .opacity)
                    )
                    // Above the app content, so the reveal is the splash leaving rather than
                    // the content fading up through it.
                    .zIndex(1)
            }
        }
        .animation(.easeInOut(duration: reduceMotion ? 0.2 : 0.55), value: showSplash)
        .animation(.easeInOut(duration: 0.2), value: store.isAuthenticated)
        .task {
            await bootstrap()
        }
        .task {
            try? await Task.sleep(for: .seconds(1.2))
            minimumSplashElapsed = true
        }
        .onChange(of: scenePhase) { _, phase in
            handleScenePhase(phase)
        }
        // The ONE router: `DeepLink.destination(for:)` decides what a URL means, and the
        // answer lands in `pendingDeepLink`.  A tapped notification is routed through the
        // same two lines below (`configure(route:)`), never through a parser of its own.
        // Universal links only reach here for paths the AASA file claims; anything else
        // (including the auth-callback scheme) maps to nil and is ignored.
        .onOpenURL { url in
            guard let destination = DeepLink.destination(for: url) else { return }
            pendingDeepLink = destination
        }
    }

    private func bootstrap() async {
        PushNotificationCoordinator.shared.configure(
            route: { destination in pendingDeepLink = destination },
            isLiveStreamConnected: { store.isStreamConnected }
        )
        if SocraticTradeApp.isScreenshotMode { return }
        guard !store.hasInitialized else { return }
        await store.load()
        if store.isAuthenticated {
            store.startEvents()
            // Re-asserts an existing grant only — this never prompts.  APNs can hand out a
            // new device token after a restore or reinstall, and asking each launch is the
            // only way to notice.
            await PushNotificationCoordinator.shared.registerIfAlreadyAuthorized()
        }
    }

    private func handleScenePhase(_ phase: ScenePhase) {
        if SocraticTradeApp.isScreenshotMode { return }
        switch phase {
        case .active where store.isAuthenticated:
            store.startEvents()
            Task { await store.load() }
        case .background:
            store.stopEvents()
        default:
            break
        }
    }
}

/// Launch screen: the candlestick "SOCRATIC TRADE" wordmark sitting at the top of the screen,
/// ticking, until the app is ready — then the whole thing slides up and away (see the
/// transition on the caller).
///
/// Replaces the previous icon-in-a-rounded-square + spinner + "Socratic-Trade" placeholder,
/// which shared nothing with the web console's load screen and repeated back the app name the
/// user had just tapped.
private struct LaunchStateView: View {
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .top) {
                AppPalette.background.ignoresSafeArea()

                CandleWordmarkView(height: wordmarkHeight(forWidth: geo.size.width))
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.top, 10)
            }
        }
        .ignoresSafeArea(edges: .bottom)
        // One announcement for the whole screen; CandleWordmarkView already labels itself, and
        // a spinner-less splash otherwise says nothing at all to VoiceOver.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Socratic Trade")
        .accessibilityAddTraits(.isHeader)
    }

    /// Same formula as the web console's MobileBrandRow (`app/console/components/shell.tsx`):
    /// the wordmark spans 88% of the width, height falls out of the aspect ratio, clamped so it
    /// neither disappears on a small phone nor bloats on an iPad. Keeping the two in sync is
    /// what makes the native splash and the web load screen read as the same product.
    private func wordmarkHeight(forWidth width: CGFloat) -> CGFloat {
        let aspect: CGFloat = CandleWordmarkModel.shared.wm.ar
        // Stacked wordmark has a smaller aspect ratio (e.g., ~4.0 instead of ~13.1).
        // A height of 16-34 is too small for a stacked logo.
        // We allow it to be larger (e.g. 40 to 80).
        return max(40, min(80, (width * 0.88) / aspect))
    }
}

/// Blocking first-use clickwrap, compiled in this file so XcodeGen / pbxproj
/// does not need a new source entry.  Accepting the current version dismisses
/// it until Terms / data-pool versions bump.  There is no decline path.
struct LegalConsentSheet: View {
    @EnvironmentObject private var store: MobileStore

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("Not investment advice.  You set authority.")
                    .font(.appHeadline)

                Text("Socratic Trade is software you configure.  Using the app requires accepting the Terms and Privacy Policy, and contributing general market data — quotes, fundamentals, history, and news — to a shared pool.  Personal account data stays private.")
                    .font(.appBody)
                    .foregroundStyle(.secondary)

                Text("You can delete your account yourself in Account & Settings.  Database backups are kept for 7 days.  Fact-level research notes may join a shared research corpus; risk rules and strategy instructions stay private.")
                    .font(.appBody)
                    .foregroundStyle(.secondary)

                HStack(spacing: 16) {
                    Link("Terms", destination: URL(string: "https://socratictrade.com/terms-and-conditions")!)
                    Link("Privacy", destination: URL(string: "https://socratictrade.com/privacy-policy")!)
                }
                .font(.appSubheadline)

                Spacer()

                Button {
                    Task { await store.acceptAppConsent() }
                } label: {
                    Text(store.isAcceptingConsent ? "Saving…" : "Accept & Continue")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.isAcceptingConsent)
            }
            .padding(24)
            .navigationTitle("Terms, Privacy, and Shared Data")
            .navigationBarTitleDisplayMode(.inline)
        }
        .interactiveDismissDisabled()
    }
}
