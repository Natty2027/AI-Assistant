import SwiftUI

/// Rule results, worded by the server for people. Used wherever a site or post is shown before
/// it's approved: Create, Review and Website.
struct CheckList: View {
    let checks: [Check]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
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
