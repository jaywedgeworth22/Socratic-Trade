import AuthenticationServices
import SwiftUI

/// Native login — visual parity with `app/login/page.tsx`:
/// candlestick wordmark, accent-dot value bullets, Google (accent) / GitHub (outline) / Apple.
struct LoginView: View {
    @Environment(\.colorScheme) private var colorScheme
    @EnvironmentObject private var store: MobileStore

    /// Keep in sync with `LOGIN_VALUE_BULLETS` in `app/login/page.tsx`.
    private static let valueBullets = [
        "Configure framework and guardrails",
        "Review and approve proposals",
        "Track positions, orders, and performance",
        "Run, pause, and approve from your phone"
    ]

    var body: some View {
        ZStack {
            // Web login: plain `bg-bg` (#eef1f5 light / #0a0a0a dark) — no accent mesh.
            loginBackground
                .ignoresSafeArea()

            GeometryReader { proxy in
                ScrollView {
                    VStack(spacing: 24) {
                        brand
                        valueCard
                        signIn
                        privacyNote
                    }
                    // 352 (not 400): ASAuthorizationAppleIDButton hard-caps its width at
                    // 375pt, so a wider column left Sign in with Apple visibly narrower than
                    // the Google/GitHub buttons.  Keep the column under that cap and all three
                    // render at identical width.
                    .frame(maxWidth: Self.contentWidth)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 48)
                    // minHeight + .center is what vertically centres the column on anything
                    // taller than it needs — an iPad Air or a tall Mac Catalyst window, where
                    // a top-pinned 352pt column otherwise sits marooned against the top edge.
                    // It still scrolls normally once the content is taller than the screen
                    // (large Dynamic Type on a small phone), because minHeight only ever
                    // grows the frame.
                    .frame(maxWidth: .infinity, minHeight: proxy.size.height, alignment: .center)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
    }

    private var loginBackground: Color {
        // Match globals.css --bg light/dark
        Color(uiColor: UIColor { traits in
            if traits.userInterfaceStyle == .dark {
                return UIColor(red: 0x0a / 255, green: 0x0a / 255, blue: 0x0a / 255, alpha: 1)
            }
            return UIColor(red: 0xee / 255, green: 0xf1 / 255, blue: 0xf5 / 255, alpha: 1)
        })
    }

    private var brand: some View {
        // Login treats the wordmark as the page headline, so it scales to the content
        // column rather than sitting at top-bar size (the console top bar still uses
        // the fixed-height form).  Owner 2026-08-20: 20% smaller than the full-bleed
        // hero it replaced — at full column width it crowded the value card and read as
        // a splash screen rather than a headline.
        CandleWordmarkView(fillsWidth: true)
            .frame(maxWidth: Self.brandWidth)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
    }

    private var valueCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Self.valueBullets, id: \.self) { text in
                HStack(alignment: .top, spacing: 10) {
                    Circle()
                        .fill(AppPalette.accent)
                        .frame(width: 6, height: 6)
                        .padding(.top, 6)
                    Text(text)
                        .font(.appSubheadline)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Color(uiColor: UIColor { traits in
                if traits.userInterfaceStyle == .dark {
                    // --surface dark ≈ rgba(22,22,22,0.78)
                    return UIColor(red: 22 / 255, green: 22 / 255, blue: 22 / 255, alpha: 0.78)
                }
                // --surface light ≈ white glass
                return UIColor(white: 1, alpha: 0.65)
            }),
            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.primary.opacity(colorScheme == .dark ? 0.08 : 0.06), lineWidth: 1)
        }
    }

    private var signIn: some View {
        VStack(spacing: 12) {
            if let error = store.error {
                HStack(alignment: .top, spacing: 9) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(AppPalette.warning)
                    Text(error)
                        .font(.appSubheadline)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(13)
                .background(AppPalette.warning.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }

            // Order matches web login: Google → GitHub → Apple.
            providerButton(
                title: "Sign in with Google",
                ink: googleInk,
                action: { beginWebAuth(provider: "google") }
            ) {
                GoogleMark()
            }
            .accessibilityHint("Opens the secure Socratic Trade sign-in page")

            providerButton(
                title: "Sign in with GitHub",
                ink: googleInk,
                action: { beginWebAuth(provider: "github") }
            ) {
                GitHubMark()
            }
            .accessibilityHint("Opens the secure Socratic Trade sign-in page")

            // A CUSTOM Sign in with Apple button, not SignInWithAppleButton.  The HIG
            // permits this and names this exact motivation — "you may want to align logos
            // across multiple sign-in buttons" — and the native control cannot be aligned:
            // its fill, font and metrics are the system's, and its documentation forbids
            // restyling it beyond the corner radius.  Every attribute the HIG pins is
            // honoured: the title is one of the three permitted strings, the background is
            // white (black in dark mode), the logo and title are both the same pure black
            // or white, the title is 43% of the button height, and the button is no smaller
            // than the other two.
            providerButton(
                title: "Sign in with Apple",
                ink: appleInk,
                action: beginAppleSignIn
            ) {
                AppleMark()
            }
        }
    }

    /// Shared sign-in button metrics — every provider button renders at the same
    /// width, height, and corner radius; only the branding inside differs.
    private static let contentWidth: CGFloat = 352
    /// Owner 2026-08-20: the login wordmark at 80% of the content column.
    private static let brandWidth: CGFloat = (352 - 16) * 0.8
    /// How far the lock glyph hangs left of the content column, into its gutter.
    private static let lockOutdent: CGFloat = 12
    private static let lockGap: CGFloat = 6
    // 44, not 50.  Apple's HIG pins a CUSTOM Sign in with Apple button's title to 43% of
    // the button height and works the example as "19 points for a 44-point tall button" —
    // so 44/19 is the one pairing that is compliant by construction rather than by luck.
    // 44 is also Apple's own recommended default height and the iOS minimum tap target.
    private static let buttonHeight: CGFloat = 44
    private static let buttonTitleSize: CGFloat = 19
    private static let buttonRadius: CGFloat = 10
    /// Fixed logo column, so all three marks sit on one optical axis and all three titles
    /// start at the same x down the stack.
    private static let logoSlot: CGFloat = 20
    /// Google's documented iOS padding for a custom Sign in with Google button: 16pt before
    /// the logo, 12pt after it.  Adopted for all three rows — following Google's spec is
    /// also what makes the stack line up.
    private static let logoLeading: CGFloat = 16
    private static let logoGap: CGFloat = 12

    /// ONE button for all three providers.  The provider supplies a mark, a title, and an
    /// ink colour; nothing else varies — same height, radius, fill, border, type ramp and
    /// logo column.  That uniformity is the whole point, and it is also what each
    /// provider's own guidelines happen to ask for:
    ///
    ///  * **Google** mandates one of three themes for a custom button.  This is their Light
    ///    theme verbatim — fill #FFFFFF, 1px inside stroke #747775, title #1F1F1F — and
    ///    their Dark theme (#131314 / #8E918F / #E3E3E3) in dark mode.  The teal button this
    ///    replaces broke an explicit "Don't: put the standard color Google 'G' icon on a
    ///    colored background other than light, dark, or neutral".  Google also asks that
    ///    their button be "at least as prominently" displayed as other providers and of
    ///    "approximately the same size and similar visual weight" — which a uniform row is.
    ///  * **Apple** permits a custom button and names this exact motivation: "you may want
    ///    to align logos across multiple sign-in buttons".  Its hard constraints are that
    ///    the background stay black or white and the logo and title both be black or both
    ///    white — hence `ink` is pure black/white on that row only, while Google keeps its
    ///    specified #1F1F1F.  The difference is imperceptible and each row obeys its own
    ///    provider.  Apple explicitly allows the bezel stroke and a non-system title font.
    ///  * **GitHub** imposes no button rules at all.  Its only constraint is on the mark:
    ///    the Invertocat, unmodified, in black or white.
    private func providerButton<Mark: View>(
        title: String,
        ink: Color,
        action: @escaping () -> Void,
        @ViewBuilder mark: () -> Mark
    ) -> some View {
        Button(action: action) {
            HStack(spacing: Self.logoGap) {
                mark()
                    .frame(width: Self.logoSlot, height: Self.logoSlot)
                Text(title)
                    .font(.custom(AppFont.regular, size: Self.buttonTitleSize, relativeTo: .body).weight(.medium))
                    .foregroundStyle(ink)
                Spacer(minLength: 0)
            }
            .padding(.leading, Self.logoLeading)
            .padding(.trailing, Self.logoLeading)
            .frame(maxWidth: .infinity)
            .frame(height: Self.buttonHeight)
            .background(providerFill)
            .contentShape(RoundedRectangle(cornerRadius: Self.buttonRadius, style: .continuous))
        }
        // Without this the system's own bordered style paints a second, larger rounded
        // rectangle BEHIND this one.  That was the "strange sides" — a grey ghost box
        // around Google and GitHub that Apple's UIKit-hosted button never had, which is
        // why only two of the three looked wrong.
        .buttonStyle(.plain)
        .disabled(store.isSigningIn)
    }

    /// Google's custom-button colour table, used for every row.
    @ViewBuilder
    private var providerFill: some View {
        RoundedRectangle(cornerRadius: Self.buttonRadius, style: .continuous)
            .fill(Color(uiColor: UIColor { traits in
                traits.userInterfaceStyle == .dark
                    ? UIColor(red: 0x13 / 255, green: 0x13 / 255, blue: 0x14 / 255, alpha: 1)
                    : UIColor.white
            }))
            .overlay {
                RoundedRectangle(cornerRadius: Self.buttonRadius, style: .continuous)
                    .strokeBorder(
                        Color(uiColor: UIColor { traits in
                            traits.userInterfaceStyle == .dark
                                ? UIColor(red: 0x8E / 255, green: 0x91 / 255, blue: 0x8F / 255, alpha: 1)
                                : UIColor(red: 0x74 / 255, green: 0x77 / 255, blue: 0x75 / 255, alpha: 1)
                        }),
                        lineWidth: 1
                    )
            }
    }

    /// Google's specified title ink.  Deliberately NOT reused for the Apple row.
    private var googleInk: Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0xE3 / 255, green: 0xE3 / 255, blue: 0xE3 / 255, alpha: 1)
                : UIColor(red: 0x1F / 255, green: 0x1F / 255, blue: 0x1F / 255, alpha: 1)
        })
    }

    /// Apple's rule is absolute: within the button, logo and title are both black or both
    /// white, never a custom colour.
    private var appleInk: Color {
        colorScheme == .dark ? .white : .black
    }

    /// One paragraph, not three.  It used to be a centred `Label` plus a centred `Text`,
    /// which produced two ragged blocks with a gap between them and a pennant-shaped last
    /// line on each — five different right edges inside 350pt.  Owner 2026-08-20: one
    /// justified block sitting to the right of the lock, every line landing on the same
    /// right edge (the final line excepted, which justification leaves alone).
    ///
    /// Two spaces between sentences, per the fleet copy rule.
    /// Written as explicit concatenation, NOT a `"""` literal with `\` continuations.
    /// The continuation form shipped this string with NINE-space runs baked into it — the
    /// stripped indentation of each continued line survived — and justification then
    /// stretched those runs into visible rivers mid-sentence.
    ///
    /// Two spaces between sentences, per the fleet copy rule.
    private static let legalNotice =
        "The app stores only your session.  "
        + "Broker/provider keys stay with your account at SocraticTrade.com.  "
        + "By signing in, you agree to the Terms and Privacy Policy linked below.  "
        + "AI generated proposals, behaviors, and actions are not guaranteed though "
        + "strategic framework is customizable and defined by each user.  "
        + "Site and app do not provide financial or investment advice and were made for "
        + "educational, experimental, and/or informational use only."

    private var privacyNote: some View {
        VStack(spacing: 10) {
            HStack(alignment: .top, spacing: Self.lockGap) {
                Image(systemName: "lock.fill")
                    .font(.appCaption)
                    .foregroundStyle(.secondary)
                    // Optical, not layout: drops the glyph onto the first line's x-height
                    // instead of its ascender line.
                    .padding(.top, 1.5)
                    .accessibilityHidden(true)

                JustifiedText(Self.legalNotice, font: AppFont.uiFont(10))
            }
            // The lock hangs into the column's 24pt gutter rather than eating paragraph
            // width — owner: "the lock can move left to give more space".  The paragraph
            // itself keeps essentially the whole content column, which is what makes the
            // justified right edge land under the buttons above it.
            .padding(.leading, -Self.lockOutdent)

            HStack(spacing: 16) {
                Link("Terms", destination: store.client.baseURL.appending(path: "/terms-and-conditions"))
                Link("Privacy", destination: store.client.baseURL.appending(path: "/privacy-policy"))
            }
            .font(.system(size: 10))
            // A Link is a Button underneath, so it picked up the same bordered system style
            // that was ghosting the provider buttons — two grey pills under a paragraph of
            // legal text.  These are text links.
            .buttonStyle(.plain)
            .foregroundStyle(AppPalette.accent)
        }
        .padding(.top, 4)
    }

    /// Drives the same ASAuthorization flow the native button used to drive, so the
    /// credential handling below is untouched — only what starts it changed.  `configure`
    /// and `complete` are still the request builder and the result handler; they are now
    /// called by an ASAuthorizationController this view owns instead of by the system
    /// button.
    private func beginAppleSignIn() {
        let request = ASAuthorizationAppleIDProvider().createRequest()
        configure(request)
        let controller = ASAuthorizationController(authorizationRequests: [request])
        AppleSignInCoordinator.shared.start(controller: controller, completion: complete)
    }

    private func configure(_ request: ASAuthorizationAppleIDRequest) {
        store.dismissError()
        request.requestedScopes = [.fullName, .email]
    }

    private func complete(_ result: Result<ASAuthorization, Error>) {
        switch result {
        case .success(let authorization):
            handleAuthorization(authorization)
        case .failure(let error):
            guard let message = AppleSignInFailure.message(for: error) else { return }
            store.error = message
        }
    }

    private func handleAuthorization(_ authorization: ASAuthorization) {
        guard
            let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
            let tokenData = credential.identityToken,
            let identityToken = String(data: tokenData, encoding: .utf8)
        else {
            store.error = "Apple did not return an identity token.  Try again."
            return
        }

        let name: String? = {
            guard let fullName = credential.fullName else { return nil }
            let components = [fullName.givenName, fullName.familyName].compactMap { $0 }
            return components.isEmpty ? nil : components.joined(separator: " ")
        }()

        Task {
            await store.loginWithApple(identityToken: identityToken, name: name)
        }
    }

    private func beginWebAuth(provider: String) {
        store.dismissError()
        guard let verifier = WebAuthCodeVerifier.make() else {
            store.error = "Could not securely start web sign-in.  Try again."
            return
        }
        guard var callbackComponents = URLComponents(url: store.client.baseURL.appending(path: "/api/mobile/auth-redirect"), resolvingAgainstBaseURL: false) else {
            store.error = "Could not prepare web sign-in."
            return
        }
        callbackComponents.queryItems = [
            URLQueryItem(name: "code_challenge", value: verifier.challenge)
        ]
        // /api/mobile/auth-start initiates OAuth on a plain GET.  Auth.js v5 only
        // initiates on POST, so the old /api/auth/signin/<provider> entry dead-ended
        // on /access-denied?error=Configuration (middleware translates it for older
        // builds; new builds go straight to the initiator).
        guard let callbackURL = callbackComponents.url,
              var components = URLComponents(url: store.client.baseURL.appending(path: "/api/mobile/auth-start"), resolvingAgainstBaseURL: false) else {
            store.error = "Could not prepare web sign-in."
            return
        }
        components.queryItems = [
            URLQueryItem(name: "provider", value: provider),
            URLQueryItem(name: "callbackUrl", value: callbackURL.absoluteString)
        ]
        guard let url = components.url else {
            store.error = "Could not start web sign-in."
            return
        }

        let contextProvider = WebAuthContextProvider()
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "socratictrade") { callbackURL, error in
            if let error {
                if let authError = error as? ASWebAuthenticationSessionError, authError.code == .canceledLogin {
                    return
                }
                Task { @MainActor in store.error = error.localizedDescription }
                return
            }
            guard
                let callbackURL,
                let code = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "code" })?.value,
                !code.isEmpty
            else {
                Task { @MainActor in store.error = "Invalid callback URL from web sign-in." }
                return
            }
            Task { @MainActor in
                await store.loginWithWebAuthCode(code, verifier: verifier.value)
            }
        }
        session.presentationContextProvider = contextProvider
        session.prefersEphemeralWebBrowserSession = false
        WebAuthSessionManager.shared.start(session: session, provider: contextProvider)
    }
}

// MARK: - Provider marks (match web button icons)

private struct GoogleMark: View {
    var body: some View {
        // Multicolor "G" ring — Google brand colors from app/login/page.tsx GoogleIcon.
        Canvas { context, size in
            let blue = Color(red: 0x42 / 255, green: 0x85 / 255, blue: 0xF4 / 255)
            let green = Color(red: 0x34 / 255, green: 0xA8 / 255, blue: 0x53 / 255)
            let yellow = Color(red: 0xFB / 255, green: 0xBC / 255, blue: 0x05 / 255)
            let red = Color(red: 0xEA / 255, green: 0x43 / 255, blue: 0x35 / 255)
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let radius = size.width * 0.42
            let lw = size.width * 0.18

            func arc(_ start: Double, _ end: Double, _ color: Color) {
                var p = Path()
                p.addArc(
                    center: center,
                    radius: radius,
                    startAngle: .degrees(start),
                    endAngle: .degrees(end),
                    clockwise: false
                )
                context.stroke(p, with: .color(color), style: StrokeStyle(lineWidth: lw, lineCap: .butt))
            }
            arc(-35, 20, blue)
            arc(20, 120, green)
            arc(120, 220, yellow)
            arc(220, 325, red)
            context.fill(
                Path(CGRect(
                    x: size.width * 0.48,
                    y: size.height * 0.42,
                    width: size.width * 0.42,
                    height: size.width * 0.16
                )),
                with: .color(blue)
            )
        }
        .accessibilityHidden(true)
    }
}

/// GitHub's official Invertocat, shipped as a vector PDF in Assets.xcassets from
/// brand.github.com/GitHub_Logos.zip.
///
/// It replaces an SF Symbol chevron-slash, which was not a GitHub mark at all — it read as
/// a generic "code" glyph and left the row looking unfinished.  GitHub's brand rules are
/// short but real: use a permitted logo (the Invertocat, never Mona or any Octodex
/// mascot), do not modify it, and show it only in black or white.  Rendered as a template
/// so it resolves to exactly those two — black on the light button, white on the dark one.
///
/// The artwork is 98x96, NOT square.  `.scaledToFit` inside the square logo slot is what
/// keeps GitHub's "don't compress, distort, skew, stretch" satisfied.
private struct GitHubMark: View {
    var body: some View {
        // Optical, not nominal.  The Invertocat's artwork runs edge to edge in its 98x96
        // box while the Google G and the Apple logo both carry internal padding, so at a
        // shared 20pt slot GitHub read as the biggest of the three.
        Image("GitHubMark")
            .renderable(inset: 1)
            .accessibilityHidden(true)
    }
}

/// Apple's own glyph, at an optical size that matches the other two marks rather than a
/// nominal one — the Apple logo reads noticeably larger than the G or the Invertocat at
/// the same box height.  The HIG explicitly allows this: logos ship in several sizes "so
/// you can match logo sizes in all the sign-up buttons you display", and you may inset the
/// logo "if you need to horizontally align the Apple logo with other authentication logos".
private struct AppleMark: View {
    var body: some View {
        Image(systemName: "apple.logo")
            .font(.system(size: 22))
            .accessibilityHidden(true)
    }
}

private extension Image {
    /// Template-rendered, aspect-preserved, filling the shared logo slot.
    func renderable(inset: CGFloat = 0) -> some View {
        self.renderingMode(.template)
            .resizable()
            .scaledToFit()
            .padding(inset)
    }
}

/// Plain language for an Apple sign-in failure.
///
/// `error.localizedDescription` on an `ASAuthorizationError` is framework-speak — the real
/// string is "The operation couldn't be completed. (com.apple.AuthenticationServices.
/// AuthorizationError error 1000.)", which this app put straight in front of the owner.
/// It says nothing about what happened and nothing about what to do, and it is exactly the
/// register `UserFacingCopyTests` exists to keep out of the UI.
///
/// Returns nil for the cases that are not failures at all — a cancel, or a request the
/// person simply backed out of — so the screen stays quiet instead of accusing them of
/// something.
enum AppleSignInFailure {
    static func message(for error: Error) -> String? {
        guard let authorizationError = error as? ASAuthorizationError else {
            return "Apple could not complete the sign-in.  Try again."
        }
        switch authorizationError.code {
        case .canceled:
            return nil
        case .notHandled, .unknown:
            // What a Mac or a device with no signed-in Apple Account reports, and by far
            // the most likely one an owner will actually hit.
            return "Apple could not complete the sign-in.  Check that you are signed in to "
                + "your Apple Account on this device, then try again."
        case .failed:
            return "Apple could not verify that sign-in.  Try again."
        case .invalidResponse:
            return "Apple returned a sign-in this app could not read.  Try again."
        case .credentialImport, .credentialExport:
            return "Apple could not complete the sign-in.  Try again."
        case .matchedExcludedCredential:
            return "That Apple Account is already linked.  Sign in with Google or GitHub instead."
        @unknown default:
            return "Apple could not complete the sign-in.  Try again."
        }
    }
}

/// Holds the ASAuthorizationController and its delegate for the life of the request.
///
/// Necessary because `ASAuthorizationController` keeps only WEAK references to its delegate
/// and presentation context provider: a coordinator created inside `beginAppleSignIn` would
/// be deallocated the moment that function returned, and the sheet would never appear.  The
/// native `SignInWithAppleButton` hid this because SwiftUI owned the lifetime for us.  Same
/// reason `WebAuthSessionManager` below exists for the web flow.
@MainActor
private final class AppleSignInCoordinator: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    static let shared = AppleSignInCoordinator()

    private var completion: ((Result<ASAuthorization, Error>) -> Void)?
    private var controller: ASAuthorizationController?

    func start(
        controller: ASAuthorizationController,
        completion: @escaping (Result<ASAuthorization, Error>) -> Void
    ) {
        self.completion = completion
        self.controller = controller
        controller.delegate = self
        controller.presentationContextProvider = self
        controller.performRequests()
    }

    private func finish(_ result: Result<ASAuthorization, Error>) {
        let completion = self.completion
        self.completion = nil
        self.controller = nil
        completion?(result)
    }

    nonisolated func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        Task { @MainActor in finish(.success(authorization)) }
    }

    nonisolated func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        Task { @MainActor in finish(.failure(error)) }
    }

    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated { WebAuthContextProvider.keyAnchor() }
    }
}

@MainActor
private final class WebAuthSessionManager {
    static let shared = WebAuthSessionManager()
    private var session: ASWebAuthenticationSession?
    private var contextProvider: WebAuthContextProvider?

    func start(session: ASWebAuthenticationSession, provider: WebAuthContextProvider) {
        self.session = session
        self.contextProvider = provider
        session.start()
    }
}

private final class WebAuthContextProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    /// Shared by the web flow and the Apple flow — both need the same window, and having
    /// one copy means a scene-lookup fix can only ever be made in one place.
    static func keyAnchor() -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        if let keyWindow = scenes.flatMap(\.windows).first(where: \.isKeyWindow) {
            return keyWindow
        }
        if let scene = scenes.first {
            // UIWindow.init() is deprecated in iOS 26 — always anchor to a window scene.
            return scene.windows.first ?? UIWindow(windowScene: scene)
        }
        // Running app should always have a scene; avoid deprecated UIWindow().
        preconditionFailure("No UIWindowScene available for auth presentation")
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        Self.keyAnchor()
    }
}

#if DEBUG
#Preview("Login") {
    LoginView()
        .environmentObject(
            MobileStore(client: MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!))
        )
}
#endif
