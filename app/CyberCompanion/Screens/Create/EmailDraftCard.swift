import SwiftUI
#if os(iOS)
import MessageUI
#endif

/// An email Hera wrote. The person can edit it here, then send it from their own email app:
/// "Open in Mail" opens their default email app (Apple Mail, Gmail, Outlook…) with everything
/// filled in. On iPhone and iPad with Apple Mail set up, "Write here" opens Apple's compose sheet
/// inside Hera. Either way the person presses Send; Hera never sends anything.
struct EmailDraftCard: View {
    @State private var draft: EmailDraft
    @State private var toText: String
    @State private var showComposer = false
    @State private var copied = false
    /// Set once the reminder to send it is on.
    @State private var remindedAt: Date?
    @State private var reminderProblem: String?
    @Environment(\.openURL) private var openURL

    init(draft: EmailDraft) {
        _draft = State(initialValue: draft)
        _toText = State(initialValue: draft.to.joined(separator: ", "))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                IconTile(systemImage: "envelope.fill", size: 30)
                Text("Email").font(.subheadline.weight(.semibold))
            }
            LabeledContent("To") {
                TextField("Add an email address", text: $toText)
                    .textContentType(.emailAddress)
                    #if os(iOS)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    #endif
                    .autocorrectionDisabled()
            }
            if !draft.cc.isEmpty {
                LabeledContent("Cc", value: draft.cc.joined(separator: ", "))
            }
            LabeledContent("Subject") {
                TextField("Subject", text: $draft.subject)
            }
            TextEditor(text: $draft.body)
                .frame(minHeight: 140, maxHeight: 300)
                .scrollContentBackground(.hidden)
                .padding(8)
                .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            OnDeviceTools(text: $draft.body)
            if let invite = draft.invite { inviteRow(invite) }
            if let sendAt = draft.sendAt.flatMap(HeraTime.parse) { reminderRow(sendAt) }
            HStack(spacing: 10) {
                Button("Open in Mail", systemImage: "arrow.up.forward.app") { openInMailApp() }
                    .buttonStyle(.glassProminent)
                #if os(iOS)
                if MFMailComposeViewController.canSendMail() {
                    Button("Write here", systemImage: "square.and.pencil") { showComposer = true }
                        .buttonStyle(.glass)
                }
                #endif
                Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") { copy() }
                    .buttonStyle(.glass)
            }
            .controlSize(.small)
            .lineLimit(1)
            if draft.invite != nil {
                Text("Open in Mail can't carry the invite. Use \(canWriteHere ? "Write here or " : "")Share invite to include it.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text("Nothing is sent until you press Send in your email app.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .font(.callout)
        .glowCard()
        #if os(iOS)
        .sheet(isPresented: $showComposer) {
            MailComposeSheet(draft: current).ignoresSafeArea()
        }
        #endif
    }

    private var canWriteHere: Bool {
        #if os(iOS)
        MFMailComposeViewController.canSendMail()
        #else
        false
        #endif
    }

    /// The calendar invite: what it is, and a way to share the file (Mail, Messages, AirDrop…).
    private func inviteRow(_ invite: EmailDraft.Invite) -> some View {
        HStack(spacing: 10) {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Calendar invite: \(invite.title)").font(.footnote.weight(.semibold))
                    if let start = HeraTime.parse(invite.start) {
                        Text(HeraTime.spoken(start)).font(.caption).foregroundStyle(.secondary)
                    }
                }
            } icon: {
                Image(systemName: "calendar.badge.plus")
            }
            .labelStyle(.alignedIcon)
            Spacer()
            ShareLink(item: InviteFile(invite: invite), preview: SharePreview(invite.title, image: Image(systemName: "calendar"))) {
                Label("Share invite", systemImage: "square.and.arrow.up")
            }
            .buttonStyle(.glass)
            .controlSize(.small)
            .lineLimit(1)
        }
    }

    /// A reminder to send it later, at the time Hera set.
    private func reminderRow(_ sendAt: Date) -> some View {
        HStack(spacing: 10) {
            Label(remindedAt.map { "Reminder set for \(HeraTime.spoken($0))" } ?? "Send it \(HeraTime.spoken(sendAt))",
                  systemImage: remindedAt == nil ? "bell" : "bell.fill")
                .labelStyle(.alignedIcon)
                .font(.footnote)
            Spacer()
            if remindedAt == nil {
                Button("Remind me") {
                    Task {
                        if await EmailReminders.remind(current, at: sendAt) {
                            remindedAt = sendAt
                            reminderProblem = nil
                        } else {
                            reminderProblem = sendAt <= .now ? "That time has passed." : "Turn on notifications for Hera in Settings to get reminders."
                        }
                    }
                }
                .buttonStyle(.glassProminent)
                .controlSize(.small)
            } else {
                Button("Cancel") {
                    EmailReminders.cancel(draft.id)
                    remindedAt = nil
                }
                .buttonStyle(.glass)
                .controlSize(.small)
            }
        }
        .overlay(alignment: .bottomLeading) {
            if let reminderProblem {
                Text(reminderProblem).font(.caption2).foregroundStyle(.orange).offset(y: 16)
            }
        }
    }

    /// The draft as edited, with the To line split back into addresses.
    private var current: EmailDraft {
        var d = draft
        d.to = toText.split(whereSeparator: { $0 == "," || $0 == ";" || $0 == " " }).map(String.init).filter { !$0.isEmpty }
        return d
    }

    private func openInMailApp() {
        if let url = MailLink.url(for: current) { openURL(url) }
    }

    private func copy() {
        let text = "Subject: \(draft.subject)\n\n\(draft.body)"
        #if os(iOS)
        UIPasteboard.general.string = text
        #else
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
        copied = true
    }
}

#Preview {
    EmailDraftCard(draft: EmailDraft(id: "e1", to: ["sam@example.com"], cc: [], subject: "Your Saturday pottery class",
                                     body: "Hi Sam,\n\nThanks for booking! Class starts at 10 AM this Saturday at Clay Corner, 12 Main St.\n\nSee you there,\nNat"))
        .padding()
        .environment(AppModel())
}

/// A mailto: link (RFC 6068), which the system hands to the person's default email app. Every
/// part is percent-encoded with a strict set, because "&", "=", "+" or "#" left in a subject or
/// body would cut the message off or change it.
enum MailLink {
    private static let unreserved = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
    private static let address = unreserved.union(CharacterSet(charactersIn: "@+"))

    static func url(for draft: EmailDraft) -> URL? {
        func encode(_ text: String, _ allowed: CharacterSet) -> String { text.addingPercentEncoding(withAllowedCharacters: allowed) ?? "" }
        let to = draft.to.map { encode($0, address) }.joined(separator: ",")
        var fields: [String] = []
        if !draft.cc.isEmpty { fields.append("cc=" + draft.cc.map { encode($0, address) }.joined(separator: ",")) }
        if !draft.subject.isEmpty { fields.append("subject=" + encode(draft.subject, unreserved)) }
        // Line breaks are CRLF in mail; mailto spells them %0D%0A.
        let body = draft.body.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\n", with: "\r\n")
        if !body.isEmpty { fields.append("body=" + encode(body, unreserved)) }
        return URL(string: "mailto:" + to + (fields.isEmpty ? "" : "?" + fields.joined(separator: "&")))
    }
}

#if os(iOS)
/// Apple's mail compose sheet, filled in. Only shown when MFMailComposeViewController.canSendMail()
/// says Apple Mail is set up. The person sends (or cancels) it themselves.
struct MailComposeSheet: UIViewControllerRepresentable {
    let draft: EmailDraft
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> MFMailComposeViewController {
        let composer = MFMailComposeViewController()
        composer.mailComposeDelegate = context.coordinator
        composer.setToRecipients(draft.to)
        composer.setCcRecipients(draft.cc)
        composer.setSubject(draft.subject)
        composer.setMessageBody(draft.body, isHTML: false)
        // The invite goes along as a real calendar file: guests tap it to add the event.
        if let invite = draft.invite {
            let file = InviteFile(invite: invite)
            composer.addAttachmentData(file.data, mimeType: "text/calendar", fileName: file.fileName)
        }
        return composer
    }

    func updateUIViewController(_ controller: MFMailComposeViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(dismiss: { dismiss() }) }

    final class Coordinator: NSObject, MFMailComposeViewControllerDelegate {
        let dismiss: () -> Void
        init(dismiss: @escaping () -> Void) { self.dismiss = dismiss }

        func mailComposeController(_ controller: MFMailComposeViewController, didFinishWith result: MFMailComposeResult, error: (any Error)?) {
            dismiss()
        }
    }
}
#endif
