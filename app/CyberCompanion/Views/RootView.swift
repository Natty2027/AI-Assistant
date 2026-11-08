import SwiftUI

/// Tabs on iPhone, a sidebar on iPad and Mac.
struct RootView: View {
    enum Section: Hashable {
        case create, review, website, accounts, settings
    }

    @Environment(AppModel.self) private var model
    @State private var selection: Section = .create

    var body: some View {
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
}
