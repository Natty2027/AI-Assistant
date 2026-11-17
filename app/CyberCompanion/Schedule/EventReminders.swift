import CryptoKit
import EventKit
import Foundation
import Observation
import UserNotifications
#if os(iOS)
import BackgroundTasks
#endif

/// One timed event coming up, as plain values.
struct UpcomingEvent: Equatable, Sendable {
    let id: String
    let title: String
    let start: Date
    let location: String?
}

/// One reminder to schedule: what the alert says, what Hera says, and when.
struct EventReminder: Equatable, Sendable {
    let id: String
    let fireDate: Date
    let title: String
    let body: String
    let spoken: String
}

/// Turns upcoming events into reminders. Plain values only, so it's easy to test.
enum EventReminderPlanner {
    nonisolated static let idPrefix = "hera.event."

    /// A reminder `leadMinutes` before each event, soonest first. Events too close to warn about
    /// ahead of time are skipped.
    static func plan(_ events: [UpcomingEvent], leadMinutes: Int, now: Date = .now, limit: Int) -> [EventReminder] {
        let reminders = events.sorted { $0.start < $1.start }.compactMap { event -> EventReminder? in
            let fire = event.start.addingTimeInterval(-Double(leadMinutes) * 60)
            guard fire > now else { return nil }
            return reminder(for: event, leadMinutes: leadMinutes, fireDate: fire)
        }
        return Array(reminders.prefix(limit))
    }

    static func reminder(for event: UpcomingEvent, leadMinutes: Int, fireDate: Date) -> EventReminder {
        let title = clean(event.title, limit: 80) ?? "Your event"
        let time = event.start.formatted(date: .omitted, time: .shortened)
        let lead = leadPhrase(leadMinutes)
        // A video-call link in the location is read as "online", not spelled out.
        let online = event.location?.contains("://") == true
        let place = online ? nil : clean(event.location, limit: 80)

        var body = "\(title) starts at \(time), in \(lead)."
        if let place { body += " At \(place)." } else if online { body += " Online." }

        var spoken = "Hi, it's Hera. \(title) starts in \(lead), at \(time)"
        if let place { spoken += ", at \(place)" } else if online { spoken += ", online" }
        spoken += "."

        return EventReminder(id: idPrefix + "\(event.id)|\(leadMinutes)", fireDate: fireDate,
                             title: "Coming up: \(title)", body: body, spoken: spoken)
    }

    /// "5 minutes", "1 hour", "2 hours".
    static func leadPhrase(_ minutes: Int) -> String {
        switch minutes {
        case 60: "1 hour"
        case let m where m > 60 && m % 60 == 0: "\(m / 60) hours"
        case 1: "1 minute"
        default: "\(minutes) minutes"
        }
    }

    /// The recording's file name follows what it says, so an unchanged reminder reuses its clip.
    static func clipName(for spoken: String) -> String {
        let digest = SHA256.hash(data: Data(spoken.utf8)).prefix(10).map { String(format: "%02x", $0) }.joined()
        return "hera-\(digest).caf"
    }

    /// Calendar text can come from anyone who sends an invitation: kept to one short line.
    private static func clean(_ text: String?, limit: Int) -> String? {
        guard let text else { return nil }
        let line = text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        guard !line.isEmpty else { return nil }
        return line.count > limit ? String(line.prefix(limit - 1)) + "…" : line
    }
}

/// Hera's reminders before calendar events: an alert on the phone a set time before each event,
/// with Hera's own voice saying what it is and when.
///
/// Everything happens on this device. Hera reads the calendar, schedules local notifications and
/// records each spoken reminder ahead of time into Library/Sounds, so the system plays it with the
/// alert even when the app is closed. While the app is open she says it live instead.
///
/// Kept up to date whenever the calendar changes, the app opens, and (on iPhone and iPad) every
/// few hours in the background, so events added in other apps get reminders too.
@MainActor
@Observable
final class EventReminders {
    nonisolated static let enabledKey = "eventReminders"
    nonisolated static let leadKey = "reminderLeadMinutes"
    nonisolated static let spokenKey = "spokenReminders"
    nonisolated static let leadChoices = [5, 10, 15, 30, 60]
    nonisolated static let refreshTaskID = "com.natty2027.hera.reminders"

    /// How far ahead reminders are scheduled.
    static let daysAhead = 7
    /// The system keeps at most 64 waiting notifications per app; this leaves room to spare.
    static let maxReminders = 40
    /// Recordings are made for the soonest reminders; later ones get theirs on a later update.
    static let maxClips = 12

    enum Status: Equatable {
        case unknown, on, off, notificationsDenied, noCalendar
    }

    private(set) var status: Status = .unknown
    private var isUpdating = false
    private var updateAgain = false

    nonisolated static var isEnabled: Bool { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }
    nonisolated static var leadMinutes: Int {
        let value = UserDefaults.standard.integer(forKey: leadKey)
        return leadChoices.contains(value) ? value : 15
    }
    nonisolated static var speaks: Bool { UserDefaults.standard.object(forKey: spokenKey) as? Bool ?? true }

    private static var soundsFolder: URL { URL.libraryDirectory.appending(path: "Sounds", directoryHint: .isDirectory) }

    /// Brings the scheduled reminders in line with the calendar. Calls that arrive while an update
    /// is running are folded into one more pass, since calendar changes come in bursts.
    /// `mayAsk`: whether the notification permission prompt may appear (not in the background).
    func update(schedule: ScheduleManager, voice: HeraVoice, mayAsk: Bool) async {
        if isUpdating { updateAgain = true; return }
        isUpdating = true
        defer { isUpdating = false }
        repeat {
            updateAgain = false
            await pass(schedule: schedule, voice: voice, mayAsk: mayAsk)
        } while updateAgain
    }

    private func pass(schedule: ScheduleManager, voice: HeraVoice, mayAsk: Bool) async {
        let center = UNUserNotificationCenter.current()
        guard Self.isEnabled, EKEventStore.authorizationStatus(for: .event) == .fullAccess else {
            await removeAll(center)
            status = Self.isEnabled ? .noCalendar : .off
            return
        }
        var settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined, mayAsk {
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
            settings = await center.notificationSettings()
        }
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
            status = .notificationsDenied
            return
        }
        status = .on

        let plans = EventReminderPlanner.plan(schedule.upcoming(days: Self.daysAhead), leadMinutes: Self.leadMinutes,
                                              limit: Self.maxReminders)
        let speaks = Self.speaks && HeraVoice.isAvailable
        let wanted = Set(plans.map(\.id))

        // First every reminder is scheduled, with its recording if it already has one, so a
        // background update that runs out of time still leaves every alert in place.
        let pending = await center.pendingNotificationRequests().filter { $0.identifier.hasPrefix(EventReminderPlanner.idPrefix) }
        let scheduled = Dictionary(pending.map { ($0.identifier, $0.content.userInfo["signature"] as? String ?? "") },
                                   uniquingKeysWith: { a, _ in a })
        center.removePendingNotificationRequests(withIdentifiers: scheduled.keys.filter { !wanted.contains($0) })
        for plan in plans {
            let clip = speaks ? existingClip(for: plan) : nil
            if scheduled[plan.id] != Self.signature(plan, clip: clip) {
                try? await center.add(Self.request(for: plan, clip: clip))
            }
        }

        // Then the missing recordings, soonest first, each swapped in as soon as it's made.
        if speaks {
            try? FileManager.default.createDirectory(at: Self.soundsFolder, withIntermediateDirectories: true)
            for plan in plans.prefix(Self.maxClips) where existingClip(for: plan) == nil {
                guard !Task.isCancelled, !updateAgain else { break }
                let name = EventReminderPlanner.clipName(for: plan.spoken)
                do {
                    try await voice.record(plan.spoken, to: Self.soundsFolder.appending(path: name))
                    try? await center.add(Self.request(for: plan, clip: name))
                } catch {
                    break  // Her voice isn't working right now; the alerts keep the standard sound.
                }
            }
        }

        // Recordings no reminder uses any more.
        let inUse = Set(plans.map { EventReminderPlanner.clipName(for: $0.spoken) })
        removeClips { !inUse.contains($0) }
    }

    private func existingClip(for plan: EventReminder) -> String? {
        let name = EventReminderPlanner.clipName(for: plan.spoken)
        return FileManager.default.fileExists(atPath: Self.soundsFolder.appending(path: name).path(percentEncoded: false)) ? name : nil
    }

    private func removeAll(_ center: UNUserNotificationCenter) async {
        let ours = await center.pendingNotificationRequests().map(\.identifier).filter { $0.hasPrefix(EventReminderPlanner.idPrefix) }
        center.removePendingNotificationRequests(withIdentifiers: ours)
        removeClips { _ in true }
    }

    private func removeClips(where shouldRemove: (String) -> Bool) {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: Self.soundsFolder.path(percentEncoded: false))) ?? []
        for name in names where name.hasPrefix("hera-") && shouldRemove(name) {
            try? FileManager.default.removeItem(at: Self.soundsFolder.appending(path: name))
        }
    }

    /// Changes whenever anything the person would notice changes, so only those are rescheduled.
    private static func signature(_ plan: EventReminder, clip: String?) -> String {
        "\(Int(plan.fireDate.timeIntervalSince1970))|\(plan.title)|\(plan.body)|\(clip ?? "default")"
    }

    private static func request(for plan: EventReminder, clip: String?) -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = plan.title
        content.body = plan.body
        content.sound = clip.map { UNNotificationSound(named: UNNotificationSoundName($0)) } ?? .default
        // Shown through most Focus modes: a reminder that arrives after the event is no use.
        content.interruptionLevel = .timeSensitive
        content.threadIdentifier = "hera.events"
        content.userInfo = ["spoken": plan.spoken, "signature": signature(plan, clip: clip)]
        let when = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: plan.fireDate)
        return UNNotificationRequest(identifier: plan.id, content: content,
                                     trigger: UNCalendarNotificationTrigger(dateMatching: when, repeats: false))
    }

    /// Asks the system to wake the app in a few hours to pick up events added elsewhere. The
    /// system decides when, if at all; opening the app always brings reminders up to date.
    nonisolated static func scheduleBackgroundUpdate() {
        #if os(iOS)
        let request = BGAppRefreshTaskRequest(identifier: refreshTaskID)
        request.earliestBeginDate = .now.addingTimeInterval(4 * 3600)
        try? BGTaskScheduler.shared.submit(request)
        #endif
    }
}

/// Receives Hera's reminders while the app is open (she says it live, instead of the recording)
/// and when the person taps one (she says it again).
final class ReminderDelivery: NSObject, UNUserNotificationCenterDelegate, Sendable {
    private let speak: @MainActor @Sendable (String) -> Void

    init(speak: @escaping @MainActor @Sendable (String) -> Void) {
        self.speak = speak
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        guard notification.request.identifier.hasPrefix(EventReminderPlanner.idPrefix),
              EventReminders.speaks, let spoken = notification.request.content.userInfo["spoken"] as? String else {
            return [.banner, .list, .sound]
        }
        await speak(spoken)
        return [.banner, .list]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              response.notification.request.identifier.hasPrefix(EventReminderPlanner.idPrefix),
              let spoken = response.notification.request.content.userInfo["spoken"] as? String else { return }
        await speak(spoken)
    }
}
