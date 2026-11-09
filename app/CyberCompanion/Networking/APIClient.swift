import Foundation

/// Talks to the Cyber Companion server. Every request carries the person's access token as a
/// Bearer header (server/auth.ts); request bodies use the server's snake_case field names.
///
/// Network behaviour, ported from Cognivate's client: a 401 refreshes the session once and
/// retries; reads are retried on brief failures with backoff; the preferred language is sent;
/// errors come back as sentences a person can act on, with a reference for support.
struct APIClient: Sendable {
    let baseURL: URL
    /// Supplies a currently valid access token (refreshing if needed), or nil when signed out.
    let tokenProvider: @Sendable () async throws -> String?
    /// Called once after a 401. Returns true if a new token is now available to retry with.
    var refreshAfterUnauthorized: @Sendable () async -> Bool = { false }
    var session: URLSession = SecureSession.shared
    /// Injected in tests so retry backoff costs nothing.
    var sleep: @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(for: .seconds($0)) }

    enum APIError: LocalizedError {
        case server(status: Int, message: String, code: String?, requestID: String?)
        case invalidResponse

        var errorDescription: String? {
            switch self {
            case .server(let status, let message, _, let requestID):
                // The server words sign-in failures for developers (token details). A person
                // only needs to know to sign in again.
                let text = status == 401 ? "You've been signed out. Please sign in again." : message
                return requestID.map { "\(text) (Ref: \($0))" } ?? text
            case .invalidResponse:
                return "Hera sent a reply the app couldn't read. Please try again."
            }
        }

        var code: String? {
            if case .server(_, _, let code, _) = self { return code }
            return nil
        }
    }

    /* ---------------- the assistant ---------------- */

    func runAssistant(request: String, mode: CreateMode, allowWebSearch: Bool, photoID: String? = nil,
                      schedule: ScheduleSnapshot? = nil, conversationID: String? = nil) async throws -> AgentRunResponse {
        struct Body: Encodable {
            let request: String; let mode: CreateMode; let allowWebSearch: Bool; let photoId: String?
            /// Schedule runs only: the person's calendar and reminders for this one request.
            let schedule: ScheduleSnapshot?
            /// Continues an earlier task, from the previous answer's conversationId.
            let conversationId: String?
        }
        // A run can take several model turns, so it gets a much longer timeout than other calls.
        return try await send("POST", "agent/run",
                              body: Body(request: request, mode: mode, allowWebSearch: allowWebSearch, photoId: photoID,
                                         schedule: schedule, conversationId: conversationID),
                              timeout: 300)
    }

    /// Uploads a JPEG for the next posts run and returns its id.
    func uploadPhoto(jpeg: Data) async throws -> String {
        struct Body: Encodable { let data: String }
        let out: PhotoUploadResponse = try await send("POST", "agent/media", body: Body(data: jpeg.base64EncodedString()), timeout: 120)
        return out.id
    }

    func proposals() async throws -> [Proposal] {
        let out: ProposalsResponse = try await send("GET", "agent/proposals")
        return out.proposals
    }

    /// Approval names the hash of exactly what the person saw; the server refuses anything else.
    func approve(_ proposal: Proposal, attestations: [String], acknowledgeTaint: Bool) async throws -> ApprovalResponse {
        struct Body: Encodable { let payloadHash: String; let attestations: [String]; let acknowledgeTaint: Bool }
        return try await send("POST", "agent/proposals/\(proposal.id)/approve",
                              body: Body(payloadHash: proposal.payloadHash, attestations: attestations, acknowledgeTaint: acknowledgeTaint))
    }

    func execute(_ proposal: Proposal, token approvalToken: String) async throws -> Proposal {
        struct Body: Encodable { let token: String }
        let out: ProposalResponse = try await send("POST", "agent/proposals/\(proposal.id)/execute", body: Body(token: approvalToken), timeout: 120)
        return out.proposal
    }

    func reject(_ proposal: Proposal) async throws {
        let _: OKResponse = try await send("POST", "agent/proposals/\(proposal.id)/reject", body: [String: String]())
    }

    /* ---------------- what Hera remembers ---------------- */

    func memories() async throws -> [Memory] {
        let out: MemoriesResponse = try await send("GET", "agent/memories")
        return out.memories
    }

    func addMemory(_ text: String) async throws -> MemoryAddResponse {
        struct Body: Encodable { let text: String }
        return try await send("POST", "agent/memories", body: Body(text: text))
    }

    func deleteMemory(_ memory: Memory) async throws {
        let _: OKResponse = try await send("DELETE", "agent/memories/\(memory.id)")
    }

    /* ---------------- account ---------------- */

    /// Deletes everything the server holds about the person, and their sign-in account.
    func deleteAccount() async throws {
        struct Body: Encodable { let confirm: String }
        let _: OKResponse = try await send("POST", "account/delete", body: Body(confirm: "DELETE"), timeout: 60)
    }

    /* ---------------- the website ---------------- */

    func site() async throws -> SiteResponse {
        try await send("GET", "agent/site")
    }

    func siteFile(_ path: String) async throws -> String {
        let out: FileResponse = try await send("GET", "agent/site/file", query: [URLQueryItem(name: "path", value: path)])
        return out.contents
    }

    /* ---------------- accounts ---------------- */

    func connections() async throws -> ConnectionsResponse {
        try await send("GET", "agent/connections")
    }

    /// The platform's own sign-in page, to open in a secure browser sheet.
    func signInPage(for provider: SignInProvider) async throws -> URL {
        let out: SignInStartResponse = try await send("GET", "agent/connections/oauth/\(provider.rawValue)")
        guard let url = URL(string: out.authUrl), url.scheme == "https" else { throw APIError.invalidResponse }
        return url
    }

    func connectNetlify(token netlifyToken: String) async throws -> Connection {
        struct Body: Encodable { let token: String }
        let out: ConnectionResponse = try await send("POST", "agent/connections/netlify", body: Body(token: netlifyToken))
        return out.connection
    }

    func connectBluesky(handle: String, appPassword: String) async throws -> Connection {
        struct Body: Encodable { let identifier: String; let appPassword: String }
        let out: ConnectionResponse = try await send("POST", "agent/connections/bluesky", body: Body(identifier: handle, appPassword: appPassword))
        return out.connection
    }

    func disconnect(_ connection: Connection) async throws {
        let _: OKResponse = try await send("DELETE", "agent/connections/\(connection.id)")
    }

    /* ---------------- consent ---------------- */

    func aiConsent() async throws -> Bool {
        let out: ConsentResponse = try await send("GET", "consent/ai")
        return out.granted
    }

    func setAIConsent(_ granted: Bool) async throws -> Bool {
        struct Body: Encodable { let granted: Bool }
        let out: ConsentResponse = try await send("POST", "consent/ai", body: Body(granted: granted))
        return out.granted
    }

    /* ---------------- transport ---------------- */

    private func send<T: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = [], timeout: TimeInterval = 30) async throws -> T {
        try await send(method, path, query: query, bodyData: nil, timeout: timeout)
    }

    private func send<T: Decodable>(_ method: String, _ path: String, body: some Encodable, timeout: TimeInterval = 30) async throws -> T {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        return try await send(method, path, query: [], bodyData: try encoder.encode(body), timeout: timeout)
    }

    private func send<T: Decodable>(_ method: String, _ path: String, query: [URLQueryItem], bodyData: Data?, timeout: TimeInterval) async throws -> T {
        var url = baseURL.appending(path: path)
        if !query.isEmpty { url.append(queryItems: query) }
        let retriesAllowed = method == "GET"
        var refreshed = false
        var attempt = 1

        while true {
            do {
                let (data, http) = try await perform(method: method, url: url, bodyData: bodyData, timeout: timeout)
                if http.statusCode == 401 && !refreshed {
                    // The token may have just expired: refresh once and try again. A 401 means the
                    // request wasn't processed, so repeating it is safe for any method.
                    refreshed = true
                    if await refreshAfterUnauthorized() { continue }
                }
                guard (200..<300).contains(http.statusCode) else {
                    // The server's errors are written for people (server/http.ts), so show them as they are.
                    let body = try? JSONDecoder().decode(ServerErrorBody.self, from: data)
                    let requestID = body?.requestId ?? http.value(forHTTPHeaderField: "X-Request-Id").flatMap { http.statusCode >= 500 ? $0 : nil }
                    let error = APIError.server(status: http.statusCode, message: body?.error ?? Self.fallbackMessage(http.statusCode),
                                                code: body?.code, requestID: requestID)
                    if retriesAllowed, attempt < RetryPolicy.maxAttempts, RetryPolicy.isTransient(error) {
                        try await sleep(RetryPolicy.delay(beforeRetry: attempt, retryAfter: RetryPolicy.retryAfter(from: http)))
                        attempt += 1
                        continue
                    }
                    throw error
                }
                do {
                    return try JSONDecoder().decode(T.self, from: data)
                } catch {
                    throw APIError.invalidResponse
                }
            } catch let error as URLError {
                if retriesAllowed, attempt < RetryPolicy.maxAttempts, RetryPolicy.isTransient(error) {
                    try await sleep(RetryPolicy.delay(beforeRetry: attempt, retryAfter: nil))
                    attempt += 1
                    continue
                }
                throw error
            }
        }
    }

    private func perform(method: String, url: URL, bodyData: Data?, timeout: TimeInterval) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = method
        if let token = try await tokenProvider() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(Locale.preferredLanguages.prefix(3).joined(separator: ", "), forHTTPHeaderField: "Accept-Language")
        if let bodyData {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = bodyData
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        return (data, http)
    }

    private static func fallbackMessage(_ status: Int) -> String {
        switch status {
        case 401: "You're signed out. Please sign in again."
        case 429: "That's a lot of requests at once. Wait a moment and try again."
        case 500...: "Something went wrong on our side. Please try again."
        default: "The server couldn't do that (\(status))."
        }
    }
}
