import Foundation
import Combine
import Sentry

// MARK: - Duplicate command folding
//
// The `/api/mobile` snapshot can legitimately list the same `MobileCommand.id` twice
// (overlapping poll windows, or a paginated fetch that straddles a page boundary).
// Every command lookup folds those duplicates to the same deterministic winner so the
// tracker (`CommandAttemptTracker.reconcile`) and the proposal-card feedback lookup
// (`MobileStore.proposalActionFeedback`) can never disagree about which version of a
// command is current.

extension MobileCommand {
    /// Deterministic fold of two versions of the same command id: the freshest
    /// `updatedAt` wins (ISO8601 timestamps sort lexicographically), an exact timestamp
    /// tie prefers the terminal state, and a full tie keeps the existing value.  The
    /// outcome for a pair is order-independent, so lookups no longer depend on whatever
    /// array order the server happened to send.
    static func foldDuplicate(existing: MobileCommand, incoming: MobileCommand) -> MobileCommand {
        if incoming.updatedAt != existing.updatedAt {
            return incoming.updatedAt > existing.updatedAt ? incoming : existing
        }
        if incoming.isTerminal != existing.isTerminal {
            return incoming.isTerminal ? incoming : existing
        }
        return existing
    }
}

struct CommandAttemptTracker {
    private struct PendingAttempt {
        let fingerprint: String
        let idempotencyKey: String
        var commandID: String?
    }

    struct Resolution: Equatable {
        let operationID: String
        let status: String
        let error: String?
    }

    private var attempts: [String: PendingAttempt] = [:]

    mutating func idempotencyKey(
        operationID: String,
        commandType: String,
        payload: [String: Any]
    ) -> String {
        let object: [String: Any] = ["commandType": commandType, "payload": payload]
        let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let fingerprint = data?.base64EncodedString() ?? "\(commandType):\(operationID)"
        if let pending = attempts[operationID], pending.fingerprint == fingerprint {
            return pending.idempotencyKey
        }
        let key = UUID().uuidString
        attempts[operationID] = PendingAttempt(
            fingerprint: fingerprint,
            idempotencyKey: key,
            commandID: nil
        )
        return key
    }

    mutating func track(_ command: MobileCommand, operationID: String) {
        guard var attempt = attempts[operationID] else { return }
        attempt.commandID = command.id
        attempts[operationID] = attempt
    }

    mutating func reconcile(_ commands: [MobileCommand]) -> [Resolution] {
        // The server can legitimately report the same command id twice (e.g. overlapping
        // poll windows or a paginated fetch that straddles a page boundary), and
        // `Dictionary(uniqueKeysWithValues:)` traps (hard crash) on any duplicate key.
        // Fold duplicates to a single deterministic winner instead: freshest by
        // `updatedAt`, and on an exact timestamp tie the terminal state wins
        // (`MobileCommand.foldDuplicate`).  A collision here means the server sent
        // inconsistent data, so surface it — but only when a pending attempt is actually
        // waiting on that command id, so a server-side duplicate that no local operation
        // is tracking cannot re-report itself on every poll and flood Sentry.
        var commandsByID: [String: MobileCommand] = [:]
        var duplicateIDsOnTrackedAttempts = Set<String>()
        for command in commands {
            if let existing = commandsByID[command.id] {
                commandsByID[command.id] = MobileCommand.foldDuplicate(existing: existing, incoming: command)
                if attempts.values.contains(where: { $0.commandID == command.id }) {
                    duplicateIDsOnTrackedAttempts.insert(command.id)
                }
            } else {
                commandsByID[command.id] = command
            }
        }
        if !duplicateIDsOnTrackedAttempts.isEmpty {
            SentrySDK.capture(
                message: "MobileStore.reconcile: dropped \(duplicateIDsOnTrackedAttempts.count) duplicate command id(s) from server response"
            ) { scope in
                scope.setLevel(.warning)
            }
        }
        var resolutions: [Resolution] = []
        for (operationID, attempt) in Array(attempts) {
            guard
                let commandID = attempt.commandID,
                let command = commandsByID[commandID],
                command.isTerminal
            else {
                continue
            }
            attempts.removeValue(forKey: operationID)
            resolutions.append(
                Resolution(operationID: operationID, status: command.status, error: command.error)
            )
        }
        return resolutions
    }

    mutating func release(operationID: String) {
        attempts.removeValue(forKey: operationID)
    }

    mutating func removeAll() {
        attempts = [:]
    }
}

/// Per-proposal approve/reject feedback — mirrors PWA `proposalActionFeedback`.
enum ProposalActionFeedback: Equatable {
    case sending(action: ProposalAction)
    case pending(action: ProposalAction, status: String)
    case failed(action: ProposalAction, message: String)
    case succeeded(action: ProposalAction)
    case placementSettled(action: ProposalAction, status: String, reasons: [String]?)

    enum ProposalAction: String, Equatable {
        case approve
        case reject
    }

    var action: ProposalAction {
        switch self {
        case .sending(let action), .pending(let action, _), .failed(let action, _), .succeeded(let action),
             .placementSettled(let action, _, _):
            return action
        }
    }

    var isInFlight: Bool {
        switch self {
        case .sending, .pending: return true
        case .failed, .succeeded, .placementSettled: return false
        }
    }

    var isSettledSuccess: Bool {
        switch self {
        case .succeeded:
            return true
        case .placementSettled(let action, let status, _):
            guard action == .approve else { return true }
            return status == "filled" || status == "placed" || status == "paper"
        default:
            return false
        }
    }
}

@MainActor
final class MobileStore: ObservableObject {
    @Published private(set) var snapshot: MobileSnapshot?
    @Published var error: String?
    @Published var successMessage: String?
    @Published private(set) var isAuthenticated = false
    @Published private(set) var hasInitialized = false
    @Published private(set) var isRefreshing = false
    @Published private(set) var lastUpdatedAt: Date?
    @Published private(set) var isStreamConnected = false
    @Published private(set) var busyOperations: Set<String> = []
    /// Account the user asked to switch to.  Stays set until a snapshot
    /// reports that id as active, so the Use row does not go idle while the
    /// (often slow) post-switch snapshot is still in flight.
    @Published private(set) var pendingAccountId: String?
    @Published private(set) var deletionRequest: AccountDeletionRequest?
    @Published private(set) var isDeletingAccount = false
    @Published private(set) var isAcceptingConsent = false
    @Published private(set) var isSigningIn = false
    @Published private(set) var snapshotLoadFailed = false
    /// proposalId → queued command id so cards can follow approve/reject through recentCommands.
    @Published private(set) var proposalCommandIds: [String: String] = [:]
    /// proposalId → submit-time failure shown on the card itself.
    @Published private(set) var proposalNotices: [String: (message: String, action: ProposalActionFeedback.ProposalAction)] = [:]

    private let client: MobileAPIClient
    private var eventTask: Task<Void, Never>?
    private var reloadInFlight = false
    private var reloadPending = false
    private var loadGeneration = 0
    private var commandAttemptTracker = CommandAttemptTracker()

    private static let cacheKey = "cached_mobile_snapshot_data"
    private static let cacheTimestampKey = "cached_mobile_snapshot_saved_at"

    private static func loadCachedSnapshot() -> MobileSnapshot? {
        guard let data = UserDefaults.standard.data(forKey: cacheKey) else { return nil }
        return try? JSONDecoder().decode(MobileSnapshot.self, from: data)
    }

    private static func loadCachedSnapshotSavedAt() -> Date? {
        let interval = UserDefaults.standard.double(forKey: cacheTimestampKey)
        guard interval > 0 else { return nil }
        return Date(timeIntervalSince1970: interval)
    }

    private static func saveCachedSnapshot(_ data: Data) {
        UserDefaults.standard.set(data, forKey: cacheKey)
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: cacheTimestampKey)
    }

    init(client: MobileAPIClient, previewSnapshot: MobileSnapshot? = nil) {
        self.client = client
        let cached = previewSnapshot ?? Self.loadCachedSnapshot()
        snapshot = cached
        isAuthenticated = cached != nil
        hasInitialized = previewSnapshot != nil
        if cached == nil {
            lastUpdatedAt = nil
        } else if previewSnapshot != nil {
            lastUpdatedAt = Date()
        } else {
            lastUpdatedAt = Self.loadCachedSnapshotSavedAt()
        }
    }

    var isInitialLoading: Bool {
        !hasInitialized && snapshot == nil
    }

    var hasActiveCommandWork: Bool {
        !busyOperations.isEmpty
    }

    func isBusy(_ operationID: String) -> Bool {
        busyOperations.contains(operationID)
    }

    func isAccountActive(_ account: ConnectedAccount) -> Bool {
        if let pendingAccountId {
            return account.id == pendingAccountId
        }
        return account.isActive == true
    }

    func displayedActiveAccount(in snapshot: MobileSnapshot) -> ConnectedAccount? {
        if let pendingAccountId,
           let pending = snapshot.connectedAccounts.first(where: { $0.id == pendingAccountId }) {
            return pending
        }
        return snapshot.readiness.activeConnectedAccount
            ?? snapshot.connectedAccounts.first(where: { $0.isActive == true })
    }

    /// Derive on-card approve/reject feedback: sending → queued/running → succeeded/failed.
    func proposalActionFeedback(proposalId: String) -> ProposalActionFeedback? {
        let approveOp = "proposal.approve:\(proposalId)"
        let rejectOp = "proposal.reject:\(proposalId)"
        if busyOperations.contains(approveOp) {
            return .sending(action: .approve)
        }
        if busyOperations.contains(rejectOp) {
            return .sending(action: .reject)
        }
        if let notice = proposalNotices[proposalId] {
            return .failed(action: notice.action, message: notice.message)
        }
        guard
            let commandID = proposalCommandIds[proposalId],
            let command = recentCommand(id: commandID)
        else {
            return nil
        }
        let action: ProposalActionFeedback.ProposalAction =
            command.commandType == "proposal.reject" ? .reject : .approve
        switch command.status {
        case "queued", "running":
            return .pending(action: action, status: command.status)
        case "failed":
            if action == .approve, let result = command.result {
                return approvePlacementFeedback(action: action, result: result, fallback: command.error)
            }
            let detail = command.error?.trimmingCharacters(in: .whitespacesAndNewlines)
            let message = (detail?.isEmpty == false)
                ? detail!
                : "Command failed — check Activity for details."
            return .failed(action: action, message: message)
        case "succeeded":
            if action == .approve, let result = command.result {
                return approvePlacementFeedback(action: action, result: result, fallback: nil)
            }
            return .succeeded(action: action)
        default:
            return nil
        }
    }

    /// Folds every `recentCommands` entry that carries `commandID` through the same
    /// duplicate policy the tracker uses (`MobileCommand.foldDuplicate`).  A naive
    /// `first(where:)` could select the stale member of a duplicated id and show the card
    /// stuck in `queued` while `reconcile` already saw the terminal update.
    private func recentCommand(id commandID: String) -> MobileCommand? {
        guard let commands = snapshot?.recentCommands else { return nil }
        var folded: MobileCommand?
        for command in commands where command.id == commandID {
            guard let current = folded else {
                folded = command
                continue
            }
            folded = MobileCommand.foldDuplicate(existing: current, incoming: command)
        }
        return folded
    }

    private func approvePlacementFeedback(
        action: ProposalActionFeedback.ProposalAction,
        result: MobileCommandResult,
        fallback: String?
    ) -> ProposalActionFeedback {
        let status = result.status ?? "error"
        let reasons = result.reasons
        if let fallback = fallback?.trimmingCharacters(in: .whitespacesAndNewlines), !fallback.isEmpty,
           reasons?.isEmpty != false {
            return .placementSettled(action: action, status: status, reasons: [fallback])
        }
        return .placementSettled(action: action, status: status, reasons: reasons)
    }

    func isSnapshotStale(at now: Date = Date()) -> Bool {
        guard let lastUpdatedAt else { return snapshot != nil }
        return snapshotLoadFailed || now.timeIntervalSince(lastUpdatedAt) > 180
    }

    /// Capability discovery from the server-advertised control catalog
    /// (`snapshot.catalog.commands[].type`).  Two deliberate fallbacks:
    /// - No snapshot yet, no catalog field, or an empty `commands` array means the server did
    ///   not answer the question — assume supported, so an older server (or a payload that
    ///   drops the field) never silently disables working controls.
    /// - Protective commands are never gated on this (see `canSubmit`): a halt must not depend
    ///   on the catalog decoding correctly.
    func serverAdvertises(_ commandType: String) -> Bool {
        guard let catalog = snapshot?.catalog, catalog.describesCommands else { return true }
        return catalog.advertisedCommandTypes.contains(commandType)
    }

    func canSubmit(_ commandType: String, at now: Date = Date()) -> Bool {
        if Self.protectiveCommands.contains(commandType) {
            return true
        }
        // A command this deployment does not advertise would be rejected by the server's
        // `isMobileCommandType` check anyway — refuse it here instead of spending a round
        // trip to collect a 400.
        if !serverAdvertises(commandType) {
            return false
        }
        // Account switch is a pure active-pointer flip on the server (now also executes
        // immediately, outside the strategy.run_once queue). It must remain available when
        // portfolio/snapshot data is stale — that is exactly when users try to switch away
        // from a stuck/stale context. Requires any loaded snapshot so we still know accounts.
        if commandType == "account.activate" {
            return snapshot != nil
        }
        // Cancel is exempt for the same reason, more sharply: a flaky connection — which is what
        // a stale snapshot usually means — is exactly when someone reaches for the cancel button.
        // Safe to allow on a stale view because the SERVER re-validates: the mobile lane runs
        // `cancelWorkingOrder` with `requireWorkingOrder: true` and refuses with 404/409 when the
        // order is no longer working or is not in the selected account, so a stale tap collects an
        // honest error instead of cancelling the wrong thing.  Requires any loaded snapshot so we
        // still have an order row and an account number to send.
        if commandType == "order.cancel" {
            return snapshot != nil
        }
        // Owner Approve is the same class of exemption: a stale or failed snapshot is
        // exactly when a pending card looks stuck (Retry Red Team is a long LLM, then
        // `load()` can miss the 30s mobile timeout).  The server re-validates the
        // `proposed -> placing` claim and the halt / Exit-only / liquidating fence, so a
        // stale tap collects an honest error instead of placing the wrong order.
        // Requires any loaded snapshot so we still have a proposal id and account.
        if commandType == "proposal.approve" {
            return snapshot != nil
        }
        guard let snapshot, !isSnapshotStale(at: now) else { return false }
        if Self.readinessDependentCommands.contains(commandType) {
            return snapshot.readiness.hasAccount && snapshot.readiness.hasUniverse
        }
        return true
    }

    func load() async {
        loadGeneration &+= 1
        let generation = loadGeneration
        let shouldReportSessionExpiry = hasInitialized || isAuthenticated
        isRefreshing = true
        defer {
            if generation == loadGeneration {
                isRefreshing = false
                hasInitialized = true
            }
        }
        let wasLoadFailed = snapshotLoadFailed
        do {
            let timeout: TimeInterval = pendingAccountId == nil ? 30 : 45
            var loadedSnapshot: MobileSnapshot
            var rawData: Data
            do {
                (loadedSnapshot, rawData) = try await client.snapshotData(timeout: timeout)
            } catch let firstError as MobileAPIError {
                // The snapshot endpoint can legitimately run tens of seconds when broker
                // dependencies are slow, and a fresh sign-in has no cached snapshot to
                // soften a single timeout — the first miss used to surface straight as
                // the full-screen "Couldn't load your workspace" state.  The web console
                // retries this same class instead of failing
                // (docs/rollouts/2026-08-12-load-screens-and-lato.md); mirror that for
                // the no-snapshot case with one longer second attempt.
                guard snapshot == nil, case .network = firstError, generation == loadGeneration else {
                    throw firstError
                }
                try await Task.sleep(nanoseconds: 1_500_000_000)
                guard generation == loadGeneration else { return }
                (loadedSnapshot, rawData) = try await client.snapshotData(timeout: 45)
            }
            guard generation == loadGeneration else { return }
            snapshot = loadedSnapshot
            Self.saveCachedSnapshot(rawData)
            lastUpdatedAt = Date()
            snapshotLoadFailed = false
            isAuthenticated = true
            if wasLoadFailed {
                error = nil
            }
            if let pendingAccountId,
               loadedSnapshot.connectedAccounts.contains(where: { $0.id == pendingAccountId && $0.isActive == true })
                || loadedSnapshot.readiness.activeConnectedAccount?.id == pendingAccountId {
                self.pendingAccountId = nil
            }
            reconcileTrackedCommands(loadedSnapshot.recentCommands)
        } catch is CancellationError {
            return
        } catch let caught {
            guard generation == loadGeneration else { return }
            snapshotLoadFailed = true
            applyAuthAwareError(caught, showUnauthorizedMessage: shouldReportSessionExpiry)
        }
    }

    func startEvents() {
        eventTask?.cancel()
        eventTask = Task { [weak self, client] in
            var retryDelay: Double = 1.0
            while !Task.isCancelled {
                do {
                    // onConnect fires on stream establishment and every received line (incl.
                    // ": ping" heartbeats), so the indicator is truthful on a healthy idle stream.
                    try await client.events(onConnect: {
                        Task { @MainActor [weak self] in
                            self?.isStreamConnected = true
                        }
                    }, onEvent: {
                        Task { @MainActor [weak self] in
                            self?.isStreamConnected = true
                            self?.scheduleReload()
                        }
                    })
                    retryDelay = 1.0
                    if !Task.isCancelled {
                        self?.isStreamConnected = false
                    }
                } catch is CancellationError {
                    return
                } catch {
                    self?.isStreamConnected = false
                    // SSE sockets drop often (Cloudflare/QUIC resets, idle gaps). Reconnect
                    // quietly when we already have data; only surface 401/403 or a blank screen.
                    if let apiError = error as? MobileAPIError, case .unauthorized = apiError {
                        self?.applyAuthAwareError(apiError, preserveTransientMessage: false)
                    } else if self?.snapshot == nil {
                        self?.applyAuthAwareError(error, preserveTransientMessage: true)
                    }
                    if self?.isAuthenticated != true { return }
                    retryDelay = min(30.0, retryDelay * 1.5)
                }

                let jitter = Double.random(in: 0.1...0.5)
                let delayNanoseconds = UInt64((retryDelay + jitter) * 1_000_000_000)
                do {
                    try await Task.sleep(nanoseconds: delayNanoseconds)
                } catch {
                    return
                }
            }
        }
    }

    func stopEvents() {
        eventTask?.cancel()
        eventTask = nil
        isStreamConnected = false
    }

    @discardableResult
    func submit(
        _ commandType: String,
        payload: [String: Any] = [:],
        operationID: String? = nil
    ) async -> Bool {
        let operationID = operationID ?? commandType
        guard !busyOperations.contains(operationID) else { return false }
        guard canSubmit(commandType) else {
            error = unavailableMessage(for: commandType)
            return false
        }
        let idempotencyKey = commandAttemptTracker.idempotencyKey(
            operationID: operationID,
            commandType: commandType,
            payload: payload
        )
        busyOperations.insert(operationID)
        if commandType == "account.activate", let accountId = payload["accountId"] as? String {
            pendingAccountId = accountId
        }
        let proposalId = payload["proposalId"] as? String
        let proposalAction: ProposalActionFeedback.ProposalAction? = {
            switch commandType {
            case "proposal.approve": return .approve
            case "proposal.reject": return .reject
            default: return nil
            }
        }()
        if let proposalId, proposalAction != nil {
            proposalNotices.removeValue(forKey: proposalId)
        }

        do {
            let command = try await client.submit(
                commandType: commandType,
                payload: payload,
                idempotencyKey: idempotencyKey
            )
            commandAttemptTracker.track(command, operationID: operationID)
            if let proposalId, proposalAction != nil {
                proposalCommandIds[proposalId] = command.id
            }
            // Stop / other immediate commands return terminal in the POST body, so
            // drop the spinner before the snapshot reload.  Account switch is the
            // exception: the Use row must stay busy until the new snapshot arrives,
            // otherwise the sheet looks dead and then snaps to the requested account.
            if commandType == "account.activate" {
                if command.didFail {
                    pendingAccountId = nil
                    reconcileTrackedCommands([command])
                } else {
                    await load()
                    if let pending = pendingAccountId,
                       snapshot?.readiness.activeConnectedAccount?.id != pending,
                       snapshot?.connectedAccounts.first(where: { $0.id == pending })?.isActive != true {
                        error = "Switched accounts.  Waiting for the new portfolio to load."
                    }
                    reconcileTrackedCommands([command])
                }
            } else {
                if commandType.hasPrefix("proposal.") {
                    // Queue ACK is enough to leave "Sending…".  A slow snapshot
                    // reload must not lock the card on a 30s timeout.
                    busyOperations.remove(operationID)
                }
                reconcileTrackedCommands([command])
                await load()
                reconcileTrackedCommands([command])
            }
            if command.didFail, let proposalId, let proposalAction {
                let detail = command.error?.trimmingCharacters(in: .whitespacesAndNewlines)
                proposalNotices[proposalId] = (
                    message: (detail?.isEmpty == false)
                        ? detail!
                        : "The queued action was \(command.status).",
                    action: proposalAction
                )
            }
            return !command.didFail
        } catch is CancellationError {
            if commandType == "account.activate" { pendingAccountId = nil }
            busyOperations.remove(operationID)
            return false
        } catch let caught {
            if commandType == "account.activate" { pendingAccountId = nil }
            if shouldReleaseCommandAttempt(after: caught) {
                commandAttemptTracker.release(operationID: operationID)
            }
            // Network/decoding errors keep the idempotency key for an explicit retry, but they do
            // not leave the control visually locked when no command id was confirmed.
            busyOperations.remove(operationID)
            if let proposalId, let proposalAction {
                proposalNotices[proposalId] = (
                    message: caught.localizedDescription,
                    action: proposalAction
                )
            }
            applyAuthAwareError(caught)
            return false
        }
    }

    /// On-demand single-symbol quote for `SymbolInfoSheet`. Unlike `load()`, this does not touch
    /// `snapshot`/`error`/`isRefreshing` — the sheet owns its own loading/error state, and
    /// `client` is otherwise private to this store, so views reach it through this passthrough.
    func fetchSymbolQuote(_ symbol: String) async throws -> SymbolQuoteInfo {
        try await client.symbolQuote(symbol)
    }

    func fetchSymbolDesk(_ symbol: String) async throws -> SymbolDeskInfo {
        try await client.symbolDesk(symbol)
    }

    func fetchChatHistory() async throws -> [ChatTurn] {
        try await client.chatHistory()
    }

    func sendChat(message: String, model: String?, clientTurnId: String) async throws -> ChatReply {
        try await client.sendChat(message: message, model: model, clientTurnId: clientTurnId)
    }

    func clearChatHistory() async throws {
        try await client.clearChatHistory()
    }

    func fetchChatProviders() async throws -> [String: Bool] {
        try await client.chatProviders()
    }

    func fetchMarketScan() async throws -> MarketScanResponse {
        try await client.marketScan()
    }

    func fetchFullPolicy() async throws -> FullPolicy {
        try await client.fullPolicy()
    }

    func fetchSourceFeatures() async throws -> SourceFeaturesResponse {
        try await client.sourceFeatures()
    }

    func patchSourceFeatures(_ settings: [String: Any]) async throws -> SourceFeaturesResponse {
        try await client.patchSourceFeatures(settings)
    }

    func fetchLlmBudget() async throws -> LlmBudgetResponse {
        try await client.llmBudget()
    }

    func patchLlmBudget(_ body: [String: Any]) async throws -> LlmBudgetResponse {
        try await client.patchLlmBudget(body)
    }

    var needsAppConsent: Bool {
        snapshot?.readiness.requiresAppConsent == true
    }

    func acceptAppConsent() async {
        guard !isAcceptingConsent else { return }
        isAcceptingConsent = true
        defer { isAcceptingConsent = false }
        do {
            try await client.acceptAppConsent()
            error = nil
            await load()
        } catch {
            applyAuthAwareError(error)
        }
    }

    func acknowledgeNotifications(ids: [String]) async {
        let unique = Array(Set(ids.filter { !$0.isEmpty }))
        guard !unique.isEmpty else { return }
        do {
            _ = try await client.acknowledgeNotifications(ids: unique)
            error = nil
            await load()
        } catch {
            applyAuthAwareError(error)
        }
    }

    func loadAccountDeletionPreview() async {
        guard !isDeletingAccount else { return }
        isDeletingAccount = true
        defer { isDeletingAccount = false }
        do {
            deletionRequest = try await client.accountDeletionPreview()
            error = nil
        } catch {
            applyAuthAwareError(error)
        }
    }

    func clearAccountDeletionPreview() {
        deletionRequest = nil
    }

    func confirmAccountDeletion(typedIdentity: String, typedText: String) async -> URL? {
        guard deletionRequest != nil, !isDeletingAccount else { return nil }
        isDeletingAccount = true
        defer { isDeletingAccount = false }
        do {
            let result = try await client.confirmAccountDeletion(
                typedIdentity: typedIdentity,
                typedText: typedText
            )
            // The HTTP success is authoritative. Clear cookies and all in-memory account state
            // before inspecting optional receipt fields so response drift cannot preserve access.
            clearLocalSession()
            return client.resolvedURL(result.logoutUrl ?? "/logout")
        } catch {
            applyAuthAwareError(error)
            return nil
        }
    }

    func loginWithApple(identityToken: String, name: String?) async {
        guard !isSigningIn else { return }
        isSigningIn = true
        defer { isSigningIn = false }
        do {
            _ = try await client.loginWithApple(identityToken: identityToken, name: name)
            isAuthenticated = true
            error = nil
            await load()
            if isAuthenticated {
                startEvents()
                await claimPushTokenForCurrentSession()
            }
        } catch {
            applyAuthAwareError(error)
            self.error = "Apple Sign-In failed: \(error.localizedDescription)"
        }
    }

    func loginWithWebAuthCode(_ code: String, verifier: String) async {
        guard !isSigningIn else { return }
        isSigningIn = true
        defer { isSigningIn = false }
        do {
            try await client.exchangeWebAuthCode(code, verifier: verifier)
            await load()
            if isAuthenticated {
                startEvents()
                await claimPushTokenForCurrentSession()
            } else if error == nil {
                error = "Authentication failed after web sign-in.  Try again."
            }
        } catch {
            applyAuthAwareError(error)
            self.error = "Web sign-in could not be completed.  Try again."
        }
    }

    func dismissError() {
        error = nil
    }

    func dismissSuccess() {
        successMessage = nil
    }

    /// Re-register this device's APNs token under the session that just began.
    ///
    /// Registration is otherwise only attempted at cold start, for a session that was ALREADY
    /// restored — which leaves a real window on a shared device: when one owner's session expires
    /// (`clearLocalSession` drops only the local belief; it cannot send an authenticated delete,
    /// and the system token stays valid) and a DIFFERENT account signs in, the server row still
    /// belongs to the previous owner and still delivers their alerts to this phone until the next
    /// cold launch.  Registering here hands the token to the new session immediately — the server
    /// reassigns the row on conflict — and it is also what gets push working on a first sign-in
    /// without making the owner relaunch the app.  Never prompts: it re-asserts an existing grant
    /// only, and does nothing when notifications were never authorized.
    private func claimPushTokenForCurrentSession() async {
        await PushNotificationCoordinator.shared.registerIfAlreadyAuthorized()
    }

    /// Explicit sign-out.  The push token is withdrawn FIRST and awaited: `clearLocalSession`
    /// deletes the session cookies, and a delete sent after that would arrive unauthenticated
    /// and leave this device registered to receive the signed-out user's alerts.
    func signOut() async {
        await PushNotificationCoordinator.shared.signOutAndForgetToken()
        clearLocalSession()
    }

    func clearLocalSession() {
        stopEvents()
        // Also reached when a session simply expires, where no authenticated delete is
        // possible — drop the local belief that this device is registered.
        PushNotificationCoordinator.shared.forgetTokenLocally()
        for cookie in HTTPCookieStorage.shared.cookies ?? [] where client.ownsCookie(cookie) {
            HTTPCookieStorage.shared.deleteCookie(cookie)
        }
        // Remove the UserDefaults blob so a cold launch after sign-out does not re-read it
        UserDefaults.standard.removeObject(forKey: Self.cacheKey)
        UserDefaults.standard.removeObject(forKey: Self.cacheTimestampKey)
        loadGeneration &+= 1
        snapshot = nil
        lastUpdatedAt = nil
        snapshotLoadFailed = false
        deletionRequest = nil
        busyOperations = []
        pendingAccountId = nil
        proposalCommandIds = [:]
        proposalNotices = [:]
        commandAttemptTracker.removeAll()
        isRefreshing = false
        isAuthenticated = false
        hasInitialized = true
        error = nil
        successMessage = nil
    }

    private func scheduleReload() {
        guard !reloadInFlight else {
            reloadPending = true
            return
        }
        reloadInFlight = true
        Task { [weak self] in
            guard let self else { return }
            repeat {
                reloadPending = false
                await load()
            } while reloadPending && !Task.isCancelled
            reloadInFlight = false
        }
    }

    private func reconcileTrackedCommands(_ commands: [MobileCommand]) {
        let resolutions = commandAttemptTracker.reconcile(commands)
        for resolution in resolutions {
            busyOperations.remove(resolution.operationID)
            if resolution.status == "succeeded",
               resolution.operationID.hasPrefix(PolicyTightening.commandType) {
                successMessage = "Guardrails updated."
                continue
            }
            guard resolution.status == "failed" || resolution.status == "cancelled" else { continue }
            let detail = resolution.error?.trimmingCharacters(in: .whitespacesAndNewlines)
            error = detail?.isEmpty == false
                ? detail
                : "The queued action was \(resolution.status)."
        }
    }

    private func applyAuthAwareError(
        _ caught: Error,
        preserveTransientMessage: Bool = true,
        showUnauthorizedMessage: Bool = true
    ) {
        if let apiError = caught as? MobileAPIError, case .unauthorized = apiError {
            clearLocalSession()
            error = showUnauthorizedMessage ? apiError.localizedDescription : nil
            return
        }
        if preserveTransientMessage {
            error = caught.localizedDescription
        }
    }

    private func shouldReleaseCommandAttempt(after error: Error) -> Bool {
        guard let apiError = error as? MobileAPIError else { return false }
        switch apiError {
        case .serverError, .unauthorized, .scanQuotesUnavailable:
            return true
        case .network, .decoding:
            return false
        }
    }

    private func unavailableMessage(for commandType: String) -> String {
        if !serverAdvertises(commandType) {
            return "This version cannot run \(AppFormat.commandLabel(commandType)) yet."
        }
        if Self.readinessDependentCommands.contains(commandType),
           let snapshot,
           !snapshot.readiness.hasAccount || !snapshot.readiness.hasUniverse {
            return "Connect an account and configure a symbol universe before running the agent."
        }
        return "Pull to refresh, then try again.  Stop remains available."
    }

    private static let protectiveCommands: Set<String> = [
        "strategy.stop",
        "strategy.close_only",
        "strategy.liquidating",
        "proposal.reject"
    ]

    private static let readinessDependentCommands: Set<String> = [
        "strategy.run_once",
        "strategy.start"
    ]
}
