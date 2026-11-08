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

    /// The text exactly as it will appear. Bluesky has no separate link field, so the server appends
    /// a link the text doesn't already contain (composedPostText in policy.ts).
    func composedText(_ text: String, link: String?) -> String {
        guard self == .bluesky, let link, !link.isEmpty, !text.contains(link) else { return text }
        return "\(text)\n\n\(link)"
    }

    /// Counted the way the platform counts: graphemes for Bluesky, UTF-16 units elsewhere.
    func measuredLength(of text: String) -> Int {
        self == .bluesky ? text.count : text.utf16.count
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

/// What one assistant run is for. Building the website and writing posts are separate runs; the
/// server enforces it, so a website run can't write posts and a posts run can't change the site.
enum CreateMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case site
    case posts

    var id: Self { self }
    var title: String { self == .site ? "Website" : "Posts" }
    var systemImage: String { self == .site ? "globe" : "text.bubble" }
}

struct AgentRunResponse: Codable, Hashable, Sendable {
    let status: String
    let text: String
    let proposals: [Proposal]
    let drafts: [Draft]
    let tainted: Bool

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

struct ConnectionsResponse: Decodable, Sendable { let connections: [Connection] }
struct ConnectionResponse: Decodable, Sendable { let connection: Connection }
struct ProposalsResponse: Decodable, Sendable { let proposals: [Proposal] }
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
