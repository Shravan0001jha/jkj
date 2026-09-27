import Foundation
import UIKit
import UserNotifications
import LocalAuthentication

/// A deep link into the app: from a push's `link` (e.g. `inbox/in_x`) or `irisworkplace://inbox/in_x`.
enum AppLink: Equatable {
    case inbox(String, decide: Bool)
    case room(String)
    case employee(String)
    case office

    static func parse(_ raw: String, decide: Bool = false) -> AppLink? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let u = URL(string: s), u.scheme?.lowercased() == AuthCallback.scheme {
            // irisworkplace://inbox/in_x → "inbox/in_x"
            s = ((u.host ?? "") + u.path).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
        let parts = s.split(separator: "/", maxSplits: 1).map(String.init)
        guard let head = parts.first?.lowercased() else { return nil }
        let id = parts.count > 1 ? parts[1].removingPercentEncoding ?? parts[1] : ""
        switch head {
        case "inbox": return id.isEmpty ? nil : .inbox(id, decide: decide)
        case "room": return id.isEmpty ? nil : .room(id)
        case "employee": return id.isEmpty ? nil : .employee(id)
        case "office": return .office
        default: return nil
        }
    }

    static func parse(url: URL) -> AppLink? { parse(url.absoluteString) }
}

enum PushCategory {
    static let inbox = "WP_INBOX"
    static let room = "WP_ROOM"
    static let alert = "WP_ALERT"
    static let open = "OPEN"
    static let decide = "DECIDE"

    static var all: Set<UNNotificationCategory> {
        let open = UNNotificationAction(identifier: Self.open, title: "Open", options: [.foreground])
        let decide = UNNotificationAction(identifier: Self.decide, title: "Decide", options: [.foreground])
        return [
            UNNotificationCategory(identifier: inbox, actions: [open, decide], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: room, actions: [open], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: alert, actions: [open], intentIdentifiers: [], options: []),
        ]
    }
}

/// Which answers need the device owner (Face ID / passcode) before they leave the phone:
/// dangerous options, and the kinds that gate outward actions or money.
enum AnswerGate {
    static func needsDeviceOwner(item: InboxItem, option: InboxOption) -> Bool {
        if option.danger == true { return true }
        switch item.kind {
        case .approval, .release, .orgChange, .cap: return true
        case .decision, .question: return false
        }
    }
}

/// The device-owner check, injectable for tests.
protocol DeviceAuth {
    func verify(reason: String) async -> Bool
}

struct LocalDeviceAuth: DeviceAuth {
    func verify(reason: String) async -> Bool {
        let ctx = LAContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else { return false }
        return (try? await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    }
}

/// The APNs token as the relay wants it: 64 lower-case hex characters.
extension Data {
    var hexToken: String { map { String(format: "%02x", $0) }.joined() }
}

/// The notification centre and the remote-notification callbacks, in one object owned by the
/// app delegate. It talks to the model through closures so it can be driven from tests.
@MainActor
final class PushManager: NSObject, UNUserNotificationCenterDelegate {
    var onToken: ((String) -> Void)?
    var onTokenFailure: ((String) -> Void)?
    var onOpen: ((AppLink) -> Void)?
    /// Asked before showing a foreground push: did the socket already show this item/thread?
    var recentlyShownBySocket: ((_ inboxId: String?, _ threadId: String?) -> Bool)?

    func register() {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().setNotificationCategories(PushCategory.all)
        UIApplication.shared.registerForRemoteNotifications()
    }

    // MARK: delegate

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let info = notification.request.content.userInfo
        let inboxId = Self.string(info["inboxId"]) ?? AppLink.parse(Self.string(info["link"]) ?? "").flatMap { if case .inbox(let id, _) = $0 { return id } else { return nil } }
        let threadId = Self.string(info["threadId"]) ?? AppLink.parse(Self.string(info["link"]) ?? "").flatMap { if case .room(let id) = $0 { return id } else { return nil } }
        let dup = await MainActor.run { self.recentlyShownBySocket?(inboxId, threadId) ?? false }
        return dup ? [] : [.banner, .sound, .badge]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let decide = response.actionIdentifier == PushCategory.decide
        guard let raw = Self.string(info["link"]), let link = AppLink.parse(raw, decide: decide) else { return }
        await MainActor.run { self.onOpen?(link) }
    }

    private nonisolated static func string(_ any: Any?) -> String? { any as? String }

    // MARK: housekeeping

    /// Remove delivered notifications for Inbox items that are no longer open; badge = open count.
    static func housekeeping(openInboxIds: Set<String>) {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
            let stale = delivered.filter { n in
                let info = n.request.content.userInfo
                let id = (info["inboxId"] as? String) ?? AppLink.parse((info["link"] as? String) ?? "").flatMap { if case .inbox(let id, _) = $0 { return id } else { return nil } }
                return id.map { !openInboxIds.contains($0) } ?? false
            }
            if !stale.isEmpty { center.removeDeliveredNotifications(withIdentifiers: stale.map(\.request.identifier)) }
        }
        center.setBadgeCount(openInboxIds.count)
    }

    /// The item was answered here: its notification goes.
    static func clear(inboxId: String) {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
            let ids = delivered.filter { n in
                let info = n.request.content.userInfo
                let id = (info["inboxId"] as? String) ?? AppLink.parse((info["link"] as? String) ?? "").flatMap { if case .inbox(let id, _) = $0 { return id } else { return nil } }
                return id == inboxId
            }.map(\.request.identifier)
            if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
        }
    }

    static func permissionStatus() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }
}

/// The delegate the app installs: it forwards the APNs callbacks to the `PushManager`.
final class AppDelegate: NSObject, UIApplicationDelegate {
    static let push = PushManager()

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in AppDelegate.push.onToken?(deviceToken.hexToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in AppDelegate.push.onTokenFailure?(error.localizedDescription) }
    }
}
