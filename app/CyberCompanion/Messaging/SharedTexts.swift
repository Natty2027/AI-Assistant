import Foundation

/// Texts the person shared to Hera from Messages (the "Hera" share extension). The extension can't
/// open the app, so it leaves the text here, in the app group both can read, and the app picks it
/// up and reads it aloud the next time it's opened. Kept only until then.
enum SharedTexts {
    nonisolated static let key = "sharedTexts"
    /// A shared text older than this is dropped rather than read out of the blue.
    nonisolated static let keepFor: TimeInterval = 24 * 3600

    private struct Item: Codable {
        let text: String
        let sharedAt: Date
    }

    private static var defaults: UserDefaults? { UserDefaults(suiteName: TodayWidgetData.appGroup) }

    /// The most recent shared text, if any, and clears the inbox.
    static func takeLatest(now: Date = .now) -> String? {
        guard let defaults, let data = defaults.data(forKey: key) else { return nil }
        defaults.removeObject(forKey: key)
        let items = (try? JSONDecoder().decode([Item].self, from: data)) ?? []
        return items.filter { now.timeIntervalSince($0.sharedAt) < keepFor }.max { $0.sharedAt < $1.sharedAt }?.text
    }

    /// Used by tests; the share extension writes the same format.
    static func add(_ text: String, now: Date = .now) {
        guard let defaults else { return }
        var items = defaults.data(forKey: key).flatMap { try? JSONDecoder().decode([Item].self, from: $0) } ?? []
        items.append(Item(text: String(text.prefix(4000)), sharedAt: now))
        if let data = try? JSONEncoder().encode(items.suffix(5)) { defaults.set(data, forKey: key) }
    }
}
