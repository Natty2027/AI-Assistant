import EventKit
import Foundation
import WidgetKit

/// What the Today widget shows, saved by the app into the App Group the widget shares. A widget
/// can't ask for calendar access itself, so the app writes this whenever it has fresh numbers:
/// at launch, when it comes back to the foreground, and after approvals and calendar changes.
///
/// The widget's copy of this type is in HeraToday/HeraToday.swift; the JSON shape must match.
struct TodayWidgetData: Codable, Equatable, Sendable {
    nonisolated static let appGroup = "group.com.natty2027.hera"
    nonisolated static let key = "todayWidget"
    nonisolated static let widgetKind = "HeraToday"

    var updated: Date
    /// False until the person has allowed calendar access; the widget then says how to.
    var calendarAllowed: Bool
    var events: [DayAgenda.Event]
    var remindersDue: Int
    var pendingApprovals: Int

    func save() {
        guard let defaults = UserDefaults(suiteName: Self.appGroup), let data = try? JSONEncoder().encode(self) else { return }
        if defaults.data(forKey: Self.key) == data { return }  // nothing changed: don't wake the widget
        defaults.set(data, forKey: Self.key)
        WidgetCenter.shared.reloadTimelines(ofKind: Self.widgetKind)
    }

    static func load() -> TodayWidgetData? {
        guard let data = UserDefaults(suiteName: appGroup)?.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(TodayWidgetData.self, from: data)
    }
}

extension AppModel {
    /// Refreshes the widget's copy of today. Never asks for calendar access: if it hasn't been
    /// given yet, the widget just shows the approvals count and how to turn the calendar on.
    func refreshWidget() async {
        let allowed = EKEventStore.authorizationStatus(for: .event) == .fullAccess
        let agenda = allowed ? (try? await schedule.today()) : nil
        TodayWidgetData(updated: .now, calendarAllowed: allowed,
                        events: agenda?.events ?? [], remindersDue: agenda?.reminders.count ?? 0,
                        pendingApprovals: pendingCount).save()
    }
}
