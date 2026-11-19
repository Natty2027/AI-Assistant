import Foundation
import Testing
@testable import CyberCompanion

struct HeraProTests {
    @Test func thePlanReadsAsUsageAndAResetDate() throws {
        let json = #"{"plan":"free","used":12,"limit":20,"resetsAt":"2026-12-01T00:00:00.000Z","enforced":true,"proExpiresAt":null}"#
        let status = try JSONDecoder().decode(PlanStatus.self, from: Data(json.utf8))
        #expect(!status.isPro)
        #expect(status.remaining == 8)
        #expect(status.usageLine == "12 of 20 requests used this month")
        #expect(status.resetsLine?.hasPrefix("Starts again December") == true)
    }

    private func status(used: Int, limit: Int = 20, plan: String = "free", enforced: Bool = true) -> PlanStatus {
        PlanStatus(plan: plan, used: used, limit: limit, resetsAt: nil, enforced: enforced, proExpiresAt: nil)
    }

    @Test func aRatingIsAskedForOnlyAfterTheThirdTenthAndThirtiethSuccessOncePerVersion() throws {
        let defaults = try #require(UserDefaults(suiteName: "HappyMomentsTests-\(UUID().uuidString)"))
        let asks = (1...12).map { _ in HappyMoments.recordSuccess(defaults: defaults, version: "1.0(19)") }
        #expect(asks.enumerated().filter(\.element).map { $0.offset + 1 } == [3], "the 10th is the same version: not again")
        let defaults2 = try #require(UserDefaults(suiteName: "HappyMomentsTests-\(UUID().uuidString)"))
        for i in 1...10 { _ = HappyMoments.recordSuccess(defaults: defaults2, version: i < 10 ? "1.0(19)" : "1.1(20)") }
        #expect(defaults2.string(forKey: HappyMoments.askedVersionKey) == "1.1(20)", "a new version may ask at the 10th")
    }

    @Test func theUpgradeCardShowsAtThreeQuartersOnTheFreePlanUntilClosedForTheMonth() throws {
        let defaults = try #require(UserDefaults(suiteName: "UpgradeNudgeTests-\(UUID().uuidString)"))
        #expect(!UpgradeNudge.shouldShow(status(used: 14), defaults: defaults))
        #expect(UpgradeNudge.shouldShow(status(used: 15), defaults: defaults))
        #expect(!UpgradeNudge.shouldShow(status(used: 15, limit: 300, plan: "pro"), defaults: defaults), "not for Pro")
        #expect(!UpgradeNudge.shouldShow(status(used: 19, enforced: false), defaults: defaults), "not while limits are off")
        #expect(!UpgradeNudge.shouldShow(nil, defaults: defaults))

        let november = Date(timeIntervalSince1970: 1_795_000_000)  // mid-November 2026
        UpgradeNudge.dismiss(defaults: defaults, now: november)
        #expect(!UpgradeNudge.shouldShow(status(used: 18), defaults: defaults, now: november))
        #expect(UpgradeNudge.shouldShow(status(used: 18), defaults: defaults, now: november.addingTimeInterval(31 * 86_400)), "back next month")
    }
}
