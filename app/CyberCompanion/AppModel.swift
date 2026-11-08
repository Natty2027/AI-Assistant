import Foundation
import Observation

/// The app's shared state: server settings, the latest assistant run, proposals, and accounts.
/// Views read from it and call its methods; all network work goes through APIClient.
@MainActor
@Observable
final class AppModel {
    private static let serverURLKey = "serverURL"
    private static let tokenAccount = "accessToken"

    private(set) var serverURLString: String
    private(set) var accessToken: String

    var connections: [Connection] = []
    var proposals: [Proposal] = []
    var lastRun: AgentRunResponse?
    var aiConsent: Bool?
    var isRunning = false
    var errorMessage: String?

    init() {
        serverURLString = UserDefaults.standard.string(forKey: Self.serverURLKey) ?? ""
        accessToken = Keychain.read(Self.tokenAccount) ?? ""
        #if DEBUG
        // Development only: launch already pointed at a server, e.g. scripts/mock-app-server.mjs.
        let env = ProcessInfo.processInfo.environment
        if let url = env["CC_SERVER_URL"], let token = env["CC_ACCESS_TOKEN"] {
            serverURLString = url
            accessToken = token
        }
        #endif
    }

    var isConfigured: Bool { client != nil }

    var pendingCount: Int { proposals.filter(\.isPending).count }

    var socialConnections: [Connection] { connections.filter { $0.kind == "social" } }
    var hostingConnections: [Connection] { connections.filter { $0.kind == "hosting" } }

    /// nil until a valid https server address (or a local http one, for development) and a token are set.
    var client: APIClient? {
        guard !accessToken.isEmpty,
              let url = URL(string: serverURLString.trimmingCharacters(in: .whitespaces)),
              let scheme = url.scheme, let host = url.host() else { return nil }
        let isLocal = host == "localhost" || host == "127.0.0.1"
        guard scheme == "https" || (scheme == "http" && isLocal) else { return nil }
        return APIClient(baseURL: url, token: accessToken)
    }

    func saveSettings(serverURL: String, accessToken: String) {
        serverURLString = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        self.accessToken = accessToken.trimmingCharacters(in: .whitespacesAndNewlines)
        UserDefaults.standard.set(serverURLString, forKey: Self.serverURLKey)
        Keychain.write(self.accessToken, for: Self.tokenAccount)
    }

    /// Loads everything the tabs show. Called on launch and after settings change.
    func refreshAll() async {
        guard isConfigured else { return }
        async let consent: Void = refreshConsent()
        async let accounts: Void = refreshConnections()
        async let pending: Void = refreshProposals()
        _ = await (consent, accounts, pending)
    }

    /* ---------------- the assistant ---------------- */

    func runAssistant(prompt: String, allowWebSearch: Bool) async {
        let request = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let client, !request.isEmpty else { return }
        isRunning = true
        defer { isRunning = false }
        await perform {
            lastRun = try await client.runAssistant(request: request, allowWebSearch: allowWebSearch)
            proposals = try await client.proposals()
        }
    }

    /* ---------------- review ---------------- */

    func refreshProposals() async {
        guard let client else { return }
        await perform { proposals = try await client.proposals() }
    }

    /// Approves exactly what was shown (by its payload hash) and carries it out straight away.
    /// Returns the updated proposal so the screen can show the outcome.
    func approveAndCarryOut(_ proposal: Proposal, attestations: [String], acknowledgeTaint: Bool) async -> Proposal? {
        guard let client else { return nil }
        var updated: Proposal?
        await perform {
            let approval = try await client.approve(proposal, attestations: attestations, acknowledgeTaint: acknowledgeTaint)
            updated = try await client.execute(proposal, token: approval.token)
            proposals = try await client.proposals()
        }
        return updated
    }

    func reject(_ proposal: Proposal) async {
        guard let client else { return }
        await perform {
            try await client.reject(proposal)
            proposals = try await client.proposals()
        }
    }

    /* ---------------- accounts ---------------- */

    func refreshConnections() async {
        guard let client else { return }
        await perform { connections = try await client.connections() }
    }

    func connectNetlify(token: String) async -> Bool {
        guard let client else { return false }
        return await perform {
            _ = try await client.connectNetlify(token: token.trimmingCharacters(in: .whitespacesAndNewlines))
            connections = try await client.connections()
        }
    }

    func connectBluesky(handle: String, appPassword: String) async -> Bool {
        guard let client else { return false }
        return await perform {
            _ = try await client.connectBluesky(handle: handle, appPassword: appPassword)
            connections = try await client.connections()
        }
    }

    func disconnect(_ connection: Connection) async {
        guard let client else { return }
        await perform {
            try await client.disconnect(connection)
            connections = try await client.connections()
        }
    }

    /* ---------------- consent ---------------- */

    func refreshConsent() async {
        guard let client else { return }
        await perform { aiConsent = try await client.aiConsent() }
    }

    func setAIConsent(_ granted: Bool) async {
        guard let client else { return }
        await perform { aiConsent = try await client.setAIConsent(granted) }
    }

    /* ---------------- errors ---------------- */

    /// Runs one piece of network work and turns a failure into a message the person can read.
    @discardableResult
    private func perform(_ work: () async throws -> Void) async -> Bool {
        do {
            try await work()
            errorMessage = nil
            return true
        } catch is CancellationError {
            return false
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }
}
