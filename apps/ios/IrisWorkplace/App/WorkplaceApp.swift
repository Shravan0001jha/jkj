import SwiftUI
import UserNotifications

@main
struct WorkplaceApp: App {
    @State private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let notifier = LocalNotifier()
        let m = AppModel(notifier: notifier)
        _model = State(initialValue: m)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .onAppear {
                    model.alerts.isActive = { UIApplication.shared.applicationState == .active }
                    model.start()
                }
                .onChange(of: model.hasCredential, initial: true) { _, has in
                    // Ask for notifications once there is something to be notified about.
                    if has { LocalNotifier.requestPermission() }
                }
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active: model.foreground()
                    case .background: model.background()
                    default: break
                    }
                }
        }
    }
}

/// A local notification for an alert that arrives while the app is not on screen. Real reach when
/// the app is closed needs APNs, which is a follow-up; this covers the minutes iOS keeps the socket
/// alive after backgrounding.
final class LocalNotifier: Notifier {
    static func requestPermission() {
        #if DEBUG
        if ProcessInfo.processInfo.environment["WORKPLACE_NO_NOTIF_PROMPT"] == "1" { return }
        #endif
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func notify(_ alert: AlertEvent) {
        let content = UNMutableNotificationContent()
        content.title = alert.title
        content.body = alert.body
        content.sound = alert.level == .info ? nil : .default
        content.threadIdentifier = alert.level.rawValue
        if let inboxId = alert.inboxId { content.userInfo = ["inboxId": inboxId] }
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
