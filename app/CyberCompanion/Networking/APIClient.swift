import Foundation

/// Talks to the Cyber Companion server. Every request carries the person's access token as a
/// Bearer header (server/auth.ts); request bodies use the server's snake_case field names.
struct APIClient: Sendable {
    let baseURL: URL
    let token: String
    var session: URLSession = .shared

    enum APIError: LocalizedError {
        case server(status: Int, message: String, code: String?)
        case invalidResponse

        var errorDescription: String? {
            switch self {
            case .server(_, let message, _): message
            case .invalidResponse: "The server sent a reply the app couldn't read."
            }
        }
    }

    /* ---------------- the assistant ---------------- */

    func runAssistant(request: String, allowWebSearch: Bool) async throws -> AgentRunResponse {
        struct Body: Encodable { let request: String; let allowWebSearch: Bool }
        // A run can take several model turns, so it gets a much longer timeout than other calls.
        return try await send("POST", "agent/run", body: Body(request: request, allowWebSearch: allowWebSearch), timeout: 300)
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

    /* ---------------- the website ---------------- */

    func site() async throws -> SiteResponse {
        try await send("GET", "agent/site")
    }

    func siteFile(_ path: String) async throws -> String {
        let out: FileResponse = try await send("GET", "agent/site/file", query: [URLQueryItem(name: "path", value: path)])
        return out.contents
    }

    /* ---------------- accounts ---------------- */

    func connections() async throws -> [Connection] {
        let out: ConnectionsResponse = try await send("GET", "agent/connections")
        return out.connections
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
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let bodyData {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = bodyData
        }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            // The server's errors are written for people (server/http.ts), so show them as they are.
            let body = try? JSONDecoder().decode(ServerErrorBody.self, from: data)
            throw APIError.server(status: http.statusCode, message: body?.error ?? "The server returned an error (\(http.statusCode)).", code: body?.code)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.invalidResponse
        }
    }
}
