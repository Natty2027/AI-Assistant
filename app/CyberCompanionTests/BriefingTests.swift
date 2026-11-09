import EventKit
import Foundation
import Testing
@testable import CyberCompanion

/// "Hi Hera, what's on my day?": the rundown Hera reads out, and how "Hi Hera" said into the orb
/// is understood.
struct BriefingTests {
    private let calendar = Calendar.current
    private var morning: Date { calendar.date(bySettingHour: 8, minute: 30, second: 0, of: .now)! }
    private func at(_ hour: Int, _ minute: Int = 0) -> Date { calendar.date(bySettingHour: hour, minute: minute, second: 0, of: morning)! }

    @Test func readsWhatsAheadRemindersAndApprovals() {
        let agenda = DayAgenda(
            events: [
                .init(title: "Early run", start: at(6), end: at(7), allDay: false),          // over: not read
                .init(title: "Team meeting", start: at(10), end: at(11), allDay: false),
                .init(title: "Mom's birthday", start: at(0), end: at(23, 59), allDay: true),
                .init(title: "Lunch with Sam", start: at(12), end: at(13), allDay: false),
            ],
            reminders: [.init(title: "Call the bank", due: at(9)), .init(title: "Buy flowers", due: nil)])
        let text = DayBriefing.text(for: agenda, pendingApprovals: 2, now: morning)
        #expect(text.hasPrefix("Good morning!"))
        #expect(!text.contains("Early run"), "events that are over aren't read out")
        #expect(text.contains("3 things on your calendar today: Mom's birthday, all day, Team meeting at"))
        #expect(text.contains("2 reminders are due: Call the bank and Buy flowers."))
        #expect(text.contains("2 items are waiting for your approval"))
    }

    @Test func aClearDaySaysSoAndLongListsAreShortened() {
        #expect(DayBriefing.text(for: DayAgenda(events: [], reminders: []), pendingApprovals: 0, now: morning)
                == "Good morning! Your calendar is clear for the rest of today.")
        let many = (0..<8).map { DayAgenda.Event(title: "Meeting \($0)", start: at(9 + $0), end: at(9 + $0, 30), allDay: false) }
        let text = DayBriefing.text(for: DayAgenda(events: many, reminders: []), pendingApprovals: 1, now: morning)
        #expect(text.contains("and 3 more"))
        #expect(!text.contains("Meeting 7"))
        #expect(text.contains("One item is waiting"))
    }

    @Test func hiHeraIsUnderstood() {
        #expect(HeraGreeting.interpret("Hi Hera") == .conversation)
        #expect(HeraGreeting.interpret("hey hera!") == .conversation)
        #expect(HeraGreeting.interpret("Hi Hera, what's on my day?") == .briefing)
        #expect(HeraGreeting.interpret("Hello Hera what does my day look like") == .briefing)
        #expect(HeraGreeting.interpret("what's on my day") == .briefing)
        #expect(HeraGreeting.interpret("Hi Hera, make a website for my bakery") == .request("Make a website for my bakery"))
        #expect(HeraGreeting.interpret("Write posts about my class") == .request("Write posts about my class"))
    }

    /// The widget decodes its own copy of this (HeraToday/HeraToday.swift); the names must match.
    @Test func widgetDataKeepsTheWidgetsFieldNames() throws {
        let data = TodayWidgetData(updated: .now, calendarAllowed: true,
                                   events: [.init(title: "Gym", start: .now, end: .now, allDay: false)],
                                   remindersDue: 1, pendingApprovals: 2)
        let json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(data)) as? [String: Any])
        #expect(Set(json.keys) == ["updated", "calendarAllowed", "events", "remindersDue", "pendingApprovals"])
        let event = try #require((json["events"] as? [[String: Any]])?.first)
        #expect(Set(event.keys) == ["title", "start", "end", "allDay"])
    }

    /// Today's agenda read from a real calendar: an event added for later today shows up.
    @Test(.enabled(if: EKEventStore.authorizationStatus(for: .event) == .fullAccess, "needs calendar access granted to the test host"))
    @MainActor func todayComesFromTheCalendar() async throws {
        let manager = ScheduleManager()
        let title = "Hera today \(UUID().uuidString.prefix(8))"
        let start = Calendar.current.date(bySettingHour: 23, minute: 0, second: 0, of: .now)!
        let undo = try await manager.apply(ScheduleChange(id: "t", kind: .addEvent, summary: "Add", title: title,
                                                          start: ScheduleManager.format(start), end: ScheduleManager.format(start.addingTimeInterval(1800)), allDay: false))
        let agenda = try await manager.today()
        #expect(agenda.events.contains { $0.title == title })
        try await manager.undo(undo)
    }
}
