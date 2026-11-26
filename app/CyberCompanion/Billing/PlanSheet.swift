import StoreKit
import SwiftUI

/// Hera Pro, in Apple's own subscription sheet: prices, free trial and terms come from App Store
/// Connect, and Apple handles the payment. The purchase is tied to this Hera account.
struct PlanSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SubscriptionStoreView(productIDs: HeraPro.productIDs) {
                VStack(spacing: 14) {
                    IconTile(systemImage: "sparkles", size: 56)
                    Text("Hera Pro")
                        .font(Theme.heading())
                        .foregroundStyle(Theme.spectrumGradient)
                    if let status = model.pro.status {
                        Text("Free plan: \(status.usageLine).")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Many more requests every month", systemImage: "bolt.fill")
                        Label("Posters, posts, eBay listings and launches", systemImage: "wand.and.stars")
                        Label("Cancel any time in your Apple account", systemImage: "checkmark.circle")
                    }
                    .labelStyle(.alignedIcon)
                    .font(.callout)
                }
                .padding()
            }
            .subscriptionStoreButtonLabel(.multiline)
            .storeButton(.visible, for: .restorePurchases)
            .inAppPurchaseOptions { _ in
                // Ties the purchase to this Hera account, so it can't be claimed by another.
                guard let id = model.session.userID.flatMap(UUID.init(uuidString:)) else { return [] }
                return [.appAccountToken(id)]
            }
            .onInAppPurchaseCompletion { _, result in
                if case .success(.success(let verification)) = result {
                    if let client = model.client, let updated = try? await client.redeemPurchase(signedTransaction: verification.jwsRepresentation) {
                        model.pro.apply(updated)
                    }
                    if case .verified(let transaction) = verification { await transaction.finish() }
                    dismiss()
                }
            }
            .navigationTitle("Plans")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
        }
        .frame(minWidth: 420, minHeight: 560)
    }
}
