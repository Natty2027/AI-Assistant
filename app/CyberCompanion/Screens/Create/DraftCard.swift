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
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                IconTile(systemImage: draft.knownPlatform?.systemImage ?? "text.bubble.fill")
                VStack(alignment: .leading, spacing: 2) {
                    Text(draft.knownPlatform?.displayName ?? "Post")
                        .font(.headline)
                    if draft.sponsored {
                        Text("SPONSORED")
                            .font(.caption2.monospaced().weight(.bold))
                            .tracking(1)
                            .foregroundStyle(.orange)
                    }
                }
                Spacer()
                if let platform = draft.knownPlatform {
                    LengthRing(length: platform.measuredLength(of: draft.shareableText), limit: platform.characterLimit)
                }
            }

            Text(draft.shareableText)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

            if !draft.problems.isEmpty {
                CheckList(checks: draft.problems)
            }

            HStack(spacing: 10) {
                ShareLink(item: draft.shareableText) {
                    Label("Share", systemImage: "square.and.arrow.up")
                        .font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.glassProminent)
                .disabled(hasBlockingProblem)

                Button {
                    copyToClipboard(draft.shareableText)
                    withAnimation(.spring(duration: 0.3)) { copied = true }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.subheadline.weight(.semibold))
                        .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(.glass)
                .sensoryFeedback(.success, trigger: copied) { _, now in now }
            }
            if hasBlockingProblem {
                Text("Fix the problem above before posting, or ask Hera to rewrite it.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .glowCard()
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

/// A ring that fills toward the platform's character limit and turns red past it.
private struct LengthRing: View {
    let length: Int
    let limit: Int

    var body: some View {
        let fraction = min(Double(length) / Double(limit), 1)
        let over = length > limit
        ZStack {
            Circle().stroke(.quaternary, lineWidth: 3)
            Circle()
                .trim(from: 0, to: fraction)
                .stroke(over ? AnyShapeStyle(Color.red) : AnyShapeStyle(Theme.spectrumGradient),
                        style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text("\(limit - length)")
                .font(.caption2.monospacedDigit().weight(.semibold))
                .foregroundStyle(over ? .red : .secondary)
                .minimumScaleFactor(0.6)
        }
        .frame(width: 40, height: 40)
        .accessibilityElement()
        .accessibilityLabel(over ? "\(length - limit) characters over the limit" : "\(limit - length) characters left")
    }
}

#Preview {
    ScrollView {
        DraftCard(draft: Draft(id: "d1", connectionId: nil, platform: "instagram",
                               text: "Our spring pottery class opens Saturday at 10. Beginners welcome!",
                               link: nil, sponsored: false,
                               problems: [Check(id: "needs_media", level: .warn, message: "Add an image or video when you post this on Instagram.")]))
            .padding()
    }
    .auroraBackground()
}
