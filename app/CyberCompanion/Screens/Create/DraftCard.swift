import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// A post the assistant wrote for a platform with no connected account. The person posts it
/// themselves through the share sheet, so it goes out from their own app and account. The words
/// can be edited (or rewritten on this device) first; Share and Copy use them as edited.
struct DraftCard: View {
    let draft: Draft
    @State private var text: String
    @State private var copied = false

    init(draft: Draft) {
        self.draft = draft
        _text = State(initialValue: draft.text)
    }

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
                    LengthRing(length: platform.measuredLength(of: shareable), limit: platform.characterLimit)
                }
            }

            TextEditor(text: $text)
                .frame(minHeight: 90, maxHeight: 320)
                .scrollContentBackground(.hidden)
                .padding(8)
                .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .accessibilityLabel("Post text")
            if let link = draft.link, !link.isEmpty, shareable != text {
                Label(link, systemImage: "link")
                    .labelStyle(.alignedIcon)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            OnDeviceTools(text: $text, characterLimit: draft.textCharacterLimit,
                          measure: { draft.knownPlatform?.measuredLength(of: $0) ?? $0.count },
                          offersHashtags: true)

            if !draft.problems.isEmpty {
                CheckList(checks: draft.problems)
            }

            HStack(spacing: 10) {
                ShareLink(item: shareable) {
                    Label("Share", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.glassProminent)
                .disabled(hasBlockingProblem)

                Button {
                    copyToClipboard(shareable)
                    withAnimation(.spring(duration: 0.3)) { copied = true }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(.glass)
                .sensoryFeedback(.success, trigger: copied) { _, now in now }
            }
            // The same size as the buttons on the poster and email cards.
            .controlSize(.small)
            .lineLimit(1)
            if hasBlockingProblem {
                Text("Fix the problem above before posting, or ask Hera to rewrite it.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .glowCard()
        // A fresh copy was made, so the old "Copied" no longer applies.
        .onChange(of: text) { copied = false }
    }

    /// What goes out: the text as edited, with the link the platform adds.
    private var shareable: String { draft.shareable(text) }

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
    .environment(AppModel())
}
