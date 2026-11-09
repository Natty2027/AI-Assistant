import Foundation

/// The types the server sends back. Field names follow server/agent/service.ts and server/routes.ts.

/// A rule result. `block` stops approval, `attest` needs the person to confirm a fact, `warn` is shown only.
struct Check: Codable, Hashable, Identifiable, Sendable {
    enum Level: String, Codable, Sendable {
        case block, attest, warn
    }

    let id: String
    let level: Level
    let message: String
}

/// Platforms the assistant can write for. Mirrors PLATFORMS and TEXT_LIMITS in server/agent/policy.ts.
enum Platform: String, Codable, CaseIterable, Identifiable, Sendable {
    case x, instagram, linkedin, facebook, bluesky

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .x: "X"
        case .instagram: "Instagram"
        case .linkedin: "LinkedIn"
        case .facebook: "Facebook"
        case .bluesky: "Bluesky"
        }
    }

    var characterLimit: Int {
        switch self {
        case .x: 280
        case .instagram: 2200
        case .linkedin: 3000
        case .facebook: 5000
        case .bluesky: 300
        }
    }

    var systemImage: String {
        switch self {
        case .x: "xmark"
        case .instagram: "camera"
        case .linkedin: "briefcase"
        case .facebook: "person.2"
        case .bluesky: "cloud"
        }
    }

    /// The text exactly as it will appear. Bluesky and X have no separate link field, so the server
    /// appends a link the text doesn't already contain (composedPostText in policy.ts).
    func composedText(_ text: String, link: String?) -> String {
        guard self == .bluesky || self == .x, let link, !link.isEmpty, !text.contains(link) else { return text }
        return "\(text)\n\n\(link)"
    }

    /// Counted the way the platform counts: graphemes for Bluesky, every link as 23 characters on
    /// X, UTF-16 units elsewhere.
    func measuredLength(of text: String) -> Int {
        switch self {
        case .bluesky: text.count
        case .x: text.replacing(/https?:\/\/\S+/, with: String(repeating: "x", count: 23)).utf16.count
        default: text.utf16.count
        }
    }
}

/// A post the assistant wrote. With a `connectionId` it waits for approval in Review; without one
/// it's content for the person to share themselves.
struct Draft: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let connectionId: String?
    let platform: String?
    let text: String
    let link: String?
    let sponsored: Bool
    let problems: [Check]

    var knownPlatform: Platform? { platform.flatMap(Platform.init(rawValue:)) }
    var isForSharing: Bool { connectionId == nil }

    /// What to copy or hand to the share sheet.
    var shareableText: String {
        if let knownPlatform { return knownPlatform.composedText(text, link: link) }
        guard let link, !link.isEmpty, !text.contains(link) else { return text }
        return "\(text)\n\n\(link)"
    }
}

/// Any JSON value. Proposal payloads differ by kind, so they're decoded loosely and read by key.
enum JSONValue: Codable, Hashable, Sendable {
    case string(String), number(Double), bool(Bool), array([JSONValue]), object([String: JSONValue]), null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }

    var stringValue: String? {
        if case .string(let v) = self { return v }
        return nil
    }
}

struct Proposal: Codable, Hashable, Identifiable, Sendable {
    struct Outcome: Codable, Hashable, Sendable {
        let ok: Bool
        let ref: String?
        let detail: String
    }

    let id: String
    let kind: String
    let label: String
    let summary: String
    let payload: [String: JSONValue]
    let payloadHash: String
    let checks: [Check]
    let tainted: Bool
    let status: String
    let expiresAt: String
    let result: Outcome?
    let canBeCarriedOut: Bool

    var isPost: Bool { kind == "social.post" }
    var isSite: Bool { kind == "site.deploy" }
    var isPending: Bool { status == "pending" }
    var postText: String? { payload["text"]?.stringValue }
    var postLink: String? { payload["link"]?.stringValue }

    /// The facts the person must confirm before the server will accept an approval.
    var requiredAttestations: [Check] { checks.filter { $0.level == .attest } }
    var isBlocked: Bool { status == "blocked" || checks.contains { $0.level == .block } }
}

/// What one assistant run is for. Website, posts and schedule are separate runs; the server
/// enforces it, so a website run can't write posts and a posts run can't change the site.
enum CreateMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case site
    case posts
    /// The person's calendar and reminders, read and changed on their device.
    case schedule
    /// Launch Kit: one request, and the website page, posts, calendar and email are all made ready.
    case launch

    /// Modes that can carry a photo for posts.
    var takesPhoto: Bool { self == .posts || self == .launch }

    var id: Self { self }

    var title: String {
        switch self {
        case .site: "Website"
        case .posts: "Posts"
        case .schedule: "Schedule"
        case .launch: "Launch"
        }
    }

    var systemImage: String {
        switch self {
        case .site: "globe"
        case .posts: "text.bubble"
        case .schedule: "calendar"
        case .launch: "sparkles"
        }
    }
}

/// One change to the person's calendar or reminders that Hera proposed (server/agent/schedule.ts).
/// The app makes it, on this device, only when the person approves it. Times are ISO 8601 with an
/// offset, or a day (2026-11-09) for all-day events. Fields not used by a kind are nil.
struct ScheduleChange: Codable, Hashable, Identifiable, Sendable {
    enum Kind: String, Codable, Sendable {
        case addEvent = "add_event"
        case changeEvent = "change_event"
        case cancelEvent = "cancel_event"
        case addReminder = "add_reminder"
        case completeReminder = "complete_reminder"
    }

    let id: String
    let kind: Kind
    let summary: String
    var title: String?
    var start: String?
    var end: String?
    var allDay: Bool?
    var location: String?
    var notes: String?
    var calendar: String?
    var eventId: String?
    var eventTitle: String?
    var due: String?
    var list: String?
    var reminderId: String?
    var reminderTitle: String?

    var systemImage: String {
        switch kind {
        case .addEvent: "calendar.badge.plus"
        case .changeEvent: "calendar.badge.clock"
        case .cancelEvent: "calendar.badge.minus"
        case .addReminder: "checklist"
        case .completeReminder: "checkmark.circle"
        }
    }
}

struct AgentRunResponse: Codable, Hashable, Sendable {
    let status: String
    let text: String
    let proposals: [Proposal]
    let drafts: [Draft]
    /// Schedule runs only; absent from servers that predate it.
    var scheduleChanges: [ScheduleChange]?
    let tainted: Bool
    /// Emails Hera wrote for the person to send from their own email app. Absent from older servers.
    var emailDrafts: [EmailDraft]?
    /// Send with the next reply to continue this task. nil when it can't be continued (or from
    /// servers that predate it).
    var conversationId: String?

    var needsAnswer: Bool { status == "needs_user" }
}

struct Connection: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let kind: String
    let provider: String
    let platform: String?
    let label: String
    let publishesTo: String?
}

struct SiteFile: Codable, Hashable, Identifiable, Sendable {
    let path: String
    let bytes: Int
    var id: String { path }
}

struct SiteResponse: Codable, Hashable, Sendable {
    let files: [SiteFile]
    let checks: [Check]
    let contentHash: String
}

/* ---------------- envelopes ---------------- */

struct ConnectionsResponse: Decodable, Sendable {
    let connections: [Connection]
    /// Which platform sign-ins the server has set up. Absent on servers from before they existed.
    let signIn: SignInAvailability?
}

/// Platforms connected by signing in on the platform's own page (OAuth), rather than with a token.
enum SignInProvider: String, Codable, Identifiable, Sendable {
    /// X (Twitter).
    case x
    /// One Meta sign-in covers a Facebook Page and the Instagram account linked to it.
    case meta
    var id: Self { self }
}

struct SignInAvailability: Codable, Hashable, Sendable {
    let x: Bool
    let meta: Bool

    static let none = SignInAvailability(x: false, meta: false)

    func isAvailable(_ provider: SignInProvider) -> Bool {
        switch provider {
        case .x: x
        case .meta: meta
        }
    }
}

struct SignInStartResponse: Decodable, Sendable { let authUrl: String }
struct PhotoUploadResponse: Decodable, Sendable { let id: String }
struct ConnectionResponse: Decodable, Sendable { let connection: Connection }
struct ProposalsResponse: Decodable, Sendable { let proposals: [Proposal] }

/// An email Hera wrote (server/agent/loop.ts). She never sends it: the person edits it here and
/// sends it from their email app.
struct EmailDraft: Codable, Hashable, Identifiable, Sendable {
    let id: String
    var to: [String]
    var cc: [String]
    var subject: String
    var body: String
}

/// One lasting fact Hera remembers about the person (server/agent/memory.ts).
struct Memory: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let text: String
    let createdAt: String
}

struct MemoriesResponse: Decodable, Sendable { let memories: [Memory] }
struct MemoryAddResponse: Decodable, Sendable { let memory: Memory?; let message: String }
struct ProposalResponse: Decodable, Sendable { let proposal: Proposal }
struct FileResponse: Decodable, Sendable { let contents: String }
struct ConsentResponse: Decodable, Sendable { let granted: Bool }
struct OKResponse: Decodable, Sendable { let ok: Bool }

struct ApprovalResponse: Decodable, Sendable {
    let token: String
    let expiresAt: String

    enum CodingKeys: String, CodingKey {
        case token
        case expiresAt = "expires_at"
    }
}

struct ServerErrorBody: Decodable, Sendable {
    let error: String
    let code: String?
    let requestId: String?
}
