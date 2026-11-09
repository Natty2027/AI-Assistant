import SwiftUI

/// Three steps for someone opening Hera for the first time, plus the Siri shortcut. Shown on
/// Create until dismissed.
struct HowHeraWorksCard: View {
    var dismiss: () -> Void

    private let steps: [(String, String, String)] = [
        ("square.split.2x1", "Choose Website or Posts", "Hera does one at a time."),
        ("mic.fill", "Say or type what you'd like", "For example: a page for my bakery, or posts announcing Saturday's sale."),
        ("checkmark.seal.fill", "Review and approve", "Nothing is published until you approve the exact content."),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionLabel("How Hera works")
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                HStack(alignment: .top, spacing: 12) {
                    IconTile(systemImage: step.0, size: 30)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(index + 1). \(step.1)").font(.subheadline.weight(.semibold))
                        Text(step.2).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            Label("Tip: say \"Hey Siri, talk to Hera\" to start hands-free.", systemImage: "waveform")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Button("Got it", action: dismiss)
                .buttonStyle(.glass)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .glowCard()
    }
}

#Preview {
    HowHeraWorksCard {}
        .padding()
        .auroraBackground()
}
