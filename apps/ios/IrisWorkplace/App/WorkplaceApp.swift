import SwiftUI
import UserNotifications

@main
struct WorkplaceApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let notifier = LocalNotifier()
        let m = AppModel(notifier: notifier, cache: DiskCache.appDefault())
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
                    // Ask for notifications once there is something to be notified about, then register for pushes.
                    guard has else { return }
                    let push = AppDelegate.push
                    push.onToken = { [weak model] hex in model?.pushTokenReceived(hex) }
                    push.onTokenFailure = { [weak model] reason in model?.pushTokenFailed(reason) }
                    push.onOpen = { [weak model] link in model?.open(link) }
                    push.recentlyShownBySocket = { [weak model] inboxId, threadId in model?.alerts.recentlyShown(inboxId: inboxId, threadId: threadId) ?? false }
                    model.clearNotification = { PushManager.clear(inboxId: $0) }
                    model.housekeeping = { PushManager.housekeeping(openInboxIds: $0) }
                    LocalNotifier.requestPermission { granted in
                        Task { @MainActor in
                            model.pushPermissionDenied = !granted
                            if granted { push.register() }
                        }
                    }
                }
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active: model.foreground()
                    case .background: model.background()
                    default: break
                    }
                    ScreenAwake.update()
                }
                .onReceive(NotificationCenter.default.publisher(for: UIDevice.batteryStateDidChangeNotification)) { _ in
                    ScreenAwake.update()
                }
        }
    }
}

/// Keeps the screen on while the app is open and the phone is on power, so the Mac can drive
/// live checks on a cabled phone without it locking. On battery, Auto-Lock behaves as usual.
enum ScreenAwake {
    @MainActor static func update() {
        UIDevice.current.isBatteryMonitoringEnabled = true
        let state = UIDevice.current.batteryState
        UIApplication.shared.isIdleTimerDisabled = state == .charging || state == .full
    }
}

/// A local notification for an alert that arrives while the app is not on screen. Real reach when
/// the app is closed needs APNs, which is a follow-up; this covers the minutes iOS keeps the socket
/// alive after backgrounding.
final class LocalNotifier: Notifier {
    static func requestPermission(_ done: @escaping (Bool) -> Void = { _ in }) {
        #if DEBUG
        if ProcessInfo.processInfo.environment["WORKPLACE_NO_NOTIF_PROMPT"] == "1" { done(false); return }
        #endif
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in done(granted) }
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
