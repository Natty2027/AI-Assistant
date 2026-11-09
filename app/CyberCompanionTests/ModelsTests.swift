import Foundation
import Testing
@testable import CyberCompanion

/// The app's side of the server contract: decoding real response shapes, and the platform rules
/// the app mirrors from server/agent/policy.ts.
struct ModelsTests {
    @Test func decodesAnAssistantRun() throws {
        let json = """
        {
          "status": "done",
          "text": "Your site is ready to review.",
          "tainted": false,
          "drafts": [
            { "id": "d_1", "connectionId": null, "platform": "instagram", "text": "Spring class!",
              "link": null, "sponsored": false,
              "problems": [{ "id": "needs_media", "level": "warn", "message": "Add an image." }] }
          ],
          "proposals": [
            { "id": "p1", "kind": "site.deploy", "label": "Publish a website", "summary": "Publish Clay Corner",
              "payload": { "connectionId": "c1", "siteId": "u-abc", "contentHash": "ff" },
              "payloadHash": "abc123", "checks": [], "tainted": false, "status": "pending",
              "expiresAt": "2026-11-08T00:00:00.000Z", "result": null, "canBeCarriedOut": true }
          ]
        }
        """
        let run = try JSONDecoder().decode(AgentRunResponse.self, from: Data(json.utf8))
        #expect(run.drafts.first?.isForSharing == true)
        #expect(run.drafts.first?.knownPlatform == .instagram)
        #expect(run.proposals.first?.isSite == true)
        #expect(run.proposals.first?.isPending == true)
        #expect(run.needsAnswer == false)
    }

    @Test func readsAPostProposalsTextAndRequiredConfirmations() throws {
        let json = """
        { "id": "p2", "kind": "social.post", "label": "Publish a social post", "summary": "Announce",
          "payload": { "connectionId": "c2", "text": "Guaranteed fun!", "link": "https://example.com", "sponsored": false, "mediaRefs": [] },
          "payloadHash": "h", "tainted": true, "status": "pending", "expiresAt": "x", "result": null, "canBeCarriedOut": true,
          "checks": [{ "id": "claims", "level": "attest", "message": "Back it up." }, { "id": "mentions", "level": "warn", "message": "m" }] }
        """
        let p = try JSONDecoder().decode(Proposal.self, from: Data(json.utf8))
        #expect(p.postText == "Guaranteed fun!")
        #expect(p.postLink == "https://example.com")
        #expect(p.requiredAttestations.map(\.id) == ["claims"])
        #expect(p.isBlocked == false)
    }

    @Test func blueskyAndXAppendALinkTheTextLacks() {
        #expect(Platform.bluesky.composedText("Kiln day", link: "https://e.com") == "Kiln day\n\nhttps://e.com")
        #expect(Platform.bluesky.composedText("See https://e.com", link: "https://e.com") == "See https://e.com")
        #expect(Platform.x.composedText("Kiln day", link: "https://e.com") == "Kiln day\n\nhttps://e.com")
        #expect(Platform.facebook.composedText("Kiln day", link: "https://e.com") == "Kiln day")
    }

    /// X counts every link as 23 characters, however long (measured() in policy.ts).
    @Test func xCountsALinkAs23Characters() {
        let link = "https://claycorner.example/" + String(repeating: "a", count: 200)
        #expect(Platform.x.measuredLength(of: "Hi \(link)") == 3 + 23)
    }

    /// Memory: the id that continues a task, and the facts Hera remembers.
    @Test func readsConversationIdAndMemories() throws {
        let run = try JSONDecoder().decode(AgentRunResponse.self, from: Data(#"{"status":"needs_user","text":"What time?","proposals":[],"drafts":[],"tainted":false,"conversationId":"0b8a3c1e-6a59-4f4e-9d38-3f1f5e0c2a11"}"#.utf8))
        #expect(run.conversationId == "0b8a3c1e-6a59-4f4e-9d38-3f1f5e0c2a11")
        #expect(run.needsAnswer)
        let old = try JSONDecoder().decode(AgentRunResponse.self, from: Data(#"{"status":"done","text":"","proposals":[],"drafts":[],"tainted":false}"#.utf8))
        #expect(old.conversationId == nil, "older servers leave it out")
        let memories = try JSONDecoder().decode(MemoriesResponse.self, from: Data(#"{"memories":[{"id":"m1","text":"Open Tue–Sat","createdAt":"2026-11-08T00:00:00.000Z"}]}"#.utf8))
        #expect(memories.memories.map(\.text) == ["Open Tue–Sat"])
    }

    @Test func readsWhichSignInsTheServerOffers() throws {
        let json = #"{ "connections": [], "signIn": { "x": true, "meta": false } }"#
        let out = try JSONDecoder().decode(ConnectionsResponse.self, from: Data(json.utf8))
        #expect(out.signIn?.isAvailable(.x) == true)
        #expect(out.signIn?.isAvailable(.meta) == false)
        // Servers from before sign-in existed leave it out.
        let old = try JSONDecoder().decode(ConnectionsResponse.self, from: Data(#"{ "connections": [] }"#.utf8))
        #expect(old.signIn == nil)
    }

    @Test func blueskyCountsEmojiAsOneCharacter() {
        let text = String(repeating: "🌱", count: 300)
        #expect(Platform.bluesky.measuredLength(of: text) == 300)
        #expect(Platform.x.measuredLength(of: text) == 600)
    }

    @Test(arguments: Platform.allCases)
    func limitsMatchTheServer(platform: Platform) {
        let server: [Platform: Int] = [.x: 280, .instagram: 2200, .linkedin: 3000, .facebook: 5000, .bluesky: 300]
        #expect(platform.characterLimit == server[platform])
    }

    /// The server accepts exactly these (AGENT_MODES in server/agent/loop.ts).
    @Test func createModesMatchTheServer() throws {
        #expect(CreateMode.allCases.map(\.rawValue) == ["site", "posts", "schedule"])
        let body = try JSONEncoder().encode(["mode": CreateMode.posts])
        #expect(String(decoding: body, as: UTF8.self) == #"{"mode":"posts"}"#)
    }

    @Test func previewServesFilesWithTheRightTypes() {
        #expect(SiteSchemeHandler.mimeType(for: "index.html") == "text/html")
        #expect(SiteSchemeHandler.mimeType(for: "css/site.css") == "text/css")
        #expect(SiteSchemeHandler.mimeType(for: "logo.SVG") == "image/svg+xml")
    }

    // The address rules are tested on ServerAddress directly: once AppConfig.serverURL is set for
    // release, AppModel ignores whatever is typed into Settings, so it can't show them.
    @Test func onlySecureOrLocalServersAreAccepted() {
        #expect(ServerAddress.normalize("http://api.example.com") == nil)
        #expect(ServerAddress.normalize("https://api.example.com") != nil)
        #expect(ServerAddress.normalize("http://localhost:8787") != nil)
    }

    @Test @MainActor func noClientWithoutATokenOrSignIn() {
        let model = AppModel()
        let original = (model.serverURLString, model.accessToken)
        defer { model.saveSettings(serverURL: original.0, accessToken: original.1) }

        model.saveSettings(serverURL: "https://api.example.com", accessToken: "t")
        #expect(model.client != nil)
        model.saveSettings(serverURL: "https://api.example.com", accessToken: "")
        #expect(model.client == nil)
    }
}
