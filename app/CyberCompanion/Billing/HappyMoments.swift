import Foundation

/// When to ask for an App Store rating: right after something went well (a post or a
/// listing went live), on the 3rd, 10th and 30th success, and at most once per app version.
/// Apple decides whether the prompt actually appears (at most three times a year).
enum HappyMoments {
    nonisolated static let successesKey = "successfulPublishes"
    nonisolated static let askedVersionKey = "ratingAskedForVersion"
    nonisolated static let askAt: Set<Int> = [3, 10, 30]

    /// Counts one success and says whether this is a good moment to ask for a rating.
    static func recordSuccess(defaults: UserDefaults = .standard, version: String = currentVersion) -> Bool {
        let count = defaults.integer(forKey: successesKey) + 1
        defaults.set(count, forKey: successesKey)
        guard askAt.contains(count), defaults.string(forKey: askedVersionKey) != version else { return false }
        defaults.set(version, forKey: askedVersionKey)
        return true
    }

    static var currentVersion: String {
        let info = Bundle.main.infoDictionary
        return "\(info?["CFBundleShortVersionString"] as? String ?? "0")(\(info?["CFBundleVersion"] as? String ?? "0"))"
    }
}

/// When to suggest Hera Pro without getting in the way: once three quarters of the month's free
/// requests are used (dismissible, once a month), and after something went live on the free plan.
enum UpgradeNudge {
    nonisolated static let dismissedMonthKey = "upgradeNudgeDismissedMonth"

    /// True when the free plan is three quarters used this month and the nudge wasn't dismissed.
    static func shouldShow(_ status: PlanStatus?, defaults: UserDefaults = .standard, now: Date = .now) -> Bool {
        guard let status, !status.isPro, status.enforced, status.limit > 0 else { return false }
        guard Double(status.used) >= Double(status.limit) * 0.75 else { return false }
        return defaults.string(forKey: dismissedMonthKey) != month(now)
    }

    static func dismiss(defaults: UserDefaults = .standard, now: Date = .now) {
        defaults.set(month(now), forKey: dismissedMonthKey)
    }

    private static func month(_ date: Date) -> String {
        let c = Calendar(identifier: .gregorian).dateComponents(in: TimeZone(identifier: "UTC")!, from: date)
        return String(format: "%04d-%02d", c.year ?? 0, c.month ?? 0)
    }
}
