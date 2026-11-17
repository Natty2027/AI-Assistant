import Foundation
import Testing
@testable import CyberCompanion

struct TextMessageTests {
    @Test func readsTextDraftsFromTheServer() throws {
        let json = """
        {"status":"done","text":"Here's your text.","tainted":false,"drafts":[],"proposals":[],
         "textDrafts":[{"id":"t1","to":[{"name":"Sarah","number":null},{"name":null,"number":"+1 555 010 2030"}],
                        "body":"Running late, bringing the cake!"}]}
        """
        let run = try JSONDecoder().decode(AgentRunResponse.self, from: Data(json.utf8))
        let text = try #require(run.textDrafts?.first)
        #expect(text.to.count == 2)
        #expect(text.to[0].name == "Sarah")
        #expect(text.to[1].number == "+1 555 010 2030")
    }

    @Test func theMessagesLinkCarriesOnlyNumbersAndTheWholeText() throws {
        let url = try #require(MessageLink.url(to: ["+1 (555) 010-2030", "555&body=evil"], body: "Fish & chips at 7? #yes"))
        let text = url.absoluteString
        #expect(text.hasPrefix("sms:/open?addresses=+15550102030,555&body="))
        #expect(!text.contains("evil"), "a number can't add its own fields")
        #expect(text.hasSuffix("Fish%20%26%20chips%20at%207%3F%20%23yes"), "& and # can't cut the text short")
    }

    @Test func mobileNumbersComeFirst() {
        let sorted = ContactLookup.sorted([
            .init(name: "Sarah Jones", number: "1", label: "home"),
            .init(name: "Sarah Jones", number: "2", label: "mobile"),
        ])
        #expect(sorted.first?.number == "2")
    }

    @Test func aSharedTextIsPickedUpOnceAndStaleOnesAreDropped() {
        _ = SharedTexts.takeLatest()  // start empty
        let now = Date()
        SharedTexts.add("old one", now: now.addingTimeInterval(-2 * 24 * 3600))
        #expect(SharedTexts.takeLatest(now: now) == nil, "older than a day: not read out of the blue")

        SharedTexts.add("first", now: now.addingTimeInterval(-60))
        SharedTexts.add("Can you do 7 instead of 6?", now: now)
        #expect(SharedTexts.takeLatest(now: now) == "Can you do 7 instead of 6?")
        #expect(SharedTexts.takeLatest(now: now) == nil, "picked up once")
    }
}
