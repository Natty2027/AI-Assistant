import SwiftUI
#if os(iOS)
import MessageUI
#endif

/// A text message Hera wrote. Each name is looked up in Contacts on this device; the person can
/// pick which number, edit the words, hear it read aloud, then send it. On iPhone Apple's message
/// sheet opens inside Hera with everything filled in; elsewhere Messages opens. Either way the
/// person presses Send: no app can send a text by itself, and Hera never would.
struct TextDraftCard: View {
    @State private var body_: String
    @State private var rows: [Row]
    @State private var contactsBlocked = false
    @State private var showComposer = false
    @State private var copied = false
    /// True while Hera is reading this card out (not some other reply).
    @State private var reading = false
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL

    /// One person to text: who Hera was told, what Contacts found, and the number chosen.
    struct Row: Identifiable {
        let id = UUID()
        /// The name as the person said it, or nil when they gave only a number (or nobody).
        let name: String?
        var matches: [ContactLookup.Match] = []
        var number: String
        var looking = false
    }

    init(draft: TextDraft) {
        _body_ = State(initialValue: draft.body)
        let rows = draft.to.map { Row(name: $0.name, number: $0.number ?? "", looking: $0.number == nil && $0.name != nil) }
        // Nobody named: one empty line to type a number into.
        _rows = State(initialValue: rows.isEmpty ? [Row(name: nil, number: "")] : rows)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                IconTile(systemImage: "message.fill", size: 30)
                Text("Text message").font(.subheadline.weight(.semibold))
            }
            ForEach($rows) { $row in
                recipient($row)
            }
            if contactsBlocked {
                Label("Hera can't see your Contacts, so type the number, or allow Contacts in Settings → Apps → Hera.", systemImage: "person.crop.circle.badge.exclamationmark")
                    .labelStyle(.alignedIcon)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            TextEditor(text: $body_)
                .frame(minHeight: 90, maxHeight: 220)
                .scrollContentBackground(.hidden)
                .padding(8)
                .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            OnDeviceTools(text: $body_)
            HStack(spacing: 10) {
                Button("Send in Messages", systemImage: "paperplane.fill") { send() }
                    .buttonStyle(.glassProminent)
                    .disabled(body_.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button(isSpeakingThis ? "Stop" : "Listen", systemImage: isSpeakingThis ? "stop.fill" : "speaker.wave.2.fill") { listen() }
                    .buttonStyle(.glass)
                Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") { copy() }
                    .buttonStyle(.glass)
            }
            .controlSize(.small)
            .lineLimit(1)
            Text("Nothing is sent until you press Send in Messages.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .font(.callout)
        .glowCard()
        .task { await lookUpNames() }
        #if os(iOS)
        .sheet(isPresented: $showComposer) {
            MessageComposeSheet(recipients: numbers, body: body_).ignoresSafeArea()
        }
        #endif
    }

    @ViewBuilder
    private func recipient(_ row: Binding<Row>) -> some View {
        LabeledContent("To") {
            if row.wrappedValue.looking {
                ProgressView().controlSize(.small)
            } else if row.wrappedValue.matches.count > 1 {
                Picker("To", selection: row.number) {
                    ForEach(row.wrappedValue.matches) { match in
                        Text("\(match.name) · \(match.label)").tag(match.number)
                    }
                }
                .labelsHidden()
            } else if let match = row.wrappedValue.matches.first {
                Text("\(match.name) · \(match.label)")
            } else {
                TextField(row.wrappedValue.name.map { "Number for \($0)" } ?? "Phone number", text: row.number)
                    .textContentType(.telephoneNumber)
                    #if os(iOS)
                    .keyboardType(.phonePad)
                    #endif
                    .multilineTextAlignment(.trailing)
            }
        }
    }

    /* ---------------- actions ---------------- */

    private var numbers: [String] {
        rows.map { $0.number.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    private func lookUpNames() async {
        for index in rows.indices where rows[index].looking {
            defer { rows[index].looking = false }
            guard let name = rows[index].name else { continue }
            do {
                let matches = try await ContactLookup.numbers(for: name)
                rows[index].matches = matches
                if let first = matches.first { rows[index].number = first.number }
            } catch {
                contactsBlocked = true
            }
        }
    }

    private func send() {
        #if os(iOS)
        if MFMessageComposeViewController.canSendText() {
            showComposer = true
            return
        }
        #else
        // Messages on the Mac may not fill in the words from a link, so they're copied as well.
        copy()
        #endif
        if let url = MessageLink.url(to: numbers, body: body_) { openURL(url) }
    }

    private var isSpeakingThis: Bool { reading && model.speech.isSpeaking }

    /// What Hera says when asked to read it: who it's for, then the words.
    private var spoken: String {
        let names = rows.compactMap { row in row.matches.first(where: { $0.number == row.number })?.name ?? row.name }
        let who = names.isEmpty ? "Your text" : "Your text to \(ListFormatter.localizedString(byJoining: names))"
        return "\(who) says: \(body_)"
    }

    private func listen() {
        if isSpeakingThis {
            model.speech.stop()
            reading = false
        } else {
            reading = true
            model.speech.speak(spoken) { reading = false }
        }
    }

    private func copy() {
        #if os(iOS)
        UIPasteboard.general.string = body_
        #else
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(body_, forType: .string)
        #endif
        copied = true
    }
}

/// An sms: link that opens Messages with the people and words filled in. Every part is
/// percent-encoded with a strict set, because "&" or "#" left in the words would cut them off.
enum MessageLink {
    private static let unreserved = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")

    static func url(to numbers: [String], body: String) -> URL? {
        // Only what a phone number can contain, so a number can't smuggle in another field.
        let cleaned = numbers.map { $0.filter { $0.isNumber || $0 == "+" } }.filter { !$0.isEmpty }
        let words = body.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
        return URL(string: "sms:/open?addresses=\(cleaned.joined(separator: ","))&body=\(words)")
    }
}

#if os(iOS)
/// Apple's message sheet, filled in. Only shown when MFMessageComposeViewController.canSendText()
/// says this device can send texts. The person sends (or cancels) it themselves.
struct MessageComposeSheet: UIViewControllerRepresentable {
    let recipients: [String]
    let body: String
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> MFMessageComposeViewController {
        let composer = MFMessageComposeViewController()
        composer.messageComposeDelegate = context.coordinator
        composer.recipients = recipients
        composer.body = body
        return composer
    }

    func updateUIViewController(_ controller: MFMessageComposeViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(dismiss: { dismiss() }) }

    final class Coordinator: NSObject, MFMessageComposeViewControllerDelegate {
        let dismiss: () -> Void
        init(dismiss: @escaping () -> Void) { self.dismiss = dismiss }

        func messageComposeViewController(_ controller: MFMessageComposeViewController, didFinishWith result: MessageComposeResult) {
            dismiss()
        }
    }
}
#endif

#Preview {
    TextDraftCard(draft: TextDraft(id: "t1", to: [.init(name: nil, number: "+1 555 010 2030")],
                                   body: "Running 10 minutes late, I'll bring the cake!"))
        .environment(AppModel())
        .padding()
}
