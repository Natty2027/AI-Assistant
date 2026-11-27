import Foundation
import Observation
import StoreKit

/// Hera Pro: the subscription, and this month's requests.
///
/// Purchases happen in Apple's own subscription sheet (PlanSheet). Each purchase carries the Hera
/// account id as its appAccountToken, and the App Store's signed transaction is sent to the server,
/// which checks Apple's signature before giving Pro. Renewals, refunds and purchases made on another
/// device arrive through Transaction.updates and are sent the same way.
@MainActor
@Observable
final class HeraPro {
    nonisolated static let productIDs = ["com.natty2027.hera.pro.monthly", "com.natty2027.hera.pro.yearly"]

    /// From the server: plan, requests used and allowed this month. nil until first loaded.
    private(set) var status: PlanStatus?
    /// Set when a request was refused because the month's requests are used up.
    var showPlans = false

    private var listening: Task<Void, Never>?

    /// Starts listening for purchases, renewals and refunds, and sends what's current to the server.
    func start(client: @escaping @MainActor () -> APIClient?) {
        guard listening == nil else { return }
        listening = Task { [weak self] in
            for await update in Transaction.updates {
                await self?.handle(update, client: client())
            }
        }
        Task { await sync(client: client()) }
    }

    /// Sends every current subscription to the server. Each one sent comes back with the plan as
    /// it now stands; the plan itself is loaded at launch with everything else (AppModel.refreshAll),
    /// so it isn't asked for a second time here.
    func sync(client: APIClient?) async {
        guard let client else { return }
        for await entitlement in Transaction.currentEntitlements {
            await handle(entitlement, client: client, refresh: false)
        }
    }

    func apply(_ latest: PlanStatus) { status = latest }

    func refresh(client: APIClient?) async {
        guard let client else { return }
        if let latest = try? await client.planStatus() { status = latest }
    }

    private func handle(_ result: VerificationResult<Transaction>, client: APIClient?, refresh: Bool = true) async {
        // Only transactions StoreKit verified on the device; the server checks Apple's signature again.
        guard case .verified(let transaction) = result, Self.productIDs.contains(transaction.productID), let client else { return }
        if let updated = try? await client.redeemPurchase(signedTransaction: result.jwsRepresentation) { status = updated }
        await transaction.finish()
        if refresh { await self.refresh(client: client) }
    }
}

/// The person's plan as the server sees it (server/billing.ts).
struct PlanStatus: Codable, Hashable, Sendable {
    let plan: String
    let used: Int
    let limit: Int
    let resetsAt: String?
    /// False while limits are off on the server: nothing is stopped yet.
    let enforced: Bool
    let proExpiresAt: String?

    var isPro: Bool { plan == "pro" }
    var remaining: Int { max(0, limit - used) }

    /// "12 of 20 requests used this month".
    var usageLine: String { "\(used) of \(limit) requests used this month" }

    var resetsLine: String? {
        guard let resetsAt else { return nil }
        // The server writes milliseconds ("…T00:00:00.000Z"); accept it with or without them.
        let reader = ISO8601DateFormatter()
        reader.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = reader.date(from: resetsAt) ?? ISO8601DateFormatter().date(from: resetsAt) else { return nil }
        // Months start at midnight UTC on the server; shown as that date, not the evening before.
        var style = Date.FormatStyle.dateTime.month(.wide).day()
        style.timeZone = TimeZone(identifier: "UTC")!
        return "Starts again \(date.formatted(style))"
    }
}
