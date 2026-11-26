import AppIntents
import Foundation

/* Siri and Shortcuts actions that make Hera part of the phone: ask her to make something, and
   ask what's waiting for approval or going out soon without opening the app. */

/// The three kinds of task Hera does, as Siri and Shortcuts show them. The raw values are saved in
/// people's shortcuts, so they never change; new kinds are only added.
enum HeraTaskKind: String, AppEnum {
    case posts
    case launch
    case schedule

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Kind of Task"
    static let caseDisplayRepresentations: [HeraTaskKind: DisplayRepresentation] = [
        .posts: DisplayRepresentation(title: "Posts and Posters", subtitle: "Studio", image: .init(systemName: "paintpalette")),
        .launch: DisplayRepresentation(title: "Launch", subtitle: "Posts, a poster, the calendar and an email", image: .init(systemName: "sparkles")),
        .schedule: DisplayRepresentation(title: "Schedule", subtitle: "Your calendar and reminders", image: .init(systemName: "calendar")),
    ]

    var mode: CreateMode {
        switch self {
        case .posts: .posts
        case .launch: .launch
        case .schedule: .schedule
        }
    }
}

/// Why an action couldn't answer, in words Siri can say.
enum HeraIntentError: Error, CustomLocalizedStringResourceConvertible {
    case notSignedIn
    case nothingAsked
    case unreachable(String)

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .notSignedIn: "You're not signed in to Hera yet. Open Hera and sign in, then ask again."
        case .nothingAsked: "Tell Hera what you'd like her to make, then try again."
        case .unreachable(let why): "Hera couldn't check just now. \(why)"
        }
    }
}

/// "Ask Hera to make something": opens Hera with the request already sent, as if it had been
/// typed. Works from a Shortcuts automation too, such as "every Monday at 8, ask Hera: draft this
/// week's posts". Nothing goes out until it's approved in the app.
struct CreateWithHeraIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Hera to Make Something"
    static let description = IntentDescription("Opens Hera and sends her your request: posts and posters, a launch, or a change to your schedule. Nothing is posted until you approve it.")
    // Foreground: the run, its results and the approvals all happen on the Create screen.
    static var supportedModes: IntentModes { .foreground }

    @Parameter(title: "Request", description: "What you'd like Hera to make, for example: draft this week's posts.")
    var request: String?

    @Parameter(title: "Kind", description: "Posts and posters, a launch, or your schedule.", default: .posts)
    var kind: HeraTaskKind

    static var parameterSummary: some ParameterSummary {
        Summary("Ask Hera to make \(\.$request) as \(\.$kind)")
    }

    @Dependency private var requests: ConversationRequests
    @Dependency private var model: AppModel

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        var text = request?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if text.isEmpty {
            text = try await $request.requestValue("What would you like Hera to make?")
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard !text.isEmpty else { throw HeraIntentError.nothingAsked }
        // Last, so a retried perform() doesn't send the request twice: a second call replaces it.
        requests.requestCreation(text, mode: kind.mode)
        if model.needsSignIn { return .result(dialog: "Sign in to Hera, and she'll start on it straight away.") }
        return .result(dialog: "Hera's on it.")
    }
}

/// "What needs my approval?": Siri says how many items are waiting and what the first few are,
/// without opening the app.
struct WhatNeedsApprovalIntent: AppIntent {
    static let title: LocalizedStringResource = "What Needs My Approval"
    static let description = IntentDescription("Hera tells you how many posts, listings and other items are waiting for your approval, and what the first three are. You approve them in the app.")
    static var supportedModes: IntentModes { .background }

    @Dependency private var model: AppModel

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let proposals = try await model.latestProposalsForSiri()
        let answer = SiriAnswers.approvals(SiriAnswers.waiting(in: proposals))
        return .result(dialog: "\(answer)")
    }
}

/// "What's coming up?": the next scheduled posts and when each goes out, without opening the app.
struct ComingUpIntent: AppIntent {
    static let title: LocalizedStringResource = "What's Coming Up"
    static let description = IntentDescription("Hera tells you which approved posts are scheduled next, and when each one goes out.")
    static var supportedModes: IntentModes { .background }

    @Dependency private var model: AppModel

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let proposals = try await model.latestProposalsForSiri()
        let answer = SiriAnswers.comingUp(SiriAnswers.upcoming(in: proposals), now: .now)
        return .result(dialog: "\(answer)")
    }
}

extension AppModel {
    /// The proposals as the server has them now, for a spoken answer. Throws a plain error when
    /// the person isn't signed in or the server can't be reached.
    func latestProposalsForSiri() async throws -> [Proposal] {
        guard client != nil else { throw HeraIntentError.notSignedIn }
        await refreshProposals()
        if let errorMessage { throw HeraIntentError.unreachable(errorMessage) }
        return proposals
    }
}

/// What Siri says, worked out from the proposals so it can be tested without Siri.
enum SiriAnswers {
    /// A scheduled post, by what it is and when it goes out.
    struct Upcoming: Equatable {
        let summary: String
        let at: Date
    }

    /// How many items to read out; the rest are counted.
    static let readOut = 3

    /// The summaries of everything waiting for approval, in the server's order.
    static func waiting(in proposals: [Proposal]) -> [String] {
        proposals.filter(\.isPending).map(\.summary)
    }

    /// Approved posts waiting for their time, soonest first.
    static func upcoming(in proposals: [Proposal]) -> [Upcoming] {
        proposals.filter(\.isScheduled)
            .compactMap { p in p.postAt.map { Upcoming(summary: p.summary, at: $0) } }
            .sorted { $0.at < $1.at }
    }

    /// "2 things are waiting for your approval: the open house post and the vase listing."
    static func approvals(_ summaries: [String]) -> String {
        let named = summaries.prefix(readOut).map(clean)
        switch summaries.count {
        case 0: return "Nothing is waiting for your approval."
        case 1: return "One thing is waiting for your approval: \(named[0])."
        case 2...readOut: return "\(summaries.count) things are waiting for your approval: \(spokenList(named))."
        default: return "\(summaries.count) things are waiting for your approval. The first three are \(spokenList(named))."
        }
    }

    /// "One post is coming up. The open house post goes out Fri, Nov 21 at 9:00 AM."
    static func comingUp(_ posts: [Upcoming], now: Date) -> String {
        let named = posts.prefix(readOut).map { post in
            post.at <= now ? "\(clean(post.summary)) is going out now." : "\(clean(post.summary)) goes out \(HeraTime.spoken(post.at))."
        }.joined(separator: " ")
        switch posts.count {
        case 0: return "Nothing is scheduled to go out."
        case 1: return "One post is coming up. \(named)"
        case 2...readOut: return "\(posts.count) posts are coming up. \(named)"
        default: return "\(posts.count) posts are coming up. The next three: \(named)"
        }
    }

    /// "a", "a and b", "a, b and c".
    private static func spokenList(_ items: [String]) -> String {
        guard let last = items.last else { return "" }
        if items.count == 1 { return last }
        return items.dropLast().joined(separator: ", ") + " and " + last
    }

    /// A summary as part of a sentence: no stray spaces, and no full stop of its own.
    private static func clean(_ summary: String) -> String {
        var text = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix(".") { text.removeLast() }
        return text.isEmpty ? "an untitled item" : text
    }
}
