import AppIntents
import Foundation
import Observation

/// "Hey Siri, talk to Hera": Siri (or Shortcuts, Spotlight, the Action button) opens the app and
/// asks it to start a spoken conversation. The intent only raises the request; AssistantView
/// runs the conversation, because it owns the mic, Hera's voice and the composer.
@MainActor
@Observable
final class ConversationRequests {
    /// Set by the intent, cleared by the screen that starts the conversation. Waits if that
    /// screen isn't showing yet (for example while the person signs in).
    private(set) var isPending = false
    /// "What's on my day?": the same, for the spoken briefing.
    private(set) var isBriefingPending = false

    func request() { isPending = true }
    func requestBriefing() { isBriefingPending = true }

    /// Returns true once per request.
    func take() -> Bool {
        guard isPending else { return false }
        isPending = false
        return true
    }

    func takeBriefing() -> Bool {
        guard isBriefingPending else { return false }
        isBriefingPending = false
        return true
    }
}

/// "Siri, hi Hera, what's on my day?": opens Hera, who reads out today's events, the reminders
/// due and what's waiting for approval, in her own voice. Built on the device; nothing is sent.
struct WhatsOnMyDayIntent: AppIntent {
    static let title: LocalizedStringResource = "What's on My Day"
    static let description = IntentDescription("Hera reads out today's events, the reminders that are due, and anything waiting for your approval.")
    // Foreground, so it's Hera's own voice rather than Siri's.
    static var supportedModes: IntentModes { .foreground }

    @Dependency private var requests: ConversationRequests

    @MainActor
    func perform() async throws -> some IntentResult {
        requests.requestBriefing()
        return .result()
    }
}

struct TalkToHeraIntent: AppIntent {
    static let title: LocalizedStringResource = "Talk to Hera"
    static let description = IntentDescription("Opens Hera, who asks whether you'd like to create a website or write posts, then listens.")
    // Opens the app before perform() runs: the conversation needs the screen, mic and speaker.
    static var supportedModes: IntentModes { .foreground }

    @Dependency private var requests: ConversationRequests

    @MainActor
    func perform() async throws -> some IntentResult {
        requests.request()
        return .result()
    }
}

struct HeraShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: TalkToHeraIntent(),
            phrases: [
                "Talk to \(.applicationName)",
                "Hey \(.applicationName)",
                "Hi \(.applicationName)",
                "Hello \(.applicationName)",
                "Start \(.applicationName)",
                "Create with \(.applicationName)",
            ],
            shortTitle: "Talk to Hera",
            systemImageName: "waveform"
        )
        AppShortcut(
            intent: WhatsOnMyDayIntent(),
            phrases: [
                "Hi \(.applicationName), what's on my day",
                "Hi \(.applicationName), what's my day look like",
                "Hey \(.applicationName), what's on my day",
                "What's on my day in \(.applicationName)",
                "Brief me with \(.applicationName)",
            ],
            shortTitle: "What's on My Day",
            systemImageName: "sun.horizon"
        )
    }
}

/// What the person's spoken answer means, for the conversation's first question.
enum ConversationReply {
    /// Website, posts or schedule from what was said; nil when it's none of them, or more than
    /// one (Hera does one at a time, so she asks again).
    static func mode(from reply: String) -> CreateMode? {
        let said = reply.lowercased()
        let posts = ["post", "social", "tweet", "instagram", "caption", "bluesky", "announce"].contains { said.contains($0) }
        let site = ["website", "web site", "site", "web page", "webpage", "landing page"].contains { said.contains($0) }
        let schedule = ["schedule", "calendar", "meeting", "appointment", "remind", "plan my", "my day", "my week"].contains { said.contains($0) }
        let matches = [(posts, CreateMode.posts), (site, .site), (schedule, .schedule)].filter(\.0)
        return matches.count == 1 ? matches[0].1 : nil
    }
}
