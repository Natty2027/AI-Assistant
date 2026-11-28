import Foundation
import Testing
@testable import CyberCompanion

/// Outlook: the compose link that opens an email in the Outlook app, the choice of app, the server's
/// Outlook connection and sign-in, and an email proposal as the approval screen reads it.
struct OutlookTests {
    /// The query's fields, decoded the way Outlook decodes them.
    private func fields(_ url: URL) -> [String: String] {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQueryItems ?? []
        return Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value?.removingPercentEncoding ?? "") })
    }

    @Test func theComposeLinkCarriesEverythingIntact() throws {
        let draft = EmailDraft(id: "e1", to: ["sam@example.com", "jo+studio@example.com"], cc: ["clay@example.com"],
                               subject: "Class & kiln = fun? #1",
                               body: "Hi Sam,\r\nPrices: $20 + tax. Café opens at 10.\n\n— Nat")
        let url = try #require(OutlookLink.url(for: draft))
        #expect(url.scheme == "ms-outlook")
        #expect(url.host() == "compose")
        #expect(url.absoluteString.hasPrefix("ms-outlook://compose?to=sam@example.com,jo%2Bstudio@example.com&cc=clay@example.com&subject="))
        let f = fields(url)
        #expect(f["to"] == "sam@example.com,jo+studio@example.com")
        #expect(f["cc"] == "clay@example.com")
        #expect(f["subject"] == "Class & kiln = fun? #1", "& = ? # can't cut the subject off")
        #expect(f["body"] == "Hi Sam,\nPrices: $20 + tax. Café opens at 10.\n\n— Nat")
        #expect(!url.absoluteString.contains(" "))
    }

    @Test func emptyPartsAreLeftOut() throws {
        let url = try #require(OutlookLink.url(for: EmailDraft(id: "e2", to: [" "], cc: [], subject: "Hi", body: "Hello")))
        #expect(url.absoluteString == "ms-outlook://compose?subject=Hi&body=Hello")
        #expect(OutlookLink.url(for: EmailDraft(id: "e3", to: [], cc: [], subject: "", body: ""))?.absoluteString == "ms-outlook://compose")
    }

    @Test func eachAppOpensItsOwnLink() throws {
        let draft = EmailDraft(id: "e4", to: ["sam@example.com"], cc: [], subject: "Hi", body: "Hello")
        #expect(EmailApp.mail.url(for: draft)?.scheme == "mailto")
        #expect(EmailApp.outlook.url(for: draft)?.scheme == "ms-outlook")
    }

    @MainActor @Test func mailIsTheDefaultChoice() throws {
        let defaults = try #require(UserDefaults(suiteName: "OutlookTests"))
        defaults.removePersistentDomain(forName: "OutlookTests")
        #expect(EmailApp.preferred(defaults) == .mail)
        defaults.set("mail", forKey: EmailApp.preferenceKey)
        #expect(EmailApp.preferred(defaults) == .mail)
        // Outlook is chosen only while it's installed; otherwise Mail it is.
        defaults.set("outlook", forKey: EmailApp.preferenceKey)
        #expect(EmailApp.preferred(defaults) == (OutlookApp.isInstalled ? .outlook : .mail))
    }

    @Test func readsTheOutlookConnectionAndWhetherItsOffered() throws {
        let json = #"{ "connections": [{ "id": "c1", "kind": "email", "provider": "outlook", "platform": null, "label": "Outlook (nat@contoso.com)", "readInbox": true }], "signIn": { "x": false, "meta": false, "ebay": false, "outlook": true } }"#
        let out = try JSONDecoder().decode(ConnectionsResponse.self, from: Data(json.utf8))
        #expect(out.connections.first?.isOutlook == true)
        #expect(out.connections.first?.readInbox == true)
        #expect(out.signIn?.isAvailable(.outlook) == true)
        // A server from before Outlook doesn't offer it.
        let old = try JSONDecoder().decode(SignInAvailability.self, from: Data(#"{ "x": true, "meta": true }"#.utf8))
        #expect(old.isAvailable(.outlook) == false)
    }

    @Test func readsTheSignInPageTheServerSends() throws {
        // The server answers auth_url.
        let out = try JSONDecoder().decode(SignInStartResponse.self, from: Data(#"{ "auth_url": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1" }"#.utf8))
        #expect(out.authUrl.hasPrefix("https://login.microsoftonline.com/"))
        let camel = try JSONDecoder().decode(SignInStartResponse.self, from: Data(#"{ "authUrl": "https://x.com/i/oauth2/authorize" }"#.utf8))
        #expect(camel.authUrl == "https://x.com/i/oauth2/authorize")
    }

    @Test func anEmailProposalShowsExactlyWhatWillBeSent() throws {
        let json = """
        { "id": "p1", "kind": "email.send", "label": "Send an email", "summary": "Email to sam@example.com: Saturday",
          "payload": { "connectionId": "c1", "to": ["sam@example.com"], "cc": ["jo@example.com"], "subject": "Saturday",
                       "body": "See you at 10.", "invite": { "fileName": "invite.ics", "ics": "BEGIN:VCALENDAR" } },
          "payloadHash": "abc", "checks": [], "tainted": true, "status": "pending",
          "expiresAt": "2026-11-28T00:00:00.000Z", "result": null, "canBeCarriedOut": true }
        """
        let p = try JSONDecoder().decode(Proposal.self, from: Data(json.utf8))
        #expect(p.isEmail && !p.isPost && !p.isListing)
        #expect(p.emailTo == ["sam@example.com"])
        #expect(p.emailCc == ["jo@example.com"])
        #expect(p.emailSubject == "Saturday")
        #expect(p.emailBody == "See you at 10.")
        #expect(p.emailInviteName == "invite.ics")
        #expect(p.postAt == nil, "an email goes as soon as it's approved")
    }
}
