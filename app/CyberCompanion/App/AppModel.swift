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
    /// Development and staging only: the server's TEST_ACCESS_TOKEN, used instead of signing in.
    private(set) var accessToken: String

    let session = Session()
    let connectivity = Connectivity()
    /// Hera's spoken voice. Shared so the model is loaded once, the first time she speaks.
    let speech = HeraVoice()

    var connections: [Connection] = []
    /// Which platform sign-ins (X, Facebook and Instagram) the server can offer.
    var signInAvailability: SignInAvailability = .none
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

    /// The server address: the release value in AppConfig, else what was entered in Settings.
    var serverURL: URL? { AppConfig.serverURL ?? ServerAddress.normalize(serverURLString) }

    /// Signing in is required when the build can sign in and no developer token is set.
    var needsSignIn: Bool { session.isAvailable && !session.isSignedIn && accessToken.isEmpty }

    var pendingCount: Int { proposals.filter(\.isPending).count }

    /// nil until there's a valid server address (https, or http on this machine) and a way to
    /// authenticate: a signed-in session, or a developer token.
    var client: APIClient? {
        guard let url = serverURL else { return nil }
        if !accessToken.isEmpty {
            let token = accessToken
            return APIClient(baseURL: url, tokenProvider: { token })
        }
        guard session.isSignedIn else { return nil }
        let session = session
        return APIClient(baseURL: url,
                         tokenProvider: { try await session.validAccessToken() },
                         refreshAfterUnauthorized: { (try? await session.refresh()) != nil })
    }

    func saveSettings(serverURL: String, accessToken: String) {
        serverURLString = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        self.accessToken = accessToken.trimmingCharacters(in: .whitespacesAndNewlines)
        UserDefaults.standard.set(serverURLString, forKey: Self.serverURLKey)
        Keychain.write(self.accessToken, for: Self.tokenAccount)
    }

    /// Development: point sign-in at a Supabase project without rebuilding.
    func saveSignInService(url: String, anonKey: String) {
        UserDefaults.standard.set(url.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "supabaseURL")
        UserDefaults.standard.set(anonKey.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "supabaseAnonKey")
    }

    /* ---------------- account ---------------- */

    func signOut() async {
        await session.signOut()
        resetLocalState()
    }

    /// Deletes the account on the server (data and sign-in), then signs out on this device.
    /// Returns false, with errorMessage set, if the server didn't confirm.
    func deleteAccount() async -> Bool {
        guard let client else { return false }
        let deleted = await perform { try await client.deleteAccount() }
        guard deleted else { return false }
        session.clear()
        saveSettings(serverURL: serverURLString, accessToken: "")
        resetLocalState()
        return true
    }

    private func resetLocalState() {
        speech.stop()
        connections = []
        signInAvailability = .none
        proposals = []
        lastRun = nil
        aiConsent = nil
        errorMessage = nil
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

    /// `photo` is a JPEG to attach to the posts (Posts only); it's uploaded first.
    func runAssistant(prompt: String, mode: CreateMode, allowWebSearch: Bool, photo: Data? = nil) async {
        let request = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let client, !request.isEmpty else { return }
        isRunning = true
        defer { isRunning = false }
        await perform {
            let photoID = if let photo, mode == .posts { try await client.uploadPhoto(jpeg: photo) } else { String?.none }
            lastRun = try await client.runAssistant(request: request, mode: mode, allowWebSearch: allowWebSearch, photoID: photoID)
            proposals = try await client.proposals()
        }
    }

    /// "Start something new" on Create. Proposals stay waiting on the Review tab.
    func clearLastRun() {
        lastRun = nil
        errorMessage = nil
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
        await perform { try await loadConnections(client) }
    }

    private func loadConnections(_ client: APIClient) async throws {
        let out = try await client.connections()
        connections = out.connections
        signInAvailability = out.signIn ?? .none
    }

    /// The platform's own sign-in page for connecting X, or Facebook and Instagram.
    func signInPage(for provider: SignInProvider) async -> URL? {
        guard let client else { return nil }
        var url: URL?
        await perform { url = try await client.signInPage(for: provider) }
        return url
    }

    /// The sign-in sheet closed on the server's hera://connected address, which says how it went.
    /// Returns true when the accounts were connected.
    func finishSignIn(callback: URL) async -> Bool {
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard items.first(where: { $0.name == "status" })?.value == "ok" else {
            errorMessage = items.first(where: { $0.name == "message" })?.value ?? "Connecting didn't finish. Please try again."
            return false
        }
        await refreshConnections()
        return true
    }

    func connectNetlify(token: String) async -> Bool {
        guard let client else { return false }
        return await perform {
            _ = try await client.connectNetlify(token: token.trimmingCharacters(in: .whitespacesAndNewlines))
            try await loadConnections(client)
        }
    }

    func connectBluesky(handle: String, appPassword: String) async -> Bool {
        guard let client else { return false }
        return await perform {
            _ = try await client.connectBluesky(handle: handle, appPassword: appPassword)
            try await loadConnections(client)
        }
    }

    func disconnect(_ connection: Connection) async {
        guard let client else { return }
        await perform {
            try await client.disconnect(connection)
            try await loadConnections(client)
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
            errorMessage = RetryPolicy.message(for: error)
            return false
        }
    }
}
