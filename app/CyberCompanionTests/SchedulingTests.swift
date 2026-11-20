import Foundation
import Testing
@testable import CyberCompanion

struct SchedulingTests {
    @Test func aScheduledPostReadsItsTime() throws {
        let json = #"""
        {"id":"p1","kind":"social.post","label":"Publish a social post","summary":"Saturday reminder",
         "payload":{"connectionId":"x1","text":"Open house tomorrow!","link":null,"sponsored":false,"mediaRefs":[],"postAt":"2026-11-21T09:00:00-08:00"},
         "payloadHash":"h","checks":[],"tainted":false,"status":"scheduled","expiresAt":"2026-11-20T00:00:00Z","result":null,
         "canBeCarriedOut":true,"scheduledFor":"2026-11-21T17:00:00.000Z"}
        """#
        let p = try JSONDecoder().decode(Proposal.self, from: Data(json.utf8))
        #expect(p.isScheduled && !p.isPending)
        #expect(p.postAt == Date(timeIntervalSince1970: 1_795_280_400))
    }

    @Test func anEmailCarriesItsInviteAndReminderTime() throws {
        let json = #"""
        {"id":"e1","to":[],"cc":[],"subject":"Open house Saturday","body":"Join us!","sendAt":"2026-11-20T09:00:00-08:00",
         "invite":{"title":"Open House","start":"2026-11-22T10:00:00-08:00","end":"2026-11-22T14:00:00-08:00","location":"Clay Corner","ics":"BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"}}
        """#
        let email = try JSONDecoder().decode(EmailDraft.self, from: Data(json.utf8))
        let invite = try #require(email.invite)
        #expect(InviteFile(invite: invite).fileName == "Open House.ics")
        #expect(String(decoding: InviteFile(invite: invite).data, as: UTF8.self).hasPrefix("BEGIN:VCALENDAR"))
        #expect(email.sendAt.flatMap(HeraTime.parse) != nil)
        #expect(EmailReminders.spoken(for: email) == "It's time to send your email: Open house Saturday.")
    }

    @Test func olderEmailsWithoutTheNewFieldsStillRead() throws {
        let email = try JSONDecoder().decode(EmailDraft.self, from: Data(#"{"id":"e1","to":[],"cc":[],"subject":"Hi","body":"Hello"}"#.utf8))
        #expect(email.invite == nil && email.sendAt == nil)
    }

    @Test func theDeviceClockIsSentWithItsOffset() {
        let pacific = TimeZone(identifier: "America/Los_Angeles")!
        #expect(HeraTime.nowWithOffset(Date(timeIntervalSince1970: 1_795_280_400), timeZone: pacific) == "2026-11-21T09:00:00-08:00")
    }
}
