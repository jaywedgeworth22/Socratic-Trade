import Foundation
import UIKit
import UserNotifications

/// Which APNs gateway a device token belongs to.
///
/// This is not cosmetic.  Device tokens are environment-scoped: a token minted while the app
/// was signed for the sandbox gateway is answered `400 BadDeviceToken` by
/// `api.push.apple.com`, and a production token is rejected the same way by
/// `api.sandbox.push.apple.com`.  The single auth key works against both endpoints, so the
/// ONLY thing that decides delivery is which endpoint the server picks — which means the
/// device has to state the truth rather than let the server guess.
enum APNSEnvironment: String, Equatable, Sendable {
    /// `api.sandbox.push.apple.com` — builds signed with a development profile (Xcode runs).
    case sandbox
    /// `api.push.apple.com` — App Store AND TestFlight.  TestFlight is production.
    case production

    /// The environment this running binary's tokens belong to.
    ///
    /// Resolved from the `aps-environment` entitlement inside the embedded provisioning
    /// profile, because that is what the app was actually SIGNED with.  `#if DEBUG` would be
    /// a lie here: it is a compile-time flag about optimization and assertions, unrelated to
    /// signing.  A Release build installed from Xcode with a development profile still gets
    /// sandbox tokens, and — the failure this guards against — a TestFlight build is a Release
    /// build re-signed by Apple with a DISTRIBUTION profile, so it is `production`.  Deciding
    /// from `#if DEBUG` would mark every TestFlight install "sandbox" and every push would
    /// silently 400 forever.
    static let current: APNSEnvironment = {
        #if targetEnvironment(simulator)
        let isSimulator = true
        #else
        let isSimulator = false
        #endif
        let entitlement = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision")
            .flatMap { try? Data(contentsOf: $0) }
            .flatMap { apsEnvironment(inProvisioningProfile: $0) }
        return resolve(entitlementValue: entitlement, isSimulator: isSimulator)
    }()

    /// Pure decision table behind `current`.
    ///
    /// The default case matters: on a real device with no readable profile the overwhelmingly
    /// likely cause is an App Store / TestFlight install, both of which are production.
    /// Guessing `sandbox` there would reproduce exactly the silent-failure bug this type
    /// exists to prevent, so an unknown device build is treated as production.
    static func resolve(entitlementValue: String?, isSimulator: Bool) -> APNSEnvironment {
        // The simulator never receives real APNs tokens; report sandbox rather than claim a
        // production registration the server would try to push to.
        if isSimulator { return .sandbox }
        switch entitlementValue?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "development":
            return .sandbox
        case "production":
            return .production
        default:
            return .production
        }
    }

    /// Pulls `Entitlements.aps-environment` out of an `embedded.mobileprovision`.
    ///
    /// The file is a CMS (PKCS#7) envelope wrapping an XML plist, so the plist is located by
    /// its literal delimiters rather than by decoding the signature — the same approach every
    /// mainstream push SDK uses.  Returns nil for anything that is not a profile carrying that
    /// key; callers decide what an unknown value means.
    static func apsEnvironment(inProvisioningProfile data: Data) -> String? {
        guard
            let opening = data.range(of: Data("<plist".utf8)),
            let closing = data.range(
                of: Data("</plist>".utf8),
                options: [],
                in: opening.upperBound..<data.endIndex
            )
        else {
            return nil
        }
        let plistData = Data(data[opening.lowerBound..<closing.upperBound])
        guard
            let plist = try? PropertyListSerialization.propertyList(
                from: plistData,
                options: [],
                format: nil
            ) as? [String: Any],
            let entitlements = plist["Entitlements"] as? [String: Any]
        else {
            return nil
        }
        return entitlements["aps-environment"] as? String
    }
}

/// Body of `POST /api/mobile/push/register`.
///
/// The token is hex because that is what APNs' `:path` wants (`/3/device/<hex token>`); the
/// raw `Data` from `didRegisterForRemoteNotificationsWithDeviceToken` has no textual form of
/// its own, and `Data.description` famously produces `{length = 32, bytes = ...}` — a string
/// that looks plausible in a log and is useless as a token.
struct PushRegistrationRequest: Equatable {
    let token: String
    let environment: APNSEnvironment
    let bundleId: String?

    init(token: String, environment: APNSEnvironment, bundleId: String?) {
        self.token = token
        self.environment = environment
        let trimmed = bundleId?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.bundleId = (trimmed?.isEmpty == false) ? trimmed : nil
    }

    /// Fails rather than registering an empty token: a blank registration is a row the server
    /// would push to forever and never be able to invalidate.
    init?(deviceToken: Data, environment: APNSEnvironment, bundleId: String?) {
        guard !deviceToken.isEmpty else { return nil }
        self.init(
            token: Self.hexEncoded(deviceToken),
            environment: environment,
            bundleId: bundleId
        )
    }

    static func hexEncoded(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    var jsonBody: [String: String] {
        var body = ["token": token, "environment": environment.rawValue]
        if let bundleId {
            body["bundleId"] = bundleId
        }
        return body
    }
}

/// Reads the deep-link target out of an APNs payload.
///
/// Deliberately only EXTRACTS — validation and routing stay in `DeepLink`, so a notification
/// and a universal link cannot drift into two different ideas of where a URL leads.
enum PushPayload {
    /// Keys accepted for the link, in priority order, at the payload root and under `data`.
    static let linkKeys = ["url", "deepLink", "link"]

    static func deepLinkURL(in userInfo: [AnyHashable: Any]) -> URL? {
        guard let raw = linkString(in: userInfo) else { return nil }
        return URL(string: raw)
    }

    /// The destination a tap should land on, or nil when the payload names none the app can
    /// route.  `DeepLink` is the sole authority on what a URL means.
    static func destination(in userInfo: [AnyHashable: Any]) -> DeepLinkDestination? {
        guard let url = deepLinkURL(in: userInfo) else { return nil }
        return DeepLink.destination(for: url)
    }

    private static func linkString(in userInfo: [AnyHashable: Any]) -> String? {
        if let found = firstLink(in: userInfo) { return found }
        guard let nested = userInfo["data"] as? [AnyHashable: Any] else { return nil }
        return firstLink(in: nested)
    }

    private static func firstLink(in object: [AnyHashable: Any]) -> String? {
        for key in linkKeys {
            guard
                let value = object[key] as? String,
                !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else {
                continue
            }
            return value.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return nil
    }
}

/// What the app can honestly say about push right now.
///
/// There is no "probably fine" state.  If the owner denied the prompt, or APNs refused the
/// registration, or the server rejected the token, the settings screen says so — an app that
/// silently pretends alerts are on is worse than one with no alerts.
enum PushAlertState: Equatable {
    case unknown
    case notRequested
    case denied
    /// Authorized, but no device token has come back from APNs yet.
    case awaitingToken
    case registered(environment: APNSEnvironment)
    case failed(String)

    var summary: String {
        switch self {
        case .unknown:
            return "Checking alert permission…"
        case .notRequested:
            return "Not enabled yet.  Turn alerts on to hear about proposals and fills when the app is closed."
        case .denied:
            return "Blocked in iOS Settings.  Alerts stay off until notifications are allowed for Socratic Trade."
        case .awaitingToken:
            return "Allowed.  Finishing setup…"
        case .registered:
            return "Alerts on."
        case .failed(let message):
            return Self.failureSummary(message)
        }
    }

    /// Settings copy stays ordinary app language.  Apple / token errors stay out of the footer.
    static func failureSummary(_ message: String) -> String {
        let lower = message.lowercased()
        let looksLikeAppleJargon =
            lower.contains("apns")
            || lower.contains("aps-environment")
            || lower.contains("device token")
            || lower.contains("sandbox")
            || lower.contains("production")
            || lower.contains("empty")
            || lower.contains("baddevicetoken")
        if looksLikeAppleJargon || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Alerts are off.  Try again, or check Notifications in iOS Settings."
        }
        return "Alerts are off.  Try again."
    }

    /// True only when a token is registered with the server.  Anything else must not be
    /// presented as working.
    var isWorking: Bool {
        if case .registered = self { return true }
        return false
    }
}

/// Owns everything push: authorization, APNs registration, server registration, foreground
/// presentation, and tap routing.
///
/// A singleton because `UIApplicationDelegate` — the only place APNs hands back a device
/// token — is created by UIKit and cannot be handed a SwiftUI-owned object.
@MainActor
final class PushNotificationCoordinator: NSObject, ObservableObject {
    static let shared = PushNotificationCoordinator()

    @Published private(set) var state: PushAlertState = .unknown

    /// Set by the app so a tapped notification lands in the SAME pending-destination slot
    /// `onOpenURL` uses.  There is one router; this is a hand-off into it, not a second one.
    var route: ((DeepLinkDestination) -> Void)?
    /// The app already holds a live SSE stream that refreshes what is on screen.  See
    /// `foregroundPresentationOptions`.
    var isLiveStreamConnected: () -> Bool = { false }

    private let client: MobileAPIClient
    private var registeredToken: String?
    /// Guards the one-time prompt so re-entering Proposals does not re-ask.
    private var hasRequestedAuthorizationThisLaunch = false

    init(client: MobileAPIClient = MobileAPIClient(baseURL: MobileAPIClient.configuredBaseURL)) {
        self.client = client
        super.init()
    }

    // MARK: - Foreground presentation

    /// The app's SSE stream reloads the snapshot on every server event, so while the stream is
    /// up a banner restates something the screen already shows — noise.  It is still delivered
    /// to Notification Center and still counts toward the badge, so nothing is lost.
    ///
    /// When the stream is DOWN the screen is not live, and the banner is the only way the
    /// owner learns something happened — so it is shown.  "Suppress in foreground" without
    /// that carve-out would hide real news precisely when the app has stopped receiving it.
    /// `nonisolated` because it is a pure decision over its argument — it touches no actor
    /// state, and the delegate callback that needs it is nonisolated too.
    nonisolated static func foregroundPresentationOptions(
        isLiveStreamConnected: Bool
    ) -> UNNotificationPresentationOptions {
        isLiveStreamConnected ? [.list, .badge] : [.banner, .list, .badge, .sound]
    }

    // MARK: - Lifecycle

    func configure(route: @escaping (DeepLinkDestination) -> Void, isLiveStreamConnected: @escaping () -> Bool) {
        self.route = route
        self.isLiveStreamConnected = isLiveStreamConnected
    }

    func refreshState() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        applySystemAuthorization(settings.authorizationStatus)
    }

    /// Re-asserts an EXISTING authorization on launch without prompting.  APNs can rotate a
    /// device token (restore from backup, reinstall), and the only way to learn the new one is
    /// to ask every launch — Apple's own guidance.
    func registerIfAlreadyAuthorized() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        applySystemAuthorization(settings.authorizationStatus)
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            UIApplication.shared.registerForRemoteNotifications()
        default:
            break
        }
    }

    /// The first-run prompt.  Called when the owner opens Proposals while signed in — the
    /// screen whose whole purpose is "things are waiting for your judgment", which is exactly
    /// what a push would be about.  Deliberately NOT at cold start: a permission sheet before
    /// sign-in asks the owner to decide about alerts from an app they have not seen yet.
    func requestAuthorizationOnAlertScreen() async {
        guard !hasRequestedAuthorizationThisLaunch else { return }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard settings.authorizationStatus == .notDetermined else {
            applySystemAuthorization(settings.authorizationStatus)
            return
        }
        hasRequestedAuthorizationThisLaunch = true
        await requestAuthorization()
    }

    /// The manual path from Account & Settings.
    func requestAuthorization() async {
        hasRequestedAuthorizationThisLaunch = true
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            if granted {
                state = .awaitingToken
                UIApplication.shared.registerForRemoteNotifications()
            } else {
                state = .denied
            }
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    // MARK: - APNs callbacks

    func didRegister(deviceToken: Data) {
        guard
            let registration = PushRegistrationRequest(
                deviceToken: deviceToken,
                environment: APNSEnvironment.current,
                bundleId: Bundle.main.bundleIdentifier
            )
        else {
            state = .failed("empty device token")
            return
        }
        Task { await upload(registration) }
    }

    func didFailToRegister(_ error: Error) {
        registeredToken = nil
        state = .failed(error.localizedDescription)
    }

    private func upload(_ registration: PushRegistrationRequest) async {
        do {
            try await client.registerPushToken(registration)
            registeredToken = registration.token
            state = .registered(environment: registration.environment)
        } catch {
            registeredToken = nil
            state = .failed(error.localizedDescription)
        }
    }

    // MARK: - Sign-out

    /// Stops this device receiving the signed-out user's alerts.
    ///
    /// Must run BEFORE the session cookies are cleared, or the delete goes out unauthenticated.
    /// Two independent stops, because one of them can fail: the server drops the row, and the
    /// system token is invalidated so any push the server still attempts comes back
    /// `410 Unregistered` and is cleaned up on that side.
    func signOutAndForgetToken() async {
        let token = registeredToken
        registeredToken = nil
        state = .notRequested
        if let token {
            try? await client.unregisterPushToken(token)
        }
        UIApplication.shared.unregisterForRemoteNotifications()
    }

    /// Session lost without an explicit sign-out (expired cookie).  No network call is
    /// possible, so only the local belief is dropped.
    func forgetTokenLocally() {
        registeredToken = nil
        if state.isWorking {
            state = .awaitingToken
        }
    }

    private func applySystemAuthorization(_ status: UNAuthorizationStatus) {
        switch status {
        case .notDetermined:
            state = .notRequested
        case .denied:
            state = .denied
        case .authorized, .provisional, .ephemeral:
            // A live registration and a recorded failure both say more than "authorized" —
            // neither may be overwritten with the weaker truth.
            switch state {
            case .registered, .failed:
                break
            default:
                state = .awaitingToken
            }
        @unknown default:
            state = .unknown
        }
    }
}

extension PushNotificationCoordinator: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        Task { @MainActor in
            completionHandler(
                Self.foregroundPresentationOptions(isLiveStreamConnected: self.isLiveStreamConnected())
            )
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        Task { @MainActor in
            defer { completionHandler() }
            guard
                response.actionIdentifier == UNNotificationDefaultActionIdentifier,
                let destination = PushPayload.destination(in: userInfo)
            else {
                return
            }
            self.route?(destination)
        }
    }
}

/// UIKit's half of push.  A SwiftUI `App` has no hook for the APNs token callbacks, so this
/// exists purely to forward them (and to install the notification delegate early enough that a
/// tap which launched the app from cold start is still delivered).
@MainActor
final class PushAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Apple requires this be set before `application(_:didFinishLaunchingWithOptions:)`
        // returns, otherwise a launch-from-notification tap is dropped.
        UNUserNotificationCenter.current().delegate = PushNotificationCoordinator.shared
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        PushNotificationCoordinator.shared.didRegister(deviceToken: deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        PushNotificationCoordinator.shared.didFailToRegister(error)
    }
}
