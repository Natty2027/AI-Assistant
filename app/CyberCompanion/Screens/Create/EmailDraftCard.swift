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
