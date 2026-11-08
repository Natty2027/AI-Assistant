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

    @Test func blueskyAppendsALinkTheTextLacks() {
        #expect(Platform.bluesky.composedText("Kiln day", link: "https://e.com") == "Kiln day\n\nhttps://e.com")
        #expect(Platform.bluesky.composedText("See https://e.com", link: "https://e.com") == "See https://e.com")
        #expect(Platform.x.composedText("Kiln day", link: "https://e.com") == "Kiln day")
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

    @Test func previewServesFilesWithTheRightTypes() {
        #expect(SiteSchemeHandler.mimeType(for: "index.html") == "text/html")
        #expect(SiteSchemeHandler.mimeType(for: "css/site.css") == "text/css")
        #expect(SiteSchemeHandler.mimeType(for: "logo.SVG") == "image/svg+xml")
    }

    @Test @MainActor func onlySecureOrLocalServersAreAccepted() {
        let model = AppModel()
        let original = (model.serverURLString, model.accessToken)
        defer { model.saveSettings(serverURL: original.0, accessToken: original.1) }

        model.saveSettings(serverURL: "http://api.example.com", accessToken: "t")
        #expect(model.client == nil)
        model.saveSettings(serverURL: "https://api.example.com", accessToken: "t")
        #expect(model.client != nil)
        model.saveSettings(serverURL: "http://localhost:8787", accessToken: "t")
        #expect(model.client != nil)
        model.saveSettings(serverURL: "https://api.example.com", accessToken: "")
        #expect(model.client == nil)
    }
}
