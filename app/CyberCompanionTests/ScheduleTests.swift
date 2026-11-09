import EventKit
import Foundation
import Testing
@testable import CyberCompanion

/// Schedule: the contract with the server (field names, time formats, the reply) and, where
/// calendar access is granted (`xcrun simctl privacy booted grant calendar com.natty2027.hera`),
/// real changes to a real calendar on this device.
struct ScheduleTests {
    /// The API client sends snake_case; server/agent/schedule.ts expects exactly these keys.
    @Test func snapshotIsSentWithTheServersFieldNames() throws {
        let snapshot = ScheduleSnapshot(
            now: "2026-11-09T09:00:00-08:00", timeZone: "America/Los_Angeles",
            events: [.init(id: "e|1", title: "Dentist", start: "2026-11-10T14:00:00-08:00", end: "2026-11-10T15:00:00-08:00",
                           allDay: false, calendar: "Home", location: nil)],
            reminders: [.init(id: "r1", title: "Call Mom", due: nil, list: "Reminders")],
            calendars: [.init(name: "Home", writable: true, isDefault: true)])
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        let json = try #require(String(data: try encoder.encode(snapshot), encoding: .utf8))
        #expect(json.contains("\"time_zone\""))
        #expect(json.contains("\"all_day\""))
        #expect(json.contains("\"is_default\""))
        #expect(!json.contains("timeZone"))
    }

    @Test func readsTheServersProposedChanges() throws {
        let json = """
        { "status": "done", "text": "Here you go.", "proposals": [], "drafts": [], "tainted": false,
          "scheduleChanges": [
            { "id": "s_1", "kind": "change_event", "summary": "Move the dentist", "eventId": "e|1", "eventTitle": "Dentist",
              "title": null, "start": "2026-11-13T15:00:00-08:00", "end": null, "location": null },
            { "id": "s_2", "kind": "add_reminder", "summary": "Buy flowers", "title": "Buy flowers", "due": null, "notes": null, "list": null }
          ] }
        """
        let run = try JSONDecoder().decode(AgentRunResponse.self, from: Data(json.utf8))
        #expect(run.scheduleChanges?.map(\.kind) == [.changeEvent, .addReminder])
        // Older servers leave the field out.
        let old = try JSONDecoder().decode(AgentRunResponse.self, from: Data(#"{"status":"done","text":"","proposals":[],"drafts":[],"tainted":false}"#.utf8))
        #expect(old.scheduleChanges == nil)
    }

    @Test func timesRoundTripInTheServersFormat() throws {
        let now = Date(timeIntervalSince1970: 1_794_000_000)
        let text = ScheduleManager.format(now)
        #expect(text.wholeMatch(of: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})/) != nil, "server's DATE_TIME pattern")
        #expect(ScheduleManager.parse(text, allDay: false) == now)
        // Without seconds, and with fractional seconds, as a model may write them.
        #expect(ScheduleManager.parse("2026-11-09T15:00-08:00", allDay: false) == ScheduleManager.parse("2026-11-09T15:00:00-08:00", allDay: false))
        #expect(ScheduleManager.parse("2026-11-09T15:00:00.000Z", allDay: false) != nil)
        #expect(ScheduleManager.parse("2026-11-09", allDay: true) == Calendar.current.date(from: DateComponents(year: 2026, month: 11, day: 9)))
        #expect(ScheduleManager.parse("tomorrow", allDay: false) == nil)
    }

    @Test func talkToHeraHearsScheduleRequests() {
        #expect(ConversationReply.mode(from: "my schedule please") == .schedule)
        #expect(ConversationReply.mode(from: "move my dentist appointment") == .schedule)
        #expect(ConversationReply.mode(from: "remind me to call mom") == .schedule)
        #expect(ConversationReply.mode(from: "posts about my calendar") == nil, "two things at once: ask again")
    }

    /// Reminders on a real device list: add one, see it in the snapshot (EventKit hands reminders
    /// back on a background queue), then complete it.
    @Test(.enabled(if: EKEventStore.authorizationStatus(for: .reminder) == .fullAccess, "needs reminders access granted to the test host"))
    @MainActor func remindersAreReadAddedAndCompleted() async throws {
        let manager = ScheduleManager()
        let title = "Hera reminder \(UUID().uuidString.prefix(8))"
        try await manager.apply(ScheduleChange(id: "r1", kind: .addReminder, summary: "Add", title: title,
                                               due: ScheduleManager.format(.now.addingTimeInterval(86_400))))
        let snapshot = try await manager.snapshot()
        let added = try #require(snapshot.reminders.first { $0.title == title }, "the new reminder is in the next snapshot")
        #expect(added.due != nil)
        try await manager.apply(ScheduleChange(id: "r2", kind: .completeReminder, summary: "Done", reminderId: added.id))
        let after = try await manager.snapshot()
        #expect(!after.reminders.contains { $0.title == title }, "completed reminders aren't open any more")
    }

    /// The whole device side, on a real calendar: add, find in the snapshot, move, delete.
    @Test(.enabled(if: EKEventStore.authorizationStatus(for: .event) == .fullAccess, "needs calendar access granted to the test host"))
    @MainActor func approvedChangesAreMadeInTheCalendar() async throws {
        let manager = ScheduleManager()
        let title = "Hera test \(UUID().uuidString.prefix(8))"
        let start = Calendar.current.date(byAdding: .day, value: 2, to: Calendar.current.startOfDay(for: .now))!.addingTimeInterval(10 * 3600)

        try await manager.apply(ScheduleChange(id: "a", kind: .addEvent, summary: "Add", title: title,
                                               start: ScheduleManager.format(start), end: ScheduleManager.format(start.addingTimeInterval(3600)),
                                               allDay: false))
        var snapshot = try await manager.snapshot()
        let added = try #require(snapshot.events.first { $0.title == title }, "the new event is in the next snapshot")
        #expect(ScheduleManager.parse(added.start, allDay: false) == start)

        // Move it two hours later by its start only: it keeps its one-hour length.
        let later = start.addingTimeInterval(2 * 3600)
        try await manager.apply(ScheduleChange(id: "b", kind: .changeEvent, summary: "Move", start: ScheduleManager.format(later), eventId: added.id))
        snapshot = try await manager.snapshot()
        let moved = try #require(snapshot.events.first { $0.title == title })
        #expect(ScheduleManager.parse(moved.start, allDay: false) == later)
        #expect(ScheduleManager.parse(moved.end, allDay: false) == later.addingTimeInterval(3600))

        try await manager.apply(ScheduleChange(id: "c", kind: .cancelEvent, summary: "Delete", eventId: moved.id))
        snapshot = try await manager.snapshot()
        #expect(!snapshot.events.contains { $0.title == title }, "deleted")
        await #expect(throws: ScheduleManager.ScheduleError.self) {
            try await manager.apply(ScheduleChange(id: "d", kind: .cancelEvent, summary: "Again", eventId: moved.id))
        }
    }
}
