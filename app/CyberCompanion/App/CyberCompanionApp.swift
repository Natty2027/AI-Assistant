import AppIntents
import EventKit
import SwiftUI
import UserNotifications

@main
struct CyberCompanionApp: App {
    @State private var model: AppModel
    @State private var conversations: ConversationRequests
    @Environment(\.scenePhase) private var scenePhase
    /// Kept here because the notification center holds its delegate weakly.
    private let reminderDelivery: ReminderDelivery

    init() {
        let model = AppModel()
        _model = State(initialValue: model)
        let conversations = ConversationRequests()
        _conversations = State(initialValue: conversations)
        // Registered here, not from a view: Siri can launch the app cold and run the intent
        // before any screen appears, and an unregistered dependency is a crash.
        AppDependencyManager.shared.add(dependency: conversations)
        // Also before launch finishes, so tapping a reminder that opened the app is still heard.
        reminderDelivery = ReminderDelivery { [weak model] spoken in model?.speech.speak(spoken) }
        UNUserNotificationCenter.current().delegate = reminderDelivery
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(conversations)
                .task { await model.refreshAll() }
                // An event added, moved or deleted anywhere (Calendar, Outlook, Gmail, Hera)
                // updates the widget and the reminders.
                .task {
                    for await _ in NotificationCenter.default.notifications(named: .EKEventStoreChanged) {
                        await model.refreshWidget()
                    }
                }
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active: Task { await model.refreshWidget() }
                    case .background: EventReminders.scheduleBackgroundUpdate()
                    default: break
                    }
                }
        }
        .defaultSize(width: 1000, height: 720)
        // The window can't be made smaller than the app's own minimum size (RootView).
        .windowResizability(.contentMinSize)
        #if os(iOS)
        .backgroundTask(.appRefresh(EventReminders.refreshTaskID)) { [model] in
            EventReminders.scheduleBackgroundUpdate()
            await model.refreshReminders(mayAsk: false)
        }
        #endif
    }
}
