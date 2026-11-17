import AVFoundation
import Foundation
import Testing
@testable import CyberCompanion

struct EventReminderTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func event(_ id: String, in minutes: Double, title: String = "Dentist", location: String? = nil) -> UpcomingEvent {
        UpcomingEvent(id: id, title: title, start: now.addingTimeInterval(minutes * 60), location: location)
    }

    @Test func eachEventIsRemindedTheChosenTimeBefore() {
        let plans = EventReminderPlanner.plan([event("b", in: 120), event("a", in: 60)], leadMinutes: 15, now: now, limit: 10)
        #expect(plans.map(\.id) == ["hera.event.a|15", "hera.event.b|15"])
        #expect(plans[0].fireDate == now.addingTimeInterval(45 * 60))
    }

    @Test func eventsTooCloseToWarnAboutAreSkippedAndTheListIsCapped() {
        let events = [event("soon", in: 10)] + (1...50).map { event("e\($0)", in: Double(30 + $0)) }
        let plans = EventReminderPlanner.plan(events, leadMinutes: 15, now: now, limit: 40)
        #expect(plans.count == 40)
        #expect(!plans.contains { $0.id.contains("soon") })
    }

    @Test func herReminderSaysWhatItIsWhenAndWhere() {
        let plan = EventReminderPlanner.plan([event("a", in: 60, title: "Dentist", location: "12 Main St")],
                                             leadMinutes: 30, now: now, limit: 1)[0]
        let time = now.addingTimeInterval(3600).formatted(date: .omitted, time: .shortened)
        #expect(plan.spoken == "Hi, it's Hera. Dentist starts in 30 minutes, at \(time), at 12 Main St.")
        #expect(plan.title == "Coming up: Dentist")
        #expect(plan.body == "Dentist starts at \(time), in 30 minutes. At 12 Main St.")
    }

    @Test func callLinksAreSaidAsOnlineAndLongTitlesAreShortened() {
        let long = String(repeating: "Planning ", count: 30)
        let plan = EventReminderPlanner.plan([event("a", in: 90, title: long, location: "https://zoom.us/j/123")],
                                             leadMinutes: 60, now: now, limit: 1)[0]
        #expect(plan.spoken.hasSuffix(", online."))
        #expect(!plan.spoken.contains("zoom"))
        #expect(plan.spoken.contains("in 1 hour"))
        #expect(plan.title.count <= "Coming up: ".count + 80)
    }

    @Test func recordingsAreNamedByWhatTheySay() {
        #expect(EventReminderPlanner.clipName(for: "a") == EventReminderPlanner.clipName(for: "a"))
        #expect(EventReminderPlanner.clipName(for: "a") != EventReminderPlanner.clipName(for: "b"))
        #expect(EventReminderPlanner.clipName(for: "a").hasSuffix(".caf"))
    }

    @MainActor
    @Test(.enabled(if: HeraVoice.isAvailable), .timeLimit(.minutes(3)))
    func herVoiceIsRecordedAsANotificationSound() async throws {
        let url = URL.temporaryDirectory.appending(path: "hera-test-\(UUID().uuidString).caf")
        defer { try? FileManager.default.removeItem(at: url) }
        try await HeraVoice().record("Hi, it's Hera. Dentist starts in 15 minutes, at 3 PM.", to: url)
        let file = try AVAudioFile(forReading: url)
        let seconds = Double(file.length) / file.fileFormat.sampleRate
        #expect(seconds > 1 && seconds < 30)
        #expect(file.fileFormat.settings[AVLinearPCMBitDepthKey] as? Int == 16)
    }
}
