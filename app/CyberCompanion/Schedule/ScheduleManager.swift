import EventKit
import Foundation

/// The person's calendar and reminders, through EventKit. Hera sees whatever calendars are on this
/// device: iCloud, and any Google, Outlook/Microsoft 365 or Exchange accounts added in Settings
/// (on a Mac, in System Settings → Internet Accounts).
///
/// Two jobs only:
///   - `snapshot()` reads the next few weeks of events and the open reminders, to send with one
///     Schedule request. Nothing is kept on the server.
///   - `apply(_:)` makes one change Hera proposed, after the person approves it on screen.
@MainActor
final class ScheduleManager {
    /// How far ahead Hera can see. Long enough for "next week" and "before the end of the month".
    nonisolated static let daysAhead = 31

    private let store = EKEventStore()

    struct ScheduleError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /* ---------------- access ---------------- */

    /// Asks once for calendar and reminders access (the system shows its own prompt the first
    /// time). Calendar access is required; reminders are optional.
    private func requestAccess() async throws {
        let events = (try? await store.requestFullAccessToEvents()) ?? false
        guard events else {
            throw ScheduleError(message: "Hera needs access to your calendar for Schedule. Turn it on in Settings → Apps → Hera → Calendars.")
        }
        _ = try? await store.requestFullAccessToReminders()
    }

    private var remindersAllowed: Bool { EKEventStore.authorizationStatus(for: .reminder) == .fullAccess }

    /* ---------------- reading ---------------- */

    /// What's on the person's calendar from the start of today, and their open reminders.
    func snapshot(now: Date = .now) async throws -> ScheduleSnapshot {
        try await requestAccess()
        let calendar = Calendar.current
        let start = calendar.startOfDay(for: now)
        let end = calendar.date(byAdding: .day, value: Self.daysAhead, to: start) ?? now
        let eventCalendars = store.calendars(for: .event)
        let names = Self.displayNames(for: eventCalendars)
        let defaultCalendar = store.defaultCalendarForNewEvents

        let events = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: nil))
            .sorted { $0.startDate < $1.startDate }
            .prefix(400)
            .compactMap { e -> ScheduleSnapshot.Event? in
                guard let id = Self.occurrenceID(e) else { return nil }
                return .init(id: id, title: String((e.title ?? "").prefix(300)), start: Self.format(e.startDate), end: Self.format(e.endDate),
                             allDay: e.isAllDay, calendar: String((names[e.calendar.calendarIdentifier] ?? e.calendar.title).prefix(200)),
                             location: e.location.map { String($0.prefix(300)) })
            }

        var reminders: [ScheduleSnapshot.Reminder] = []
        if remindersAllowed {
            let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
            reminders = await withCheckedContinuation { done in
                store.fetchReminders(matching: predicate) { found in
                    // Copied to plain values here: EventKit objects stay on EventKit's side.
                    let plain = (found ?? []).prefix(200).map { r in
                        ScheduleSnapshot.Reminder(id: r.calendarItemIdentifier, title: String((r.title ?? "").prefix(300)),
                                                  due: r.dueDateComponents.flatMap { Calendar.current.date(from: $0) }.map(ScheduleManager.format),
                                                  list: String((r.calendar?.title ?? "Reminders").prefix(200)))
                    }
                    done.resume(returning: Array(plain))
                }
            }
        }

        return ScheduleSnapshot(
            now: Self.format(now),
            timeZone: TimeZone.current.identifier,
            events: Array(events),
            reminders: reminders,
            calendars: eventCalendars.map {
.init(name: String((names[$0.calendarIdentifier] ?? $0.title).prefix(200)), writable: $0.allowsContentModifications,
                      isDefault: $0.calendarIdentifier == defaultCalendar?.calendarIdentifier)
            })
    }

    /// Calendar names as Hera sees them. Two accounts can both have a calendar called "Calendar",
    /// so repeated names get their account added: "Calendar (Gmail)".
    private static func displayNames(for calendars: [EKCalendar]) -> [String: String] {
        let counts = Dictionary(calendars.map { ($0.title, 1) }, uniquingKeysWith: +)
        return Dictionary(uniqueKeysWithValues: calendars.map { c in
            (c.calendarIdentifier, counts[c.title, default: 0] > 1 ? "\(c.title) (\(c.source?.title ?? "Other"))" : c.title)
        })
    }

    /// A repeating event shares one identifier across all its occurrences, so each occurrence is
    /// named by the event and the date it falls on. Changes then touch only that occurrence.
    private static func occurrenceID(_ event: EKEvent) -> String? {
        guard let id = event.eventIdentifier else { return nil }
        return "\(id)|\(Int((event.occurrenceDate ?? event.startDate).timeIntervalSince1970))"
    }

    private func calendar(named name: String?) -> EKCalendar? {
        guard let name else { return store.defaultCalendarForNewEvents }
        let calendars = store.calendars(for: .event)
        let names = Self.displayNames(for: calendars)
        return calendars.first { names[$0.calendarIdentifier] == name && $0.allowsContentModifications }
    }

    private func occurrence(_ id: String) throws -> EKEvent {
        let parts = id.split(separator: "|")
        guard parts.count == 2, let seconds = TimeInterval(parts[1]) else { throw ScheduleError(message: "That event couldn't be found.") }
        let date = Date(timeIntervalSince1970: seconds)
        let window = store.predicateForEvents(withStart: date.addingTimeInterval(-86_400), end: date.addingTimeInterval(86_400), calendars: nil)
        guard let event = store.events(matching: window).first(where: { Self.occurrenceID($0) == id }) else {
            throw ScheduleError(message: "That event is no longer on your calendar.")
        }
        return event
    }

    /* ---------------- changing ---------------- */

    /// Makes one approved change. Each is saved on its own, so one failure leaves the rest as they were.
    func apply(_ change: ScheduleChange) async throws {
        try await requestAccess()
        switch change.kind {
        case .addEvent:
            guard let title = change.title, let start = change.start, let end = change.end else { throw Self.incomplete }
            let event = EKEvent(eventStore: store)
            event.title = title
            try Self.setTimes(of: event, start: start, end: end, allDay: change.allDay ?? false)
            event.location = change.location
            event.notes = change.notes
            guard let calendar = calendar(named: change.calendar) else {
                throw ScheduleError(message: "The calendar \"\(change.calendar ?? "")\" isn't available to change.")
            }
            event.calendar = calendar
            try store.save(event, span: .thisEvent, commit: true)

        case .changeEvent:
            guard let id = change.eventId else { throw Self.incomplete }
            let event = try occurrence(id)
            guard event.calendar.allowsContentModifications else { throw Self.readOnly }
            if let title = change.title { event.title = title }
            if let location = change.location { event.location = location }
            if change.start != nil || change.end != nil {
                let start = change.start ?? (event.isAllDay ? Self.dayString(event.startDate) : Self.format(event.startDate))
                // Moving only the start keeps the event's length.
                let end = change.end ?? (event.isAllDay
                    ? Self.dayString(Self.parse(start, allDay: true).map { $0.addingTimeInterval(event.endDate.timeIntervalSince(event.startDate)) } ?? event.endDate)
                    : Self.parse(start, allDay: false).map { Self.format($0.addingTimeInterval(event.endDate.timeIntervalSince(event.startDate))) } ?? Self.format(event.endDate))
                try Self.setTimes(of: event, start: start, end: end, allDay: event.isAllDay && start.count == 10)
            }
            try store.save(event, span: .thisEvent, commit: true)

        case .cancelEvent:
            guard let id = change.eventId else { throw Self.incomplete }
            let event = try occurrence(id)
            guard event.calendar.allowsContentModifications else { throw Self.readOnly }
            try store.remove(event, span: .thisEvent, commit: true)

        case .addReminder:
            guard remindersAllowed else {
                throw ScheduleError(message: "Hera needs access to your reminders for this. Turn it on in Settings → Apps → Hera → Reminders.")
            }
            guard let title = change.title else { throw Self.incomplete }
            let reminder = EKReminder(eventStore: store)
            reminder.title = title
            reminder.notes = change.notes
            reminder.calendar = store.calendars(for: .reminder).first { $0.title == change.list && $0.allowsContentModifications }
                ?? store.defaultCalendarForNewReminders()
            if let due = change.due {
                guard let date = Self.parse(due, allDay: false) else { throw ScheduleError(message: "That reminder's time couldn't be read.") }
                reminder.dueDateComponents = Calendar.current.dateComponents(in: .current, from: date)
                // A due time alone doesn't notify; an alarm does.
                reminder.addAlarm(EKAlarm(absoluteDate: date))
            }
            try store.save(reminder, commit: true)

        case .completeReminder:
            guard let id = change.reminderId, let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else {
                throw ScheduleError(message: "That reminder is no longer in your list.")
            }
            reminder.isCompleted = true
            try store.save(reminder, commit: true)
        }
    }

    private static let incomplete = ScheduleError(message: "This change was missing details, so it wasn't made.")
    private static let readOnly = ScheduleError(message: "That event is on a calendar you can't change, such as one shared with you.")

    /* ---------------- dates ---------------- */

    private static func setTimes(of event: EKEvent, start: String, end: String, allDay: Bool) throws {
        guard let startDate = parse(start, allDay: allDay), let endDate = parse(end, allDay: allDay) else {
            throw ScheduleError(message: "The time for this change couldn't be read.")
        }
        event.isAllDay = allDay
        event.startDate = startDate
        // For all-day events the end is the last day; EventKit treats it as the whole day.
        event.endDate = endDate
    }

    /// A date and time with the device's offset, e.g. 2026-11-09T15:00:00-08:00.
    nonisolated static func format(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = .current
        return formatter.string(from: date)
    }

    nonisolated static func dayString(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// Reads what the server sends: a day for all-day events, otherwise a date and time with an
    /// offset (seconds optional).
    nonisolated static func parse(_ text: String, allDay: Bool) -> Date? {
        if text.count == 10 {
            let parts = text.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3 else { return nil }
            return Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
        }
        guard !allDay else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date }
        // "2026-11-09T15:00-08:00": add the seconds the formatter wants.
        if let t = text.firstIndex(of: "T"), text[t...].count >= 6 {
            let withSeconds = text.prefix(upTo: text.index(t, offsetBy: 6)) + ":00" + text[text.index(t, offsetBy: 6)...]
            formatter.formatOptions = [.withInternetDateTime]
            return formatter.date(from: String(withSeconds))
        }
        return nil
    }
}

/// What's sent with a Schedule request (ScheduleSnapshot in server/agent/schedule.ts). The API
/// client encodes keys as snake_case, which is what the server expects.
struct ScheduleSnapshot: Encodable, Sendable {
    struct Event: Encodable, Sendable {
        let id: String
        let title: String
        let start: String
        let end: String
        let allDay: Bool
        let calendar: String
        let location: String?
    }

    struct Reminder: Encodable, Sendable {
        let id: String
        let title: String
        let due: String?
        let list: String
    }

    struct CalendarInfo: Encodable, Sendable {
        let name: String
        let writable: Bool
        let isDefault: Bool
    }

    let now: String
    let timeZone: String
    let events: [Event]
    let reminders: [Reminder]
    let calendars: [CalendarInfo]
}
