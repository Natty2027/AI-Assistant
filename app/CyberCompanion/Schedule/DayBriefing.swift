import Foundation

/// Today, as plain values: what's left on the calendar and the reminders that are due. Built on
/// the device from EventKit; also what the Today widget shows.
struct DayAgenda: Codable, Equatable, Sendable {
    struct Event: Codable, Equatable, Sendable {
        let title: String
        let start: Date
        let end: Date
        let allDay: Bool
    }

    struct Reminder: Codable, Equatable, Sendable {
        let title: String
        /// nil when it has no due time; overdue ones are included too.
        let due: Date?
    }

    var events: [Event]
    var reminders: [Reminder]
}

/// "Hi Hera, what's on my day?": a short spoken rundown. Made on the device from the calendar and
/// the approvals waiting, so it's instant and nothing about the schedule is sent anywhere.
enum DayBriefing {
    /// At most this many items are read out of each list; the rest are counted.
    static let maxItems = 5

    static func text(for agenda: DayAgenda, pendingApprovals: Int, now: Date = .now, calendar: Calendar = .current) -> String {
        var parts = [greeting(now, calendar: calendar)]

        // What's still ahead today: timed events that haven't ended, and all-day events.
        let ahead = agenda.events.filter { $0.allDay || $0.end > now }.sorted { ($0.allDay ? 0 : 1, $0.start) < ($1.allDay ? 0 : 1, $1.start) }
        if ahead.isEmpty {
            parts.append("Your calendar is clear for the rest of today.")
        } else {
            let items = ahead.prefix(maxItems).map { event in
                if event.allDay { return "\(event.title), all day" }
                let at = event.start.formatted(date: .omitted, time: .shortened)
                return event.start <= now ? "\(event.title), happening now" : "\(event.title) at \(at)"
            }
            let more = ahead.count > maxItems ? ", and \(ahead.count - maxItems) more" : ""
            let count = ahead.count == 1 ? "one thing" : "\(ahead.count) things"
            parts.append("You have \(count) on your calendar today: \(list(items))\(more).")
        }

        if !agenda.reminders.isEmpty {
            let items = agenda.reminders.prefix(maxItems).map(\.title)
            let more = agenda.reminders.count > maxItems ? ", and \(agenda.reminders.count - maxItems) more" : ""
            let lead = agenda.reminders.count == 1 ? "One reminder is due" : "\(agenda.reminders.count) reminders are due"
            parts.append("\(lead): \(list(Array(items)))\(more).")
        }

        switch pendingApprovals {
        case 0: break
        case 1: parts.append("One item is waiting for your approval in Review.")
        default: parts.append("\(pendingApprovals) items are waiting for your approval in Review.")
        }
        return parts.joined(separator: " ")
    }

    private static func greeting(_ now: Date, calendar: Calendar) -> String {
        switch calendar.component(.hour, from: now) {
        case 5..<12: "Good morning!"
        case 12..<17: "Good afternoon!"
        default: "Good evening!"
        }
    }

    /// "a", "a and b", "a, b, and c".
    private static func list(_ items: [String]) -> String {
        switch items.count {
        case 0: ""
        case 1: items[0]
        case 2: "\(items[0]) and \(items[1])"
        default: items.dropLast().joined(separator: ", ") + ", and " + items[items.count - 1]
        }
    }
}

/// "Hi Hera" said into the orb, inside the app: a greeting on its own starts the spoken
/// conversation, a greeting with "what's on my day" gives the briefing, and a greeting in front
/// of a request is dropped so the request reads cleanly.
enum HeraGreeting {
    enum Meaning: Equatable {
        case conversation
        case briefing
        case request(String)
    }

    private static let greetings = ["hi hera", "hey hera", "hello hera", "hiya hera", "ok hera", "okay hera"]
    private static let dayQuestions = ["on my day", "my day look", "on today", "my schedule today", "brief me", "my agenda", "what's today", "whats today", "today look"]

    static func interpret(_ said: String) -> Meaning {
        let trimmed = said.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = trimmed.lowercased()
        guard let greeting = greetings.first(where: { lower.hasPrefix($0) }) else {
            return isDayQuestion(lower) ? .briefing : .request(trimmed)
        }
        let rest = trimmed.dropFirst(greeting.count).trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
        if rest.isEmpty { return .conversation }
        if isDayQuestion(rest.lowercased()) { return .briefing }
        return .request(rest.prefix(1).uppercased() + rest.dropFirst())
    }

    private static func isDayQuestion(_ text: String) -> Bool {
        dayQuestions.contains { text.contains($0) } && text.count < 60
    }
}
