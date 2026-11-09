import Foundation
import Testing
@testable import CyberCompanion

/// Emails Hera writes open in the person's email app through a mailto: link. Everything must
/// arrive intact: characters like & = + # in the text can't cut it off or change it.
struct EmailTests {
    private func fields(_ url: URL) -> [String: String] {
        let query = url.absoluteString.split(separator: "?", maxSplits: 1).last.map(String.init) ?? ""
        return Dictionary(uniqueKeysWithValues: query.split(separator: "&").map { pair in
            let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
            return (kv[0], kv.count > 1 ? (kv[1].removingPercentEncoding ?? "") : "")
        })
    }

    @Test func everythingArrivesIntact() throws {
        let draft = EmailDraft(id: "e1", to: ["sam@example.com", "jo+studio@example.com"], cc: ["clay@example.com"],
                               subject: "Class & kiln = fun? #1",
                               body: "Hi Sam,\nPrices: $20 + tax. Café opens at 10.\n\n— Nat")
        let url = try #require(MailLink.url(for: draft))
        #expect(url.scheme == "mailto")
        #expect(url.absoluteString.hasPrefix("mailto:sam@example.com,jo+studio@example.com?"))
        let f = fields(url)
        #expect(f["cc"] == "clay@example.com")
        #expect(f["subject"] == "Class & kiln = fun? #1")
        #expect(f["body"] == "Hi Sam,\r\nPrices: $20 + tax. Café opens at 10.\r\n\r\n— Nat", "line breaks become CRLF, nothing is lost")
    }

    @Test func anEmailWithoutARecipientStillOpens() throws {
        let url = try #require(MailLink.url(for: EmailDraft(id: "e2", to: [], cc: [], subject: "Hi", body: "Hello")))
        #expect(url.absoluteString == "mailto:?subject=Hi&body=Hello")
    }

    @Test func readsEmailDraftsFromTheServer() throws {
        let json = #"{"status":"done","text":"Here it is.","proposals":[],"drafts":[],"tainted":false,"emailDrafts":[{"id":"e_1","to":["sam@example.com"],"cc":[],"subject":"Saturday","body":"See you at 10."}]}"#
        let run = try JSONDecoder().decode(AgentRunResponse.self, from: Data(json.utf8))
        #expect(run.emailDrafts?.first?.to == ["sam@example.com"])
    }
}
