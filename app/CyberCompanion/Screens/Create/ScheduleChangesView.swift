import SwiftUI

/// The calendar and reminder changes Hera proposed. Nothing changes until the person taps
/// Approve; then this device makes that one change. Skip leaves it undone.
struct ScheduleChangesView: View {
    let changes: [ScheduleChange]

    @Environment(AppModel.self) private var model

    private var pending: [ScheduleChange] { changes.filter { model.scheduleOutcomes[$0.id] == nil } }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel("Changes to your schedule")
            VStack(alignment: .leading, spacing: 16) {
                ForEach(changes) { change in
                    row(change)
                    if change.id != changes.last?.id { Divider() }
                }
                if pending.count > 1 {
                    Button {
                        Task { for change in pending { await model.approve(change) } }
                    } label: {
                        Label("Approve all \(pending.count)", systemImage: "checkmark.circle.fill")
                            .font(.body.weight(.semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glassProminent)
                    .controlSize(.large)
                }
                Text("Changes are made in your own calendar and reminders on this device, only when you approve them.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .glowCard()
        }
    }

    private func row(_ change: ScheduleChange) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                IconTile(systemImage: change.systemImage, size: 30)
                VStack(alignment: .leading, spacing: 3) {
                    Text(change.summary).font(.subheadline.weight(.semibold))
                    if let detail = Self.detail(of: change) {
                        Text(detail).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            outcome(of: change)
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func outcome(of change: ScheduleChange) -> some View {
        switch model.scheduleOutcomes[change.id] {
        case nil:
            HStack(spacing: 10) {
                Button(change.kind == .cancelEvent ? "Approve: delete it" : "Approve", systemImage: "checkmark") {
                    Task { await model.approve(change) }
                }
                .buttonStyle(.glassProminent)
                .tint(change.kind == .cancelEvent ? .red : nil)
                Button("Skip") { model.skip(change) }
                    .buttonStyle(.glass)
            }
            .controlSize(.small)
        case .working:
            ProgressView().controlSize(.small)
        case .done:
            Label("Done", systemImage: "checkmark.circle.fill")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.green)
        case .skipped:
            Label("Skipped", systemImage: "minus.circle")
                .font(.footnote)
                .foregroundStyle(.secondary)
        case .failed(let message):
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote)
                .foregroundStyle(.red)
        }
    }

    /// The exact what and when, under Hera's one-line summary.
    static func detail(of change: ScheduleChange) -> String? {
        switch change.kind {
        case .addEvent:
            return [change.title, when(change.start, change.end, allDay: change.allDay ?? false), change.calendar.map { "in \($0)" }]
                .compactMap { $0 }.joined(separator: " · ")
        case .changeEvent:
            var parts = [change.eventTitle.map { "“\($0)”" }]
            if let title = change.title { parts.append("rename to “\(title)”") }
            if change.start != nil || change.end != nil {
                parts.append(when(change.start, change.end, allDay: (change.start ?? change.end ?? "").count == 10).map { "to \($0)" })
            }
            if let location = change.location { parts.append("at \(location)") }
            return parts.compactMap { $0 }.joined(separator: " · ")
        case .cancelEvent:
            return [change.eventTitle.map { "“\($0)”" }, when(change.start, nil, allDay: false)].compactMap { $0 }.joined(separator: " · ")
        case .addReminder:
            return [change.title, change.due.flatMap { ScheduleManager.parse($0, allDay: false) }.map {
                "due " + $0.formatted(date: .abbreviated, time: .shortened)
            }].compactMap { $0 }.joined(separator: " · ")
        case .completeReminder:
            return change.reminderTitle.map { "“\($0)”" }
        }
    }

    private static func when(_ start: String?, _ end: String?, allDay: Bool) -> String? {
        guard let start, let from = ScheduleManager.parse(start, allDay: allDay) else { return nil }
        if allDay {
            let first = from.formatted(date: .abbreviated, time: .omitted)
            guard let end, let to = ScheduleManager.parse(end, allDay: true), to > from else { return "\(first), all day" }
            return "\(first) – \(to.formatted(date: .abbreviated, time: .omitted)), all day"
        }
        let begins = from.formatted(date: .abbreviated, time: .shortened)
        guard let end, let to = ScheduleManager.parse(end, allDay: false) else { return begins }
        let sameDay = Calendar.current.isDate(from, inSameDayAs: to)
        return "\(begins) – \(sameDay ? to.formatted(date: .omitted, time: .shortened) : to.formatted(date: .abbreviated, time: .shortened))"
    }
}
