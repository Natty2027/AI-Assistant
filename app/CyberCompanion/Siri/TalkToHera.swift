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

    func request() { isPending = true }

    /// Returns true once per request.
    func take() -> Bool {
        guard isPending else { return false }
        isPending = false
        return true
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
                "Start \(.applicationName)",
                "Create with \(.applicationName)",
            ],
            shortTitle: "Talk to Hera",
            systemImageName: "waveform"
        )
    }
}

/// What the person's spoken answer means, for the conversation's first question.
enum ConversationReply {
    /// "Website" or "posts" from what was said; nil when it's neither, or both (Hera does one at
    /// a time, so she asks again).
    static func mode(from reply: String) -> CreateMode? {
        let said = reply.lowercased()
        let posts = ["post", "social", "tweet", "instagram", "caption", "bluesky", "announce"].contains { said.contains($0) }
        let site = ["website", "web site", "site", "web page", "webpage", "landing page"].contains { said.contains($0) }
        guard posts != site else { return nil }
        return posts ? .posts : .site
    }
}
