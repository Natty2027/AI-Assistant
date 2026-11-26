#if os(iOS)
import ActivityKit
import Foundation

/// A scheduled post on the Lock Screen and in the Dynamic Island: where it's going, and a
/// countdown to when it goes out.
///
/// The app has its own copy in CyberCompanion/LiveActivity/ScheduledPostAttributes.swift, and the
/// two must stay identical: ActivityKit matches the app's activity to the extension's views by
/// the type's name and shape.
struct ScheduledPostAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// When the server posts it.
        var postAt: Date
        var summary: String
        /// One of `Status`.
        var status: String
    }

    /// What `ContentState.status` can be.
    enum Status {
        static let scheduled = "scheduled"
        static let posted = "posted"
        static let failed = "failed"
        static let cancelled = "cancelled"
    }

    var proposalId: String
    /// "Instagram", as people say it.
    var platform: String
}
#endif
