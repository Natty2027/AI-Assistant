#if os(iOS)
import ActivityKit
import SwiftUI
import WidgetKit

/// A scheduled post counting down on the Lock Screen and in the Dynamic Island. The app starts,
/// updates and ends it (ScheduledPostActivities); tapping it opens the post in Review.
struct ScheduledPostLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ScheduledPostAttributes.self) { context in
            ScheduledPostLockScreenView(context: context)
                .widgetURL(Self.reviewURL(context.attributes.proposalId))
        } dynamicIsland: { context in
            let phase = PostPhase(state: context.state, isStale: context.isStale)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label("Hera", systemImage: "sparkle")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tint)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    PostCountdown(postAt: context.state.postAt, phase: phase)
                        .font(.headline.monospacedDigit())
                        .frame(maxWidth: 90, alignment: .trailing)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(phase.headline(platform: context.attributes.platform))
                            .font(.subheadline.weight(.semibold))
                        Text(context.state.summary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } compactLeading: {
                Image(systemName: "sparkle")
                    .foregroundStyle(.tint)
            } compactTrailing: {
                PostCountdown(postAt: context.state.postAt, phase: phase, compact: true)
                    .font(.caption2.monospacedDigit())
                    .frame(maxWidth: 44)
            } minimal: {
                Image(systemName: phase.symbol)
                    .foregroundStyle(.tint)
            }
            .widgetURL(Self.reviewURL(context.attributes.proposalId))
        }
    }

    /// hera://review/<id>: the app opens the Review tab at this post.
    static func reviewURL(_ proposalId: String) -> URL? {
        let id = proposalId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? proposalId
        return URL(string: "hera://review/\(id)")
    }
}

/// Where a scheduled post is: counting down, due now, or done one way or another.
enum PostPhase: Equatable {
    case counting, postingNow, posted, failed, cancelled

    init(state: ScheduledPostAttributes.ContentState, isStale: Bool) {
        switch state.status {
        case ScheduledPostAttributes.Status.posted: self = .posted
        case ScheduledPostAttributes.Status.failed: self = .failed
        case ScheduledPostAttributes.Status.cancelled: self = .cancelled
        // Past its stale date the app hasn't heard how it went yet; the server is posting it.
        default: self = isStale ? .postingNow : .counting
        }
    }

    func headline(platform: String) -> String {
        switch self {
        case .counting: "Posting to \(platform)"
        case .postingNow: "Posting now…"
        case .posted: "Posted to \(platform)"
        case .failed: "Couldn't post to \(platform)"
        case .cancelled: "Post cancelled"
        }
    }

    var symbol: String {
        switch self {
        case .counting, .postingNow: "sparkle"
        case .posted: "checkmark.circle"
        case .failed: "exclamationmark.triangle"
        case .cancelled: "xmark.circle"
        }
    }
}

/// The live countdown while it's waiting; a word once it's due or done.
struct PostCountdown: View {
    let postAt: Date
    let phase: PostPhase
    var compact = false

    var body: some View {
        switch phase {
        case .counting:
            // The range can't start after it ends, so a post already due counts from zero.
            Text(timerInterval: Date.now...max(postAt, .now), countsDown: true)
                .multilineTextAlignment(.trailing)
        case .postingNow: Text("Now")
        case .posted: Text(compact ? "Done" : "Posted")
        case .failed: Text("Failed")
        case .cancelled: Text(compact ? "Off" : "Cancelled")
        }
    }
}

/// The Lock Screen (and, on iPhones without a Dynamic Island, the banner): Hera, where it's
/// posting, what it is and how long until it goes.
struct ScheduledPostLockScreenView: View {
    let context: ActivityViewContext<ScheduledPostAttributes>

    var body: some View {
        let phase = PostPhase(state: context.state, isStale: context.isStale)
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: phase.symbol)
                .font(.title3.weight(.semibold))
                .foregroundStyle(.tint)
                .frame(width: 40, height: 40)
                .background(.tint.opacity(0.15), in: .circle)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(phase.headline(platform: context.attributes.platform))
                    .font(.headline)
                    .lineLimit(1)
                Text(context.state.summary)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            PostCountdown(postAt: context.state.postAt, phase: phase)
                .font(.title3.weight(.semibold).monospacedDigit())
                .frame(maxWidth: 96, alignment: .trailing)
        }
        .padding(16)
    }
}

extension ScheduledPostAttributes {
    static let preview = ScheduledPostAttributes(proposalId: "p1", platform: "Instagram")
}

extension ScheduledPostAttributes.ContentState {
    static let counting = Self(postAt: .now.addingTimeInterval(45 * 60), summary: "Open house this Saturday", status: ScheduledPostAttributes.Status.scheduled)
    static let posted = Self(postAt: .now, summary: "Open house this Saturday", status: ScheduledPostAttributes.Status.posted)
}

#Preview("Lock Screen", as: .content, using: ScheduledPostAttributes.preview) {
    ScheduledPostLiveActivity()
} contentStates: {
    ScheduledPostAttributes.ContentState.counting
    ScheduledPostAttributes.ContentState.posted
}

#Preview("Dynamic Island", as: .dynamicIsland(.expanded), using: ScheduledPostAttributes.preview) {
    ScheduledPostLiveActivity()
} contentStates: {
    ScheduledPostAttributes.ContentState.counting
}
#endif
