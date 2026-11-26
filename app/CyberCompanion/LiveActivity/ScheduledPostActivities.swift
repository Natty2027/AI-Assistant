import Foundation
#if os(iOS)
import ActivityKit
#endif

/// Which scheduled posts belong on the Lock Screen, worked out from the proposals alone so it can
/// be tested without ActivityKit.
enum ScheduledPostPlan {
    /// Settings: "Show scheduled posts on the Lock Screen". On unless turned off.
    static let enabledKey = "scheduledPostsOnLockScreen"
    static var isEnabled: Bool { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }

    /// Posts going out within this long get a Live Activity. A Live Activity lasts at most eight
    /// hours, so one started earlier would end before its post went out.
    static let window: TimeInterval = 8 * 3600
    /// A post a little past its time may still be on its way: it shows "Posting now…" until the
    /// server says how it went.
    static let lateGrace: TimeInterval = 10 * 60
    /// How long past its time a post's activity counts as out of date.
    static let staleAfter: TimeInterval = 5 * 60
    /// How long a finished post stays on the Lock Screen.
    static let dismissAfter: TimeInterval = 15 * 60

    struct Finish: Equatable {
        let proposalId: String
        /// One of `ScheduledPostAttributes.Status`.
        let status: String
    }

    struct Plan: Equatable {
        /// Scheduled posts with no activity yet.
        var start: [Proposal] = []
        /// Scheduled posts that already have one, in case their time or words changed.
        var update: [Proposal] = []
        /// Posts that went out, failed or were cancelled: shown that way for a while, then gone.
        var finish: [Finish] = []
        /// Activities whose proposal is gone (or that are turned off): removed straight away.
        var remove: [String] = []
    }

    /// True for a post that's approved, waiting for its time, and going out within the window.
    static func wantsActivity(_ proposal: Proposal, now: Date) -> Bool {
        guard proposal.isPost, proposal.isScheduled, let at = proposal.postAt else { return false }
        return at <= now.addingTimeInterval(window) && at >= now.addingTimeInterval(-lateGrace)
    }

    /// `running` is the proposal ids that have an activity now. `showing` is the person's setting;
    /// `canStart` is whether the system allows new activities at the moment.
    static func plan(proposals: [Proposal], running: [String], showing: Bool, canStart: Bool, now: Date) -> Plan {
        var plan = Plan()
        let runningIDs = Set(running)
        guard showing else {
            plan.remove = running
            return plan
        }
        let byID = Dictionary(proposals.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for id in running {
            guard let proposal = byID[id] else {
                plan.remove.append(id)
                continue
            }
            if proposal.isScheduled {
                plan.update.append(proposal)
            } else {
                plan.finish.append(Finish(proposalId: id, status: finalStatus(of: proposal)))
            }
        }
        if canStart {
            plan.start = proposals
                .filter { !runningIDs.contains($0.id) && wantsActivity($0, now: now) }
                .sorted { ($0.postAt ?? .distantFuture) < ($1.postAt ?? .distantFuture) }
        }
        return plan
    }

    /// The server's status, as the Lock Screen says it.
    static func finalStatus(of proposal: Proposal) -> String {
        switch proposal.status {
        case "executed": "posted"
        case "failed": "failed"
        default: "cancelled"
        }
    }

    /// "Instagram" for the post's account, from the connections the app has loaded.
    static func platformName(for proposal: Proposal, connections: [Connection]) -> String {
        let id = proposal.payload["connectionId"]?.stringValue
        guard let connection = connections.first(where: { $0.id == id }) else { return "social media" }
        if let platform = connection.platform.flatMap(Platform.init(rawValue:)) { return platform.displayName }
        return connection.label
    }
}

#if os(iOS)
/// Starts, updates and ends the Lock Screen countdowns for scheduled posts, following the
/// proposals the app last loaded.
///
/// This only runs while the app does. Keeping the countdown right while Hera is closed (showing
/// "Posted" the moment the server posts) would need the server to send ActivityKit push
/// notifications, using each activity's push token. That's future work; until then a post past
/// its time shows "Posting now…" until the app next opens.
@MainActor
final class ScheduledPostActivities {
    /// The sync in progress. Each waits for the one before, so two close together (a refresh and
    /// an approval) can't both start an activity for the same post.
    private var latest: Task<Void, Never>?

    func sync(with proposals: [Proposal], connections: [Connection], now: Date = .now) async {
        let previous = latest
        let showing = ScheduledPostPlan.isEnabled
        let task = Task {
            await previous?.value
            await Self.apply(proposals: proposals, connections: connections, showing: showing, now: now)
        }
        latest = task
        await task.value
    }

    /// Off the main actor: an `Activity` can't be passed between actors, so everything that
    /// touches one happens here.
    private nonisolated static func apply(proposals: [Proposal], connections: [Connection], showing: Bool, now: Date) async {
        let activities = Activity<ScheduledPostAttributes>.activities.filter {
            $0.activityState == .active || $0.activityState == .stale || $0.activityState == .pending
        }
        let plan = ScheduledPostPlan.plan(proposals: proposals,
                                          running: activities.map(\.attributes.proposalId),
                                          showing: showing,
                                          canStart: ActivityAuthorizationInfo().areActivitiesEnabled,
                                          now: now)
        for proposal in plan.start {
            guard let content = content(for: proposal) else { continue }
            let attributes = ScheduledPostAttributes(
                proposalId: proposal.id,
                platform: ScheduledPostPlan.platformName(for: proposal, connections: connections))
            // Fails in the background (a Siri request that refreshed the proposals); the next
            // time the app is open starts it.
            _ = try? Activity.request(attributes: attributes, content: content, pushType: nil)
        }
        for proposal in plan.update {
            guard let content = content(for: proposal) else { continue }
            for activity in activities where activity.attributes.proposalId == proposal.id
                && (activity.content.state != content.state || activity.content.staleDate != content.staleDate) {
                await activity.update(content)
            }
        }
        for finish in plan.finish {
            for activity in activities where activity.attributes.proposalId == finish.proposalId {
                var state = activity.content.state
                state.status = finish.status
                await activity.end(ActivityContent(state: state, staleDate: nil),
                                   dismissalPolicy: .after(now.addingTimeInterval(ScheduledPostPlan.dismissAfter)))
            }
        }
        for id in plan.remove {
            for activity in activities where activity.attributes.proposalId == id {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
    }

    /// Counting down to the post's time, and out of date a few minutes after it, when the Lock
    /// Screen says "Posting now…".
    private nonisolated static func content(for proposal: Proposal) -> ActivityContent<ScheduledPostAttributes.ContentState>? {
        guard let at = proposal.postAt else { return nil }
        let state = ScheduledPostAttributes.ContentState(postAt: at, summary: proposal.summary,
                                                         status: ScheduledPostAttributes.Status.scheduled)
        return ActivityContent(state: state, staleDate: at.addingTimeInterval(ScheduledPostPlan.staleAfter))
    }
}
#endif
