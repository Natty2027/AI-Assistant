import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// A post the assistant wrote for a platform with no connected account. The person posts it
/// themselves through the share sheet, so it goes out from their own app and account.
struct DraftCard: View {
    let draft: Draft
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                if let platform = draft.knownPlatform {
                    Label(platform.displayName, systemImage: platform.systemImage)
                        .font(.headline)
                }
                if draft.sponsored {
                    Text("Sponsored")
                        .font(.caption.bold())
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.orange.opacity(0.2), in: .capsule)
                }
                Spacer()
                if let platform = draft.knownPlatform {
                    let length = platform.measuredLength(of: draft.shareableText)
                    Text("\(length)/\(platform.characterLimit)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(length > platform.characterLimit ? .red : .secondary)
                }
            }

            Text(draft.shareableText)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

            if !draft.problems.isEmpty {
                CheckList(checks: draft.problems)
            }

            HStack {
                ShareLink(item: draft.shareableText) {
                    Label("Share…", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.borderedProminent)
                .disabled(hasBlockingProblem)

                Button {
                    copyToClipboard(draft.shareableText)
                    copied = true
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.bordered)
            }
            if hasBlockingProblem {
                Text("Fix the problem above before posting. Ask the assistant to rewrite it.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .background(.background.secondary, in: .rect(cornerRadius: 12))
    }

    private var hasBlockingProblem: Bool { draft.problems.contains { $0.level == .block } }

    private func copyToClipboard(_ text: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = text
        #elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
    }
}

/// Rule results, worded by the server for people.
struct CheckList: View {
    let checks: [Check]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(checks) { check in
                Label {
                    Text(check.message).font(.callout)
                } icon: {
                    Image(systemName: icon(for: check.level))
                        .foregroundStyle(color(for: check.level))
                }
            }
        }
    }

    private func icon(for level: Check.Level) -> String {
        switch level {
        case .block: "xmark.octagon.fill"
        case .attest: "hand.raised.fill"
        case .warn: "exclamationmark.triangle.fill"
        }
    }

    private func color(for level: Check.Level) -> Color {
        switch level {
        case .block: .red
        case .attest: .orange
        case .warn: .yellow
        }
    }
}

#Preview {
    DraftCard(draft: Draft(id: "d1", connectionId: nil, platform: "instagram",
                           text: "Our spring pottery class opens Saturday at 10. Beginners welcome!",
                           link: nil, sponsored: false,
                           problems: [Check(id: "needs_media", level: .warn, message: "Add an image or video when you post this on Instagram.")]))
        .padding()
}
