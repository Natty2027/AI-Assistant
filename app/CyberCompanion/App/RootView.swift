import SwiftUI

/// Tabs on iPhone, a sidebar on iPad and Mac.
struct RootView: View {
    enum Section: Hashable {
        case create, review, accounts, settings
    }

    @Environment(AppModel.self) private var model
    @Environment(ConversationRequests.self) private var conversations
    @State private var selection: Section = .create
    /// A proposal to open on the Review tab, from a tapped Lock Screen countdown.
    @State private var reviewTarget: String?

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
                // "Ask Hera to make something" from Siri or a Shortcuts automation, too.
                .onChange(of: conversations.pendingCreation, initial: true) { _, creation in
                    if creation != nil { selection = .create }
                }
                // A scheduled post tapped on the Lock Screen or in the Dynamic Island.
                .onOpenURL { url in
                    guard case .review(let id) = DeepLink.parse(url) else { return }
                    selection = .review
                    reviewTarget = id
                }
                .sheet(isPresented: Bindable(model.pro).showPlans) { PlanSheet() }
                // An email reminder was tapped: the email, ready to send.
                .sheet(item: Bindable(model).remindedEmail) { draft in
                    NavigationStack {
                        ScrollView { EmailDraftCard(draft: draft).padding() }
                            .navigationTitle("Your email")
                            .toolbar {
                                ToolbarItem(placement: .confirmationAction) {
                                    Button("Done") {
                                        EmailReminders.cancel(draft.id)
                                        model.remindedEmail = nil
                                    }
                                }
                            }
                    }
                    .frame(minWidth: 420, minHeight: 520)
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
                ReviewView(open: $reviewTarget)
            }
            .badge(model.pendingCount)
            Tab("Accounts", systemImage: "person.crop.circle.badge.plus", value: .accounts) {
                AccountsView()
            }
            Tab("Settings", systemImage: "gearshape", value: .settings) {
                SettingsView()
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        #if os(macOS)
        // Small enough for half a laptop screen, big enough that nothing is squeezed out of line.
        .frame(minWidth: 640, minHeight: 560)
        #endif
    }
}

#Preview {
    RootView()
        .environment(AppModel())
        .environment(ConversationRequests())
}
