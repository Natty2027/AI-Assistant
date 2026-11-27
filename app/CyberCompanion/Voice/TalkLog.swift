import Foundation
import os
import Synchronization

/// What Talk did, step by step, kept in memory so a tester can copy it from Settings (Talk
/// diagnostics) and send it. Holds the last 200 lines and nothing from before the app opened.
/// Never more than the first 40 characters of anything said, and no tokens or addresses. Each
/// line also goes to the system log (subsystem com.natty2027.hera, category talk).
final class TalkLog: Sendable {
    static let shared = TalkLog()
    static let capacity = 200

    private let lines = Mutex<[String]>([])
    private static let logger = Logger(subsystem: "com.natty2027.hera", category: "talk")

    /// Adds a line. Safe from any thread, including the audio thread.
    static func note(_ line: String) { shared.add(line) }

    /// Adds a line about something said. The first words are kept here, in memory, for the
    /// person to share; the system log only gets the length, and hides even that line's words.
    static func note(_ line: String, said: String) {
        shared.add("\(line) \(snippet(said))", systemLog: "\(line) (\(said.count) chars)")
    }

    /// The first 40 characters of something said, quoted, with its length.
    static func snippet(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let start = trimmed.prefix(40)
        return "\"\(start)\(trimmed.count > 40 ? "…" : "")\" (\(trimmed.count) chars)"
    }

    func add(_ line: String, systemLog: String? = nil) {
        let stamped = "\(Self.time.string(from: Date())) \(line)"
        if let systemLog {
            Self.logger.notice("\(systemLog, privacy: .private)")
        } else {
            Self.logger.notice("\(line, privacy: .public)")
        }
        lines.withLock { lines in
            lines.append(stamped)
            if lines.count > Self.capacity { lines.removeFirst(lines.count - Self.capacity) }
        }
    }

    var recent: [String] { lines.withLock { $0 } }

    /// Everything kept, oldest first, ready to paste into a message.
    var text: String { recent.joined(separator: "\n") }

    func clear() { lines.withLock { $0.removeAll() } }

    private static let time: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm:ss.SSS"
        return formatter
    }()
}
