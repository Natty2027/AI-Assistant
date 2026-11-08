import SwiftUI

/// Tabs on iPhone, a sidebar on iPad and Mac.
struct RootView: View {
    enum Section: Hashable {
        case create, review, website, accounts, settings
    }

    @Environment(AppModel.self) private var model
    @Environment(ConversationRequests.self) private var conversations
    @State private var selection: Section = .create

    var body: some View {
        if model.needsSignIn {
            SignInView()
                .transition(.opacity)
        } else {
            tabs
                .safeAreaInset(edge: .top) { offlineBanner }
                .animation(.spring(duration: 0.4), value: model.connectivity.isOnline)
                // "Talk to Hera" happens on the Create tab.
                .onChange(of: conversations.isPending, initial: true) { _, pending in
                    if pending { selection = .create }
                }
        }
    }

    @ViewBuilder
    private var offlineBanner: some View {
        if !model.connectivity.isOnline {
            Label("You're offline. Changes will need a connection.", systemImage: "wifi.slash")
                .font(.footnote.weight(.semibold))
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .glassEffect(.regular.tint(.orange.opacity(0.35)), in: .capsule)
                .padding(.top, 4)
                .transition(.move(edge: .top).combined(with: .opacity))
                .accessibilityAddTraits(.isStaticText)
        }
    }

    private var tabs: some View {
        TabView(selection: $selection) {
            Tab("Create", systemImage: "sparkles", value: .create) {
                AssistantView(openSettings: { selection = .settings }, openReview: { selection = .review })
            }
            Tab("Review", systemImage: "checkmark.seal", value: .review) {
                ReviewView()
            }
            .badge(model.pendingCount)
            Tab("Website", systemImage: "globe", value: .website) {
                SiteView()
            }
            Tab("Accounts", systemImage: "person.crop.circle.badge.plus", value: .accounts) {
                AccountsView()
            }
            Tab("Settings", systemImage: "gearshape", value: .settings) {
                SettingsView()
            }
        }
        .tabViewStyle(.sidebarAdaptable)
    }
}

#Preview {
    RootView()
        .environment(AppModel())
        .environment(ConversationRequests())
}
