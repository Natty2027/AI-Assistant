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
    /// "Ask Hera to make something": a request to send as it is, from Siri or an automation.
    private(set) var pendingCreation: Creation?

    /// What to ask Hera for, and which kind of task it is.
    struct Creation: Equatable, Sendable {
        let request: String
        let mode: CreateMode
    }

    func request() { isPending = true }
    func requestBriefing() { isBriefingPending = true }
    /// A newer request replaces one that hasn't been sent yet.
    func requestCreation(_ request: String, mode: CreateMode) { pendingCreation = Creation(request: request, mode: mode) }

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

    /// Returns each creation request once.
    func takeCreation() -> Creation? {
        defer { pendingCreation = nil }
        return pendingCreation
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
    static let description = IntentDescription("Opens Hera, who asks whether you'd like posters and posts, a launch, or help with your schedule, then listens.")
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
        // The request itself can't be part of a phrase (it's free text), so Siri asks for it.
        AppShortcut(
            intent: CreateWithHeraIntent(),
            phrases: [
                "Make something with \(.applicationName)",
                "Ask \(.applicationName) to make something",
                "Ask \(.applicationName) to make a post",
                "Make a post with \(.applicationName)",
            ],
            shortTitle: "Ask Hera to Make Something",
            systemImageName: "sparkles"
        )
        AppShortcut(
            intent: WhatNeedsApprovalIntent(),
            phrases: [
                "What needs my approval in \(.applicationName)",
                "What's waiting in \(.applicationName)",
                "What needs approving in \(.applicationName)",
                "Ask \(.applicationName) what needs my approval",
            ],
            shortTitle: "What Needs My Approval",
            systemImageName: "checkmark.seal"
        )
        AppShortcut(
            intent: ComingUpIntent(),
            phrases: [
                "What's coming up in \(.applicationName)",
                "What's scheduled in \(.applicationName)",
                "Ask \(.applicationName) what's coming up",
                "When do my \(.applicationName) posts go out",
            ],
            shortTitle: "What's Coming Up",
            systemImageName: "calendar.badge.clock"
        )
    }
}

/// What the person's spoken answer means, for the conversation's first question.
enum ConversationReply {
    /// Posts (posters too), schedule or a launch from what was said; nil when it's none of them,
    /// or both posts and schedule (Hera does one at a time, so she asks again).
    static func mode(from reply: String) -> CreateMode? {
        let said = reply.lowercased()
        // "post" also hears "poster".
        let posts = ["post", "social", "tweet", "instagram", "caption", "bluesky", "announce", "flyer", "studio",
                     "design", "ebay", "email"].contains { said.contains($0) }
        let schedule = ["schedule", "calendar", "meeting", "appointment", "remind", "plan my", "my day", "my week"].contains { said.contains($0) }
        let launch = ["launch", "everything", "all of it", "the works", "launch kit"].contains { said.contains($0) }
        // A launch covers posts and the calendar too, so it wins when said.
        if launch { return .launch }
        let matches = [(posts, CreateMode.posts), (schedule, .schedule)].filter(\.0)
        return matches.count == 1 ? matches[0].1 : nil
    }
}
