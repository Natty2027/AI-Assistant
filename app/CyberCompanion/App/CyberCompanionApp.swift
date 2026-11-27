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
        // "What needs my approval?" and "What's coming up?" answer from the app's own client and
        // proposals. AppModel is main-actor isolated, which is what makes it safe to share.
        AppDependencyManager.shared.add(dependency: model)
        // Also before launch finishes, so tapping a reminder that opened the app is still heard.
        reminderDelivery = ReminderDelivery(
            speak: { [weak model] spoken in model?.speech.speak(spoken) },
            openEmail: { [weak model] id in model?.openRemindedEmail(id) })
        UNUserNotificationCenter.current().delegate = reminderDelivery
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(conversations)
                .task { await model.refreshAll() }
                // Purchases, renewals and refunds, sent to the server as they happen.
                .task { model.pro.start { model.client } }
                // An event added, moved or deleted anywhere (Calendar, Outlook, Gmail, Hera)
                // updates the widget and the reminders.
                .task {
                    for await _ in NotificationCenter.default.notifications(named: .EKEventStoreChanged) {
                        await model.refreshWidget()
                    }
                }
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active:
                        Task {
                            // Side by side. At launch this joins the refresh refreshAll starts
                            // rather than running a second one (see refreshWidget).
                            async let widget: Void = model.refreshWidget()
                            // A scheduled post may have gone out while Hera was closed.
                            async let posts: Void = model.refreshScheduledPosts()
                            _ = await (widget, posts)
                        }
                        // A text shared to Hera from Messages while she was closed.
                        model.collectSharedText()
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
