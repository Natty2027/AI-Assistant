import Foundation
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Which app "Open in…" hands an email to: Apple Mail (whatever the default email app is, through
/// mailto:) or the Outlook app. Chosen in Settings, which only offers it when Outlook is installed.
enum EmailApp: String, CaseIterable, Identifiable, Sendable {
    case mail, outlook

    static let preferenceKey = "emailApp"

    var id: Self { self }
    var name: String { self == .mail ? "Mail" : "Outlook" }

    /// The app to open emails in: the person's choice, or Mail when Outlook isn't installed (any more).
    @MainActor static func preferred(_ defaults: UserDefaults = .standard) -> EmailApp {
        let chosen = defaults.string(forKey: preferenceKey).flatMap(EmailApp.init(rawValue:)) ?? .mail
        return chosen == .outlook && !OutlookApp.isInstalled ? .mail : chosen
    }

    /// The link that opens `draft` in this app, filled in.
    func url(for draft: EmailDraft) -> URL? {
        self == .mail ? MailLink.url(for: draft) : OutlookLink.url(for: draft)
    }
}

/// The Outlook app's compose link: ms-outlook://compose?to=…&cc=…&subject=…&body=…. Encoded with
/// the same strict set as mailto: links, so "&", "=", "+" or "#" in a subject or body can't cut the
/// message off. A link can't carry a file, so a calendar invite never goes with it.
enum OutlookLink {
    private static let unreserved = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
    /// "+" is encoded too: an app reading this as a web-style query would take it for a space.
    private static let address = unreserved.union(CharacterSet(charactersIn: "@"))

    static func url(for draft: EmailDraft) -> URL? {
        func encode(_ text: String, _ allowed: CharacterSet) -> String { text.addingPercentEncoding(withAllowedCharacters: allowed) ?? "" }
        func addresses(_ list: [String]) -> String {
            list.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.map { encode($0, address) }.joined(separator: ",")
        }
        var fields: [String] = []
        let to = addresses(draft.to), cc = addresses(draft.cc)
        if !to.isEmpty { fields.append("to=" + to) }
        if !cc.isEmpty { fields.append("cc=" + cc) }
        if !draft.subject.isEmpty { fields.append("subject=" + encode(draft.subject, unreserved)) }
        let body = draft.body.replacingOccurrences(of: "\r\n", with: "\n")
        if !body.isEmpty { fields.append("body=" + encode(body, unreserved)) }
        return URL(string: "ms-outlook://compose" + (fields.isEmpty ? "" : "?" + fields.joined(separator: "&")))
    }
}

/// Whether the Outlook app is on this device. On iPhone and iPad this needs ms-outlook in
/// LSApplicationQueriesSchemes (Info.plist).
enum OutlookApp {
    @MainActor static var isInstalled: Bool {
        guard let url = URL(string: "ms-outlook://compose") else { return false }
        #if os(iOS)
        return UIApplication.shared.canOpenURL(url)
        #else
        return NSWorkspace.shared.urlForApplication(toOpen: url) != nil
        #endif
    }
}

/// Where to add an Outlook or work calendar so Hera sees it: she uses the calendars on this device.
enum OutlookCalendarHint {
    @MainActor static var steps: String {
        #if os(iOS)
        "To see your Outlook or work calendar here, add the account on this \(ThisDevice.name): Settings → Apps → Calendar → Calendar Accounts → Add Account → Microsoft Exchange (or Outlook.com). Turn on Calendars, and Hera sees it too."
        #else
        "To see your Outlook or work calendar here, add the account on this Mac: System Settings → Internet Accounts → Add Account → Microsoft Exchange (or Outlook.com). Turn on Calendars, and Hera sees it too."
        #endif
    }
}
