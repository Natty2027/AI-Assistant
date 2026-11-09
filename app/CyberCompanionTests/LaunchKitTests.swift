import Foundation
import Testing
@testable import CyberCompanion

/// Launch Kit: the overview of what one request made ready, and asking for a launch by voice.
struct LaunchKitTests {
    private func run(_ json: String) throws -> AgentRunResponse {
        try JSONDecoder().decode(AgentRunResponse.self, from: Data(json.utf8))
    }

    @Test func overviewListsEverythingTheLaunchMadeReady() throws {
        let launch = try run("""
        { "status": "done", "text": "Ready.", "tainted": false,
          "proposals": [
            { "id": "p1", "kind": "site.deploy", "label": "Publish a website", "summary": "Publish the page", "payload": {}, "payloadHash": "h1",
              "checks": [], "tainted": false, "status": "pending", "expiresAt": "x", "result": null, "canBeCarriedOut": true },
            { "id": "p2", "kind": "social.post", "label": "Publish a social post", "summary": "Bluesky", "payload": {}, "payloadHash": "h2",
              "checks": [], "tainted": false, "status": "pending", "expiresAt": "x", "result": null, "canBeCarriedOut": true }
          ],
          "drafts": [{ "id": "d1", "connectionId": null, "platform": "instagram", "text": "Workshop!", "link": null, "sponsored": false, "problems": [] }],
          "scheduleChanges": [
            { "id": "s1", "kind": "add_event", "summary": "Add the workshop" },
            { "id": "s2", "kind": "add_reminder", "summary": "Countdown" },
            { "id": "s3", "kind": "add_reminder", "summary": "Buy clay" }
          ],
          "emailDrafts": [{ "id": "e1", "to": [], "cc": [], "subject": "Workshop", "body": "Join us." }] }
        """)
        let kit = try #require(LaunchKitSummary(run: launch))
        #expect(kit.items.map(\.text) == [
            "Website ready to publish", "A post ready to approve", "A post to share yourself",
            "A calendar change", "2 reminders", "An email to send",
        ])
    }

    @Test func aSingleKindOfResultHasNoOverview() throws {
        let posts = try run(#"{"status":"done","text":"","tainted":false,"proposals":[],"drafts":[],"emailDrafts":[{"id":"e1","to":[],"cc":[],"subject":"s","body":"b"}]}"#)
        #expect(LaunchKitSummary(run: posts) == nil)
    }

    @Test func talkToHeraHearsALaunch() {
        #expect(ConversationReply.mode(from: "a full launch please") == .launch)
        #expect(ConversationReply.mode(from: "launch my workshop with posts and a website") == .launch)
        #expect(ConversationReply.mode(from: "just the website") == .site)
    }
}
