import SwiftUI
import WidgetKit

/// Hera's Today widget: what's left on the calendar today and what's waiting for approval.
///
/// A widget can't ask for calendar access, so it shows what the Hera app last saved into the
/// shared App Group (TodayWidgetData in the app). Its timeline steps past each event as it ends,
/// so finished events drop off without the app having to run.

/// The app's TodayWidgetData, as the widget reads it. Same JSON shape.
struct TodayData: Codable {
    struct Event: Codable, Hashable {
        let title: String
        let start: Date
        let end: Date
        let allDay: Bool
    }

    var updated: Date
    var calendarAllowed: Bool
    var events: [Event]
    var remindersDue: Int
    var pendingApprovals: Int

    static let appGroup = "group.com.natty2027.hera"
    static let key = "todayWidget"

    static func load() -> TodayData? {
        guard let data = UserDefaults(suiteName: appGroup)?.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(TodayData.self, from: data)
    }

    static let preview = TodayData(
        updated: .now, calendarAllowed: true,
        events: [
            .init(title: "Team meeting", start: .now.addingTimeInterval(3600), end: .now.addingTimeInterval(7200), allDay: false),
            .init(title: "Lunch with Sam", start: .now.addingTimeInterval(4 * 3600), end: .now.addingTimeInterval(5 * 3600), allDay: false),
            .init(title: "Gym", start: .now.addingTimeInterval(8 * 3600), end: .now.addingTimeInterval(9 * 3600), allDay: false),
        ],
        remindersDue: 2, pendingApprovals: 1)
}

struct TodayEntry: TimelineEntry {
    let date: Date
    /// nil until the app has been opened once.
    let data: TodayData?

    /// What's still ahead at this entry's time, all-day events first. Only today's: data saved
    /// yesterday doesn't describe today.
    var ahead: [TodayData.Event] {
        guard let data, Calendar.current.isDate(data.updated, inSameDayAs: date) else { return [] }
        return data.events.filter { $0.allDay || $0.end > date }.sorted { ($0.allDay ? 0 : 1, $0.start) < ($1.allDay ? 0 : 1, $1.start) }
    }

    var isStale: Bool { data.map { !Calendar.current.isDate($0.updated, inSameDayAs: date) } ?? true }
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> TodayEntry {
        TodayEntry(date: .now, data: .preview)
    }

    func getSnapshot(in context: Context, completion: @escaping (TodayEntry) -> Void) {
        completion(TodayEntry(date: .now, data: context.isPreview ? .preview : TodayData.load() ?? .preview))
    }

    /// One entry now and one as each of today's events ends, so the list stays current; then
    /// a fresh look at midnight, when "today" changes.
    func getTimeline(in context: Context, completion: @escaping (Timeline<TodayEntry>) -> Void) {
        let now = Date.now
        let data = TodayData.load()
        let midnight = Calendar.current.startOfDay(for: now).addingTimeInterval(86_400)
        let ends = (data?.events ?? []).filter { !$0.allDay && $0.end > now && $0.end < midnight }.map(\.end)
        let dates = [now] + Set(ends).sorted().prefix(20) + [midnight]
        completion(Timeline(entries: dates.map { TodayEntry(date: $0, data: data) }, policy: .atEnd))
    }
}

struct HeraTodayEntryView: View {
    var entry: TodayEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .accessoryRectangular: lockScreen
        case .systemSmall: small
        default: medium
        }
    }

    private var header: some View {
        HStack(spacing: 4) {
            Image(systemName: "sparkle")
            Text("Today")
            Spacer(minLength: 0)
            Text(entry.date, format: .dateTime.weekday(.abbreviated).day())
                .foregroundStyle(.secondary)
        }
        .font(.caption.weight(.semibold))
    }

    @ViewBuilder
    private var emptyMessage: some View {
        if entry.data == nil {
            Text("Open Hera to see your day here.")
        } else if entry.data?.calendarAllowed == false {
            Text("Allow Hera to use your calendar to see your day here.")
        } else if entry.isStale {
            Text("Open Hera to refresh today.")
        } else {
            Text("Nothing else on your calendar today.")
        }
    }

    private func row(_ event: TodayData.Event) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Group {
                if event.allDay { Text("All day") }
                else if event.start <= entry.date { Text("Now") }
                else { Text(event.start, format: .dateTime.hour().minute()) }
            }
            .font(.caption2.monospacedDigit())
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .frame(width: 62, alignment: .leading)
            Text(event.title).font(.caption).lineLimit(1)
        }
    }

    @ViewBuilder
    private var footer: some View {
        if let data = entry.data, !entry.isStale, data.remindersDue > 0 || data.pendingApprovals > 0 {
            HStack(spacing: 10) {
                if data.pendingApprovals > 0 {
                    Label("\(data.pendingApprovals) to approve", systemImage: "checkmark.seal")
                }
                if data.remindersDue > 0 {
                    Label("\(data.remindersDue) due", systemImage: "checklist")
                }
            }
            .font(.caption2.weight(.medium))
            .foregroundStyle(.tint)
            .lineLimit(1)
        }
    }

    private var small: some View {
        VStack(alignment: .leading, spacing: 6) {
            header
            if let next = entry.ahead.first {
                Text(next.title).font(.headline).lineLimit(2)
                Group {
                    if next.allDay { Text("All day") }
                    else if next.start <= entry.date { Text("Now, until \(next.end.formatted(date: .omitted, time: .shortened))") }
                    else { Text(next.start, style: .time) }
                }
                .font(.caption).foregroundStyle(.secondary)
                if entry.ahead.count > 1 {
                    Text("+\(entry.ahead.count - 1) more today").font(.caption2).foregroundStyle(.secondary)
                }
            } else {
                emptyMessage.font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            footer
        }
    }

    private var medium: some View {
        VStack(alignment: .leading, spacing: 6) {
            header
            if entry.ahead.isEmpty {
                emptyMessage.font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(entry.ahead.prefix(3), id: \.self) { event in row(event) }
                if entry.ahead.count > 3 {
                    Text("+\(entry.ahead.count - 3) more").font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            footer
        }
    }

    private var lockScreen: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let next = entry.ahead.first {
                Text(next.title).font(.headline).lineLimit(1)
                if next.allDay { Text("All day") } else { Text(next.start, style: .time) }
            } else {
                Text("Hera").font(.headline)
                Text("Clear for today")
            }
            if let approvals = entry.data?.pendingApprovals, approvals > 0, !entry.isStale {
                Text("\(approvals) to approve")
            }
        }
        .font(.caption)
    }
}

struct HeraToday: Widget {
    let kind: String = "HeraToday"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: Provider()) { entry in
            HeraTodayEntryView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Today with Hera")
        .description("What's left on your calendar today, and anything waiting for your approval.")
        #if os(iOS)
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
        #else
        .supportedFamilies([.systemSmall, .systemMedium])
        #endif
    }
}

#Preview(as: .systemSmall) {
    HeraToday()
} timeline: {
    TodayEntry(date: .now, data: .preview)
}

#Preview(as: .systemMedium) {
    HeraToday()
} timeline: {
    TodayEntry(date: .now, data: .preview)
    TodayEntry(date: .now, data: nil)
}
