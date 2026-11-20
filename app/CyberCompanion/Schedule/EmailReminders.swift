import CoreTransferable
import Foundation
import UniformTypeIdentifiers
import UserNotifications

/// "Remind me to send this": an email Hera wrote is kept on this device and, at the time the person
/// chose, the phone reminds them (with Hera saying so). Tapping the reminder opens the email,
/// filled in, ready to send. Nothing is sent by itself.
enum EmailReminders {
    nonisolated static let idPrefix = "hera.email."

    private static var folder: URL { URL.applicationSupportDirectory.appending(path: "EmailReminders", directoryHint: .isDirectory) }
    private static func file(_ id: String) -> URL { folder.appending(path: "\(id.filter { $0.isLetter || $0.isNumber || $0 == "_" }).json") }

    /// Keeps the email and sets the reminder. Returns false if the time has passed or
    /// notifications are off.
    @discardableResult
    static func remind(_ draft: EmailDraft, at date: Date) async -> Bool {
        guard date > .now else { return false }
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
        }
        let allowed = await center.notificationSettings().authorizationStatus
        guard allowed == .authorized || allowed == .provisional else { return false }

        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(draft), (try? data.write(to: file(draft.id), options: .atomic)) != nil else { return false }

        let content = UNMutableNotificationContent()
        content.title = "Time to send your email"
        content.body = draft.subject.isEmpty ? "Your email is ready to send." : draft.subject
        content.sound = .default
        content.interruptionLevel = .timeSensitive
        content.threadIdentifier = "hera.emails"
        content.userInfo = ["emailId": draft.id, "spoken": spoken(for: draft)]
        let when = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        try? await center.add(UNNotificationRequest(identifier: idPrefix + draft.id, content: content,
                                                    trigger: UNCalendarNotificationTrigger(dateMatching: when, repeats: false)))
        return true
    }

    static func cancel(_ id: String) {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [idPrefix + id])
        try? FileManager.default.removeItem(at: file(id))
    }

    /// The email a reminder was for, if it's still kept.
    static func email(_ id: String) -> EmailDraft? {
        (try? Data(contentsOf: file(id))).flatMap { try? JSONDecoder().decode(EmailDraft.self, from: $0) }
    }

    static func spoken(for draft: EmailDraft) -> String {
        draft.subject.isEmpty ? "It's time to send your email." : "It's time to send your email: \(draft.subject)."
    }
}

/// A calendar invite as a file, for the share sheet or a mail attachment.
struct InviteFile: Transferable {
    let invite: EmailDraft.Invite

    var data: Data { Data(invite.ics.utf8) }
    var fileName: String {
        let base = invite.title.filter { $0.isLetter || $0.isNumber || $0 == " " }.trimmingCharacters(in: .whitespaces)
        return "\(base.isEmpty ? "Invite" : base).ics"
    }

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: .calendarEvent) { $0.data }
            .suggestedFileName { $0.fileName }
    }
}
