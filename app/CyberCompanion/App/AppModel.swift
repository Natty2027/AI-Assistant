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
    /// Alerts before calendar events, with Hera saying what's coming up.
    let reminders = EventReminders()
    /// Hera Pro: the subscription and this month's requests.
    let pro = HeraPro()
    /// The business's name, colors and logo, used on every poster.
    let brand = BrandKitStore()
    /// Quick rewrites, hashtags and reply ideas with Apple's on-device model: no server request.
    let onDevice = OnDeviceHera()
    #if os(iOS)
    /// Scheduled posts counting down on the Lock Screen and in the Dynamic Island.
    private let scheduledPosts = ScheduledPostActivities()
    #endif
    /// The photo sent with the latest run, so its posters can use it.
    private(set) var lastRunPhoto: Data?

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
    /// The spoken conversation in progress (Talk): every turn continues it until it ends.
    private var talkConversationID: String?
    /// A text message the person pasted or shared to Hera: read aloud, and sent with the next
    /// request so Hera can explain it or write the reply.
    var receivedText: String?
    /// An email whose "time to send" reminder was tapped: shown, ready to send.
    var remindedEmail: EmailDraft?
    /// Lasting facts Hera remembers, shown in Settings.
    var memories: [Memory] = []
    /// The widget refresh in progress, and whether another was asked for meanwhile (refreshWidget).
    @ObservationIgnored var widgetRefresh: Task<Void, Never>?
    @ObservationIgnored var widgetRefreshAgain = false

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
        // Nothing of this account's stays on the Lock Screen.
        await syncLiveActivities()
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
        await syncLiveActivities()
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
        talkConversationID = nil
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
        // The plan and this month's requests, for the upgrade card and posters' "Made with Hera".
        async let plan: Void = pro.refresh(client: client)
        _ = await (consent, accounts, pending, plan)
    }

    /* ---------------- the assistant ---------------- */

    /// `photo` is a JPEG for the posts and posters; it's uploaded first.
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
            let shared = receivedText
            let run = try await client.runAssistant(request: request, mode: mode, allowWebSearch: allowWebSearch,
                                                    photoID: photoID, schedule: snapshot, conversationID: continuing,
                                                    receivedText: shared)
            // Hera has it now, in this conversation; it isn't sent again with the next reply.
            if shared != nil { receivedText = nil }
            // One more request used this month.
            Task { await pro.refresh(client: client) }
            lastRun = run
            conversation = run.conversationId.map { ($0, mode) }
            // A new task uses its own photo; a reply keeps the task's photo unless it brings a new one.
            if !mode.takesPhoto { lastRunPhoto = nil }
            else if let photo { lastRunPhoto = photo }
            else if continuing == nil { lastRunPhoto = nil }
            scheduleOutcomes = [:]
        scheduleUndos = [:]
            proposals = try await client.proposals()
        }
    }

    /* ---------------- Talk ---------------- */

    /// A new spoken conversation: it doesn't continue the last one. While Hera greets or the
    /// person starts speaking, her voice loads and the connection to the server opens, so the
    /// first answer isn't kept waiting for either.
    func startTalk() {
        talkConversationID = nil
        if UserDefaults.standard.object(forKey: HeraVoice.speakRepliesKey) as? Bool ?? true { speech.prepare() }
        if let client { Task { await client.warmUp() } }
    }

    /// One spoken turn in Talk: what the person said, and Hera's answer, in the same conversation
    /// as the turns before. Never throws: a problem comes back as words for Hera to say. It
    /// doesn't touch the composer's result (`lastRun`), so the two never mix. `onText` hears the
    /// answer so far as Hera writes it (from servers that send it), so she can start speaking.
    func talk(_ said: String, allowWebSearch: Bool, onText: (@MainActor (String) -> Void)? = nil) async -> TalkReply {
        guard let client else { return .stop("I can't reach Hera until you sign in. Open Settings to sign in, then talk to me again.") }
        if aiConsent == false { return .stop("First, tap Allow AI on this screen, then talk to me again.") }
        guard connectivity.isOnline else { return .problem("I can't reach Hera right now. Check your internet connection, then try again.") }
        do {
            // Their calendar, read on this device for this turn. Only asked for when they're asking
            // about it; otherwise it's sent if they already allowed it.
            let snapshot: ScheduleSnapshot?
            if TalkFlow.mentionsSchedule(said) { snapshot = try? await schedule.snapshot() }
            else { snapshot = await schedule.snapshotIfAllowed() }
            let shared = receivedText
            var streamed: (@Sendable (String) async -> Void)?
            if let onText { streamed = { @Sendable text in await onText(text) } }
            let run = try await client.runAssistant(request: said, mode: .talk, allowWebSearch: allowWebSearch,
                                                    schedule: snapshot, conversationID: talkConversationID, receivedText: shared,
                                                    onText: streamed)
            if shared != nil { receivedText = nil }
            talkConversationID = run.conversationId
            Task { await pro.refresh(client: client) }
            // In the background, so Hera answers (and listens again) without waiting for this.
            if !run.proposals.isEmpty {
                Task {
                    if let latest = try? await client.proposals() { proposals = latest }
                    await syncLiveActivities()
                }
            }
            return .answer(run)
        } catch is CancellationError {
            return .problem("That didn't go through. Please say it again.")
        } catch {
            // This month's requests are used up: offer Hera Pro, and stop talking.
            if case APIClient.APIError.server(_, _, "limit_reached", _) = error {
                pro.showPlans = true
                return .stop(RetryPolicy.message(for: error))
            }
            return .problem(RetryPolicy.message(for: error))
        }
    }

    /// From a tapped email reminder: opens that email, and Hera says what it is.
    func openRemindedEmail(_ id: String) {
        guard let draft = EmailReminders.email(id) else { return }
        remindedEmail = draft
        speech.speak(EmailReminders.spoken(for: draft))
    }

    /* ---------------- texts the person received ---------------- */

    /// A text pasted or shared to Hera: kept for the next request and read out.
    func receive(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        receivedText = String(trimmed.prefix(4000))
        speech.speak("Here's the text: \(receivedText ?? "")")
    }

    /// Picks up a text shared from Messages while the app was closed.
    func collectSharedText() {
        if let text = SharedTexts.takeLatest() { receive(text: text) }
    }

    /// "Start something new" on Create. Proposals stay waiting on the Review tab.
    func clearLastRun() {
        lastRun = nil
        conversation = nil
        lastRunPhoto = nil
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

    /// Brings event reminders in line with the calendar. `mayAsk` lets the notification permission
    /// prompt appear; it can't in the background.
    func refreshReminders(mayAsk: Bool = true) async {
        await reminders.update(schedule: schedule, voice: speech, mayAsk: mayAsk)
    }

    /// "Turn on" in Settings when Hera can't see the calendar yet: asks for it, then schedules.
    func allowRemindersCalendar() async {
        _ = try? await schedule.today()
        await refreshWidget()
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
        // Independent of each other: the Lock Screen and the widget update side by side.
        async let activities: Void = syncLiveActivities()
        async let widget: Void = refreshWidget()
        _ = await (activities, widget)
    }

    /// Brings the Lock Screen's scheduled posts in line with the proposals. iPhone and iPad only.
    func syncLiveActivities() async {
        #if os(iOS)
        await scheduledPosts.sync(with: proposals, connections: connections)
        #endif
    }

    /// Back in the app: a post may have gone out while Hera was closed. Fetches only when one is
    /// waiting for its time, and quietly, since a moment offline isn't worth an error on screen.
    func refreshScheduledPosts() async {
        if proposals.contains(where: \.isScheduled), let client, let latest = try? await client.proposals() {
            proposals = latest
        }
        await syncLiveActivities()
    }

    /// Approves exactly what was shown (by its payload hash) and carries it out straight away.
    /// Returns the updated proposal so the screen can show the outcome.
    func approveAndCarryOut(_ proposal: Proposal, attestations: [String], acknowledgeTaint: Bool) async -> Proposal? {
        guard let client else { return nil }
        var updated: Proposal?
        await perform {
            let approval = try await client.approve(proposal, attestations: attestations, acknowledgeTaint: acknowledgeTaint)
            // A post with a time is held by the server until then; anything else goes now.
            updated = proposal.postAt != nil
                ? try await client.schedule(proposal, token: approval.token)
                : try await client.execute(proposal, token: approval.token)
            proposals = try await client.proposals()
        }
        await syncLiveActivities()
        await refreshWidget()
        return updated
    }

    func reject(_ proposal: Proposal) async {
        guard let client else { return }
        await perform {
            try await client.reject(proposal)
            proposals = try await client.proposals()
        }
        await syncLiveActivities()
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
            // This month's requests are used up: offer Hera Pro.
            if case APIClient.APIError.server(_, _, "limit_reached", _) = error { pro.showPlans = true }
            return false
        }
    }
}
