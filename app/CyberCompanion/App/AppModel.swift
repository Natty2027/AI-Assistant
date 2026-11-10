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
    /// The person's calendar and reminders on this device, for Schedule.
    let schedule = ScheduleManager()

    /// What happened to each proposed schedule change the person acted on, by change id.
    enum ChangeOutcome: Equatable {
        case working
        case done
        case undone
        case skipped
        case failed(String)
    }
    var scheduleOutcomes: [String: ChangeOutcome] = [:]
    /// The latest "what's on my day" rundown, shown on Create while it's relevant.
    var briefing: String?
    /// The task in progress: a reply continues it until "Start something new".
    private(set) var conversation: (id: String, mode: CreateMode)?
    /// Lasting facts Hera remembers, shown in Settings.
    var memories: [Memory] = []

    /// True when the next message continues the current task in this mode.
    func isContinuing(_ mode: CreateMode) -> Bool { conversation?.mode == mode && lastRun != nil }
    /// How to reverse each change that was made, by change id, for its Undo button.
    private var scheduleUndos: [String: ScheduleUndo] = [:]

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
        #if DEBUG
        // The developer token bypasses Sign in with Apple, so only development builds use it. A
        // release build ignores (and clears) any left in the Keychain by an earlier build.
        accessToken = Keychain.read(Self.tokenAccount) ?? ""
        #else
        accessToken = ""
        Keychain.write("", for: Self.tokenAccount)
        #endif
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
        scheduleOutcomes = [:]
        scheduleUndos = [:]
        briefing = nil
        conversation = nil
        memories = []
        aiConsent = nil
        errorMessage = nil
    }

    /// Loads everything the tabs show. Called on launch and after settings change.
    func refreshAll() async {
        guard isConfigured else { await refreshWidget(); return }
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
            let photoID = if let photo, mode.takesPhoto { try await client.uploadPhoto(jpeg: photo) } else { String?.none }
            // Read on this device, for this request only.
            // Schedule needs the calendar. A launch uses it if allowed, and goes ahead without it if not.
            let snapshot: ScheduleSnapshot? = switch mode {
            case .schedule: try await schedule.snapshot()
            case .launch: try? await schedule.snapshot()
            default: nil
            }
            let continuing = conversation?.mode == mode ? conversation?.id : nil
            let run = try await client.runAssistant(request: request, mode: mode, allowWebSearch: allowWebSearch,
                                                    photoID: photoID, schedule: snapshot, conversationID: continuing)
            lastRun = run
            conversation = run.conversationId.map { ($0, mode) }
            scheduleOutcomes = [:]
        scheduleUndos = [:]
            proposals = try await client.proposals()
        }
    }

    /// "Start something new" on Create. Proposals stay waiting on the Review tab.
    func clearLastRun() {
        lastRun = nil
        conversation = nil
        scheduleOutcomes = [:]
        scheduleUndos = [:]
        errorMessage = nil
    }

    /* ---------------- schedule ---------------- */

    /// Makes one change Hera proposed, on this device, now that the person has approved it.
    func approve(_ change: ScheduleChange) async {
        guard scheduleOutcomes[change.id] == nil else { return }
        scheduleOutcomes[change.id] = .working
        do {
            scheduleUndos[change.id] = try await schedule.apply(change)
            scheduleOutcomes[change.id] = .done
            await refreshWidget()
        } catch {
            scheduleOutcomes[change.id] = .failed(error.localizedDescription)
        }
    }

    /// "What's on my day?": today's events, reminders due and approvals waiting, as a sentence or
    /// two for Hera to say. Returns nil (with errorMessage set) if the calendar can't be read.
    func briefMe() async -> String? {
        await refreshProposals()
        do {
            let agenda = try await schedule.today()
            let text = DayBriefing.text(for: agenda, pendingApprovals: pendingCount)
            briefing = text
            return text
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func canUndo(_ change: ScheduleChange) -> Bool {
        scheduleOutcomes[change.id] == .done && scheduleUndos[change.id] != nil
    }

    /// Puts an approved change back the way it was.
    func undo(_ change: ScheduleChange) async {
        guard canUndo(change), let undo = scheduleUndos[change.id] else { return }
        scheduleOutcomes[change.id] = .working
        do {
            try await schedule.undo(undo)
            scheduleUndos[change.id] = nil
            scheduleOutcomes[change.id] = .undone
            await refreshWidget()
        } catch {
            scheduleOutcomes[change.id] = .failed("Couldn't undo: \(error.localizedDescription)")
        }
    }

    func skip(_ change: ScheduleChange) {
        guard scheduleOutcomes[change.id] == nil else { return }
        scheduleOutcomes[change.id] = .skipped
    }

    /* ---------------- review ---------------- */

    func refreshProposals() async {
        // The widget's calendar part doesn't need the server, so it's refreshed even when signed out.
        guard let client else { await refreshWidget(); return }
        await perform { proposals = try await client.proposals() }
        await refreshWidget()
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
        await refreshWidget()
        return updated
    }

    func reject(_ proposal: Proposal) async {
        guard let client else { return }
        await perform {
            try await client.reject(proposal)
            proposals = try await client.proposals()
        }
        await refreshWidget()
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
    /// Returns whether the accounts were connected, and anything the person should know (for
    /// example, that a Page connected but no Instagram business account was linked to it).
    func finishSignIn(callback: URL) async -> (connected: Bool, note: String?) {
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard items.first(where: { $0.name == "status" })?.value == "ok",
              let pending = items.first(where: { $0.name == "pending" })?.value, let client else {
            errorMessage = items.first(where: { $0.name == "message" })?.value ?? "Connecting didn't finish. Please try again."
            return (false, nil)
        }
        // The server only saves the connection once this signed-in app confirms it, so a sign-in
        // link sent to someone else can't attach their account to the sender's Hera.
        var note: String?
        let confirmed = await perform { note = try await client.confirmSignIn(pending: pending) }
        guard confirmed else { return (false, nil) }
        await refreshConnections()
        return (true, note)
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

    /* ---------------- what Hera remembers ---------------- */

    func refreshMemories() async {
        guard let client else { return }
        await perform { memories = try await client.memories() }
    }

    /// Returns the server's answer in words ("Remembered.", "Already remembered.").
    func addMemory(_ text: String) async -> String? {
        guard let client else { return nil }
        var message: String?
        await perform {
            message = try await client.addMemory(text.trimmingCharacters(in: .whitespacesAndNewlines)).message
            memories = try await client.memories()
        }
        return message
    }

    func forget(_ memory: Memory) async {
        guard let client else { return }
        await perform {
            try await client.deleteMemory(memory)
            memories = try await client.memories()
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
