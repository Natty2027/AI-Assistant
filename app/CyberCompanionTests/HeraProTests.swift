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
}
