import Foundation
import UIKit
import UserNotifications
import LocalAuthentication

/// A deep link into the app: from a push's `link` (e.g. `inbox/in_x`), `irisworkplace://inbox/in_x`,
/// an Update's `href`, or the web's own hash form (`#/room/th_x`) that the server puts in Inbox links
/// and COO / Team Room escalations.
enum AppLink: Equatable {
    case inbox(String, decide: Bool)
    /// `inbox` with no id (the push burst summary, "N more things need you").
    case inboxList
    case room(String)
    /// `room` with no id: the Room tab.
    case roomList
    case employee(String)
    case office
    // v2 update hrefs (LLD §19.8): item/<id>, plan, releases/<postId>
    case item(String)
    case plan
    case updates
    case releasePost(String)
    /// `releases` with no id: the Ship-a-release sheet.
    case releases
    case features
    case spend

    /// Every form the server sends (packages/server/src): push.ts `inbox/<id>`, `inbox`, `office`,
    /// `employee/<id>` (and `item/<id>` once alerts carry their item); trail.ts / status.ts / rhythm.ts
    /// hrefs `item/<id>`, `inbox/<id>`, `plan`; room.ts / coo.ts `#/room/<id>`; trail.ts `#/item/<id>`;
    /// views.ts `#/employee/<id>?item=<id>` and `#/assign?item=<id>`; plus the web's other routes
    /// (`#/org`, `#/features`, `#/spend`, `#/releases`). Nil for anything that is not an app link
    /// (a web URL, the sign-in callback, an unknown route): a chat link then opens in Safari, and a
    /// push falls back through `resolve(userInfo:)`.
    static func parse(_ raw: String, decide: Bool = false) -> AppLink? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let u = URL(string: s), let scheme = u.scheme?.lowercased() {
            // irisworkplace://inbox/in_x → "inbox/in_x"; any other scheme is not ours.
            guard scheme == AuthCallback.scheme else { return nil }
            s = (u.host ?? "") + u.path + (u.query.map { "?" + $0 } ?? "")
        }
        // The web form: "#/room/th_x", "/#/room/th_x", "/room/th_x".
        s = String(s.drop { $0 == "/" || $0 == "#" })
        var query: [String: String] = [:]
        if let q = s.firstIndex(of: "?") {
            for pair in s[s.index(after: q)...].split(separator: "&") {
                let kv = pair.split(separator: "=", maxSplits: 1).map { String($0).removingPercentEncoding ?? String($0) }
                if kv.count == 2, !kv[1].isEmpty { query[kv[0]] = kv[1] }
            }
            s = String(s[..<q])
        }
        if s.hasSuffix("/") { s = String(s.dropLast()) }
        let parts = s.split(separator: "/", maxSplits: 1).map(String.init)
        guard let head = parts.first?.lowercased() else { return nil }
        let id = parts.count > 1 ? parts[1].removingPercentEncoding ?? parts[1] : ""
        switch head {
        case "inbox": return id.isEmpty ? .inboxList : .inbox(id, decide: decide)
        case "room", "rooms": return id.isEmpty ? .roomList : .room(id)
        case "employee", "talk": return id.isEmpty ? .office : .employee(id)
        case "office", "org": return .office
        case "item", "items": return id.isEmpty ? .plan : .item(id)
        // The web's assignment page: the item it is about.
        case "assign": return query["item"].map(AppLink.item) ?? .plan
        case "plan": return .plan
        case "updates": return .updates
        case "releases": return id.isEmpty ? .releases : .releasePost(id)
        case "features": return .features
        case "spend": return .spend
        default: return nil
        }
    }

    static func parse(url: URL) -> AppLink? { parse(url.absoluteString) }

    /// What tapping a notification opens: never nothing. The `link` first; an id the payload carries
    /// when the link is only a list (or missing, as in the app's own local notifications, which carry
    /// `inboxId` only); else the screen the category belongs to; else the Plan (home).
    static func resolve(userInfo info: [AnyHashable: Any], category: String = "", decide: Bool = false) -> AppLink {
        let str = { (k: String) -> String? in (info[k] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        let link = str("link").flatMap { parse($0, decide: decide) }
        switch link {
        case .some(.inboxList), .some(.office), .some(.plan), .some(.roomList), .some(.updates), .none: break
        case .some(let specific): return specific
        }
        if let id = str("inboxId") { return .inbox(id, decide: decide) }
        if let id = str("itemId") { return .item(id) }
        if let id = str("threadId") { return .room(id) }
        if let id = str("employeeId") { return .employee(id) }
        if let link { return link }
        switch category {
        case PushCategory.inbox: return .inboxList
        case PushCategory.room: return .roomList
        case PushCategory.update: return .updates
        case PushCategory.alert: return .office
        default: return .plan
        }
    }
}

enum PushCategory {
    static let inbox = "WP_INBOX"
    static let room = "WP_ROOM"
    static let alert = "WP_ALERT"
    /// v2: a pushed Update (started, blocked, the brief, the weekly review).
    static let update = "WP_UPDATE"
    static let open = "OPEN"
    static let decide = "DECIDE"

    static var all: Set<UNNotificationCategory> {
        let open = UNNotificationAction(identifier: Self.open, title: "Open", options: [.foreground])
        let decide = UNNotificationAction(identifier: Self.decide, title: "Decide", options: [.foreground])
        return [
            UNNotificationCategory(identifier: inbox, actions: [open, decide], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: room, actions: [open], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: alert, actions: [open], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: update, actions: [open], intentIdentifiers: [], options: []),
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
        case .unknown: return true   // a kind this app does not know yet: ask, to be safe
        }
    }
}

/// The device-owner check, injectable for tests.
protocol DeviceAuth {
    func verify(reason: String) async -> Bool
}

struct LocalDeviceAuth: DeviceAuth {
    func verify(reason: String) async -> Bool {
        #if DEBUG
        // Simulators have no passcode; scripted runs skip the check. Never compiled into a release build.
        if ProcessInfo.processInfo.environment["WORKPLACE_NO_DEVICE_AUTH"] == "1" { return true }
        #endif
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
    var onOpen: ((AppLink) -> Void)? {
        didSet { if let onOpen, let link = pendingLink { pendingLink = nil; onOpen(link) } }
    }
    /// Asked before showing a foreground push: did the socket already show this item/thread?
    var recentlyShownBySocket: ((_ inboxId: String?, _ threadId: String?) -> Bool)?

    /// The notification centre's delegate and categories. Called from `didFinishLaunching`: Apple
    /// delivers the tap that launched the app only to a delegate set before launch finishes.
    func install() {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().setNotificationCategories(PushCategory.all)
    }

    func register() {
        install()
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
        let content = response.notification.request.content
        guard response.actionIdentifier != UNNotificationDismissActionIdentifier else { return }
        let link = AppLink.resolve(userInfo: content.userInfo, category: content.categoryIdentifier,
                                   decide: response.actionIdentifier == PushCategory.decide)
        await MainActor.run { self.deliver(link) }
    }

    /// A tap that lands before the app has wired `onOpen` (a cold launch: iOS hands the tap to this
    /// delegate during launch, before the first view appears) waits here and is applied the moment
    /// `onOpen` is set. Only the latest tap is kept.
    private(set) var pendingLink: AppLink?

    func deliver(_ link: AppLink) {
        if let onOpen { onOpen(link) } else { pendingLink = link }
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

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Before this returns, or a tap that cold-launched the app is never delivered (it is not in
        // launchOptions either since iOS 10: the delegate's didReceive is the only path).
        MainActor.assumeIsolated { AppDelegate.push.install() }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in AppDelegate.push.onToken?(deviceToken.hexToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in AppDelegate.push.onTokenFailure?(error.localizedDescription) }
    }
}
