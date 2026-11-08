import SwiftUI

@main
struct CyberCompanionApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .task { await model.refreshAll() }
        }
        .defaultSize(width: 1000, height: 720)
    }
}
