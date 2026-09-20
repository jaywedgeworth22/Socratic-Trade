import CryptoKit
import Foundation
import Security

enum MobileAPIError: Error, LocalizedError {
    case unauthorized(statusCode: Int)
    case serverError(statusCode: Int, message: String?)
    case scanQuotesUnavailable(MarketScanResponse)
    case network(Error)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .unauthorized:
            return "Your session expired.  Sign in again."
        case .serverError(let statusCode, let message):
            // Cloudflare 521-523: origin unreachable.  Keep the reason, drop the vendor and code.
            if (521...523).contains(statusCode) {
                return "Socratic Trade is unreachable right now.  Try again in a few minutes."
            }
            if let message, !message.isEmpty {
                return message
            }
            return "Something went wrong.  Try again."
        case .scanQuotesUnavailable(let scan):
            let reasons = scan.warnings
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            if !reasons.isEmpty {
                return reasons.joined(separator: "  ")
            }
            return "Quotes were unavailable for this universe.  Refresh after the quote feed recovers."
        case .network:
            return "Check your connection and try again."
        case .decoding:
            return "Couldn’t load your workspace.  Try again."
        }
    }
}

struct SSEFrameAccumulator {
    private var frameHasPayload = false

    mutating func consume(line: String) -> Bool {
        if line.isEmpty {
            defer { frameHasPayload = false }
            return frameHasPayload
        }
        guard !line.hasPrefix(":") else { return false }
        if line.hasPrefix("event:") || line.hasPrefix("data:") {
            frameHasPayload = true
        }
        return false
    }
}

struct MobileAPIClient {
    /// The one origin this app talks to.  Shared so the push coordinator (which cannot be
    /// handed the store's client) targets the same host — and therefore the same
    /// `HTTPCookieStorage.shared` session — instead of a second hardcoded string that can drift.
    static let productionBaseURL = URL(string: "https://socratictrade.com")!

    let baseURL: URL
    var session: URLSession = .shared

    func snapshot() async throws -> MobileSnapshot {
        let (snap, _) = try await snapshotData()
        return snap
    }

    func snapshotData(timeout: TimeInterval = 30) async throws -> (MobileSnapshot, Data) {
        var req = request(path: "/api/mobile/snapshot")
        req.timeoutInterval = timeout
        let data = try await successfulResponseData(for: req)
        do {
            let snap = try JSONDecoder().decode(MobileSnapshot.self, from: data)
            return (snap, data)
        } catch {
            throw MobileAPIError.decoding(error)
        }
    }

    func submit(
        commandType: String,
        payload: [String: Any] = [:],
        idempotencyKey: String = UUID().uuidString
    ) async throws -> MobileCommand {
        var request = request(path: "/api/mobile/commands", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("\(commandType):\(idempotencyKey)", forHTTPHeaderField: "idempotency-key")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "commandType": commandType,
            "payload": payload,
            "client": [
                "platform": "ios",
                "appVersion": Bundle.main.appVersion,
                "buildNumber": Bundle.main.buildNumber
            ]
        ])
        let envelope: CommandEnvelope = try await send(request)
        return envelope.command
    }

    func chatHistory() async throws -> [ChatTurn] {
        let envelope: ChatHistoryResponse = try await get("/api/chat-history")
        return envelope.turns
    }

    func sendChat(message: String, model: String?, clientTurnId: String) async throws -> ChatReply {
        var body: [String: Any] = [
            "message": message,
            "clientTurnId": clientTurnId
        ]
        if let model, !model.isEmpty {
            body["model"] = model
        }
        return try await sendJSON("/api/chat", method: "POST", body: body, timeout: 90)
    }

    func clearChatHistory() async throws {
        var request = request(path: "/api/chat-history", method: "DELETE")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [:])
        _ = try await successfulResponseData(for: request)
    }

    func chatProviders() async throws -> [String: Bool] {
        let envelope: ChatProvidersResponse = try await get("/api/chat/providers")
        return envelope.providers
    }

    /// Interactive market scan — GET `/api/scan`.  The server budget is 35s.
    /// Client wait is longer so a late seed/200 is not dropped as a dead table.
    /// A 503 `scan_quotes_unavailable` body still carries scanned/quotes/warnings
    /// so Scan can show the abort instead of "No Candidates."
    static let marketScanTimeout: TimeInterval = 50

    func marketScan() async throws -> MarketScanResponse {
        var req = request(path: "/api/scan")
        req.timeoutInterval = Self.marketScanTimeout
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw MobileAPIError.network(error)
        }
        if let http = response as? HTTPURLResponse, http.statusCode == 503 {
            if let failed = try? JSONDecoder().decode(MarketScanResponse.self, from: data),
               (failed.scannedSymbols ?? 0) > 0 || !failed.warnings.isEmpty {
                throw MobileAPIError.scanQuotesUnavailable(failed)
            }
        }
        try Self.requireSuccess(response, body: data)
        do {
            return try JSONDecoder().decode(MarketScanResponse.self, from: data)
        } catch {
            throw MobileAPIError.decoding(error)
        }
    }

    func marketScanRequest() -> URLRequest {
        var req = request(path: "/api/scan")
        req.timeoutInterval = Self.marketScanTimeout
        return req
    }

    func fullPolicy() async throws -> FullPolicy {
        try await get("/api/policy")
    }

    func sourceFeatures() async throws -> SourceFeaturesResponse {
        try await get("/api/settings/source-features")
    }

    func patchSourceFeatures(_ settings: [String: Any]) async throws -> SourceFeaturesResponse {
        let _: SourceFeaturesPatchAck = try await sendJSON(
            "/api/settings/source-features",
            method: "PATCH",
            body: ["settings": settings]
        )
        return try await sourceFeatures()
    }

    func llmBudget() async throws -> LlmBudgetResponse {
        try await get("/api/settings/llm-budget")
    }

    func patchLlmBudget(_ body: [String: Any]) async throws -> LlmBudgetResponse {
        try await sendJSON("/api/settings/llm-budget", method: "PATCH", body: body)
    }

    /// On-demand single-symbol quote + fundamentals for `SymbolInfoSheet` — GET
    /// `/api/quote?symbol=...`, the same on-demand provider cascade the web console drilldown
    /// falls back to for a symbol outside the last market scan.
    func symbolQuote(_ symbol: String) async throws -> SymbolQuoteInfo {
        var components = URLComponents(url: baseURL.appending(path: "/api/quote"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "symbol", value: symbol)]
        guard let url = components?.url else {
            throw MobileAPIError.network(URLError(.badURL))
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "accept")
        return try await send(request)
    }

    /// Current-account exit contract + other-account size/direction for the ticker sheet.
    func symbolDesk(_ symbol: String) async throws -> SymbolDeskInfo {
        var components = URLComponents(url: baseURL.appending(path: "/api/symbol-desk"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "symbol", value: symbol)]
        guard let url = components?.url else {
            throw MobileAPIError.network(URLError(.badURL))
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "accept")
        return try await send(request)
    }

    /// Session-authed APNs token registration.  The response body is not consumed: the only
    /// thing the app needs to know is whether the server accepted the token, which is the
    /// status code.
    func registerPushToken(_ registration: PushRegistrationRequest) async throws {
        var request = request(path: "/api/mobile/push/register", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: registration.jsonBody)
        _ = try await successfulResponseData(for: request)
    }

    /// Sign-out counterpart.  Sends the token so the server drops the exact row rather than
    /// every token the session's user owns — signing out of one device must not silence
    /// another one the same owner is still signed in on.
    func unregisterPushToken(_ token: String) async throws {
        var request = request(path: "/api/mobile/push/register", method: "DELETE")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["token": token])
        _ = try await successfulResponseData(for: request)
    }

    func acknowledgeNotifications(ids: [String]) async throws -> Int {
        let envelope: AcknowledgeNotificationsResponse = try await sendJSON(
            "/api/notifications/ack",
            method: "POST",
            body: ["ids": ids]
        )
        return envelope.acknowledged
    }

    func acceptAppConsent() async throws {
        var request = request(path: "/api/mobile/consent", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["accepted": true])
        _ = try await successfulResponseData(for: request)
    }

    func accountDeletionPreview() async throws -> AccountDeletionRequest {
        let envelope: DeletionRequestEnvelope = try await send(
            request(path: "/api/mobile/account-deletion/request")
        )
        return envelope.deletionRequest
    }

    func confirmAccountDeletion(
        typedIdentity: String,
        typedText: String
    ) async throws -> AccountDeletionResult {
        var request = request(path: "/api/mobile/account-deletion/confirm", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "typedIdentity": typedIdentity,
            "typedText": typedText
        ])
        let data = try await successfulResponseData(for: request)
        // A 2xx from this endpoint means the backend completed account deletion. Optional receipt
        // fields must never strand a locally-authenticated session if the response evolves or is
        // empty after the destructive server transaction has committed.
        return (try? JSONDecoder().decode(AccountDeletionResult.self, from: data)) ?? .successfulHTTP
    }

    func loginWithApple(identityToken: String, name: String?) async throws -> AppleLoginResponse {
        var request = request(path: "/api/mobile/auth/apple", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        var body: [String: Any] = ["identityToken": identityToken]
        if let name, !name.isEmpty {
            body["name"] = name
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(request)
    }

    func exchangeWebAuthCode(_ code: String, verifier: String) async throws {
        var request = request(path: "/api/mobile/auth/exchange", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "code": code,
            "codeVerifier": verifier
        ])
        let _: WebAuthExchangeResponse = try await send(request)
    }

    /// `onConnect` fires when the stream response is established and again on every received
    /// line — including ": ping" comment heartbeats (sent every 25s). Comment frames never reach
    /// `onEvent`, so before this hook a healthy idle stream kept the connected indicator false
    /// forever (#2559). `onEvent` still fires only for payload frames.
    func events(onConnect: @escaping () -> Void = {}, onEvent: @escaping () -> Void) async throws {
        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        do {
            (bytes, response) = try await session.bytes(for: eventsRequest())
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw MobileAPIError.network(error)
        }
        try Self.requireSuccess(response, body: nil)
        onConnect()

        var parser = SSEFrameAccumulator()
        do {
            for try await line in bytes.lines {
                try Task.checkCancellation()
                onConnect()
                if parser.consume(line: line) {
                    onEvent()
                }
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw MobileAPIError.network(error)
        }
    }

    /// Long-lived SSE request. Must not reuse the JSON helper defaults:
    /// - `Accept: application/json` confuses some edge/proxy paths for `text/event-stream`
    /// - `timeoutInterval = 30` is only ~5s above the server's 25s heartbeat, so jitter or
    ///   buffering yields NSURLErrorCannotParseResponse (-1017) / connection-reset noise
    func eventsRequest() -> URLRequest {
        var request = URLRequest(url: baseURL.appending(path: "/api/mobile/events"))
        request.httpMethod = "GET"
        // Idle timeout between packets. Server heartbeats every 25s; keep generous slack.
        request.timeoutInterval = 120
        request.setValue("text/event-stream", forHTTPHeaderField: "accept")
        request.setValue("no-cache", forHTTPHeaderField: "cache-control")
        return request
    }

    func resolvedURL(_ pathOrURL: String) -> URL? {
        if let absolute = URL(string: pathOrURL), absolute.scheme != nil {
            guard
                absolute.scheme?.lowercased() == "https",
                absolute.host?.lowercased() == baseURL.host?.lowercased(),
                absolute.port == baseURL.port
            else {
                return nil
            }
            return absolute
        }
        return baseURL.appending(path: pathOrURL)
    }

    func ownsCookie(_ cookie: HTTPCookie) -> Bool {
        guard let host = baseURL.host?.lowercased() else { return false }
        let domain = cookie.domain
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
            .lowercased()
        return host == domain || host.hasSuffix(".\(domain)")
    }

    private func request(path: String, method: String = "GET") -> URLRequest {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "accept")
        return request
    }

    private func get<T: Decodable>(_ path: String, retries: Int = 2, timeout: TimeInterval = 30) async throws -> T {
        var attempt = 0
        while true {
            do {
                var req = request(path: path)
                req.timeoutInterval = timeout
                return try await send(req)
            } catch let error as MobileAPIError {
                let shouldRetry = {
                    if case .network = error { return true }
                    if case .serverError(let statusCode, _) = error, statusCode >= 500 { return true }
                    return false
                }()
                if shouldRetry, attempt < retries {
                    attempt += 1
                    let delayMs = UInt64(150_000_000 * (1 << attempt)) // 300ms, 600ms backoff
                    try await Task.sleep(nanoseconds: delayMs)
                    continue
                }
                throw error
            } catch {
                throw error
            }
        }
    }

    private func sendJSON<T: Decodable>(
        _ path: String,
        method: String,
        body: [String: Any],
        timeout: TimeInterval = 30
    ) async throws -> T {
        var request = request(path: path, method: method)
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(request)
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let data = try await successfulResponseData(for: request)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw MobileAPIError.decoding(error)
        }
    }

    private func successfulResponseData(for request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw MobileAPIError.network(error)
        }
        try Self.requireSuccess(response, body: data)
        return data
    }

    private static func requireSuccess(_ response: URLResponse, body: Data?) throws {
        guard let response = response as? HTTPURLResponse else {
            throw MobileAPIError.network(URLError(.badServerResponse))
        }
        guard 200..<300 ~= response.statusCode else {
            if response.statusCode == 401 || response.statusCode == 403 {
                throw MobileAPIError.unauthorized(statusCode: response.statusCode)
            }
            throw MobileAPIError.serverError(
                statusCode: response.statusCode,
                message: serverMessage(from: body)
            )
        }
    }

    private static func serverMessage(from data: Data?) -> String? {
        guard let data, !data.isEmpty else { return nil }
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return object["message"] as? String ?? object["error"] as? String
        }
        // Cloudflare often returns plain text like "error code: 522" when origin is down.
        if let text = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !text.isEmpty,
           text.count < 200,
           !text.hasPrefix("<") {
            return text
        }
        return nil
    }
}

struct AppleLoginResponse: Decodable {
    let success: Bool
    let email: String?
}

private struct AcknowledgeNotificationsResponse: Decodable {
    let acknowledged: Int
}

private struct WebAuthExchangeResponse: Decodable {
    let success: Bool
}

struct WebAuthCodeVerifier {
    let value: String

    static func make() -> WebAuthCodeVerifier? {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            return nil
        }
        return WebAuthCodeVerifier(value: Data(bytes).base64URLEncodedString())
    }

    var challenge: String {
        Data(SHA256.hash(data: Data(value.utf8))).base64URLEncodedString()
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

private extension Bundle {
    var appVersion: String {
        object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }

    var buildNumber: String {
        object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "dev"
    }
}
