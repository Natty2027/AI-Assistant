import SwiftUI
#if os(iOS)
import UIKit
#endif

/// For a text someone sent: what it's about in a sentence, and three replies to tap, made on
/// this device as soon as the text arrives. Tapping one gives a text message card to send.
/// Shows nothing when on-device Hera isn't available; "Help me reply" still asks Hera.
struct QuickReplies: View {
    let text: String
    let onPick: (String) -> Void

    @Environment(AppModel.self) private var model
    @State private var help: ReceivedTextHelp?
    @State private var problem: String?

    var body: some View {
        if model.onDevice.isAvailable {
            VStack(alignment: .leading, spacing: 8) {
                if let help {
                    Label(help.summary, systemImage: "text.quote")
                        .labelStyle(.alignedIcon)
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Quick replies")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    ForEach(help.replies, id: \.self) { reply in
                        Button { onPick(reply) } label: {
                            Label(reply, systemImage: "arrowshape.turn.up.left")
                                .labelStyle(.alignedIcon)
                                .font(.subheadline)
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, minHeight: 22, alignment: .leading)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 8)
                                .contentShape(.rect(cornerRadius: 18))
                                .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 18))
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Makes a text message with this reply")
                    }
                } else if let problem {
                    Text(problem)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Reading it on this \(ThisDevice.name)…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .transition(.opacity)
            .task(id: text) { await load() }
        }
    }

    private func load() async {
        help = nil
        problem = nil
        do {
            let found = try await model.onDevice.help(withReceived: text)
            withAnimation { help = found }
        } catch is CancellationError {
        } catch {
            problem = error.localizedDescription
        }
    }
}

/// "iPhone", "iPad" or "Mac", for sentences like "runs on this iPhone".
enum ThisDevice {
    @MainActor
    static var name: String {
        #if os(iOS)
        UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        #else
        "Mac"
        #endif
    }
}
