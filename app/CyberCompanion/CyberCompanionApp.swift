import AppIntents
import SwiftUI

@main
struct CyberCompanionApp: App {
    @State private var model = AppModel()
    @State private var conversations: ConversationRequests

    init() {
        let conversations = ConversationRequests()
        _conversations = State(initialValue: conversations)
        // Registered here, not from a view: Siri can launch the app cold and run the intent
        // before any screen appears, and an unregistered dependency is a crash.
        AppDependencyManager.shared.add(dependency: conversations)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(conversations)
                .task { await model.refreshAll() }
        }
        .defaultSize(width: 1000, height: 720)
    }
}
