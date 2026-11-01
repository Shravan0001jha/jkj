import Foundation
import Observation
import UIKit

enum Connection: Equatable {
    /// No credential for the current mode: relay → sign in; LAN → pair.
    case signedOut
    case connecting
    case online(version: String)
    /// Cannot reach the server (network, DNS, relay down). Retried with backoff.
    case offline(reason: String, retryAt: Date?)
    /// The relay answers, but the Mac's tunnel to it is down. Probed every few seconds.
    case macOffline
    /// The owner switched published access off. Probed every few seconds.
    case accessOff
    /// The relay confirmed the credential is no longer valid (a 401 on the health probe): sign in
    /// again (relay) or re-pair (LAN). Never set from a socket close or an outage alone. Cached lists
    /// stay on screen under a "Sign in again" strip; only an explicit Sign out clears them.
    case unauthorized
}

/// v2: Plan is home; Updates replaces the Office counters. Releases live in the Room (the
/// Releases room), and the Office and Features open from the Plan's menu — six tabs would put
/// half of them behind iOS's own "More".
///
/// Nov 2026: the Dashboard tab (HLD-dashboard) holds two panes, the dashboard and Updates —
/// "what is planned by when" next to "what happened" — so the bar stays at five. `.updates` is
/// still its own value (deep links, `WORKPLACE_TAB`): it means the Dashboard tab's Updates pane.
enum Tab: String, CaseIterable {
    case plan, inbox, talk, room, updates, dashboard

    /// The tab bar's items, in order. Never more than five, or iOS adds "More".
    static let bar: [Tab] = [.plan, .inbox, .talk, .room, .dashboard]
}

/// Cross-tab navigation: an alert opens its Inbox item, an Office card opens Talk.
@MainActor @Observable
final class Router {
    var tab: Tab = .plan { didSet { if tab == .updates || tab == .dashboard { dashboardPane = tab } } }
    /// The Dashboard tab's pane last shown (`.dashboard` or `.updates`), restored when the tab is tapped.
    private(set) var dashboardPane: Tab = .dashboard
    /// What the tab bar shows as selected: the Updates pane lives under the Dashboard tab.
    var barSelection: Tab {
        get { tab == .updates ? .dashboard : tab }
        set { tab = newValue == .dashboard ? dashboardPane : newValue }
    }
    var inboxItemId: String?
    /// An epic/story/task page to open on the Plan (from a push, an Update, a release change).
    var itemId: String?
    var releasePostId: String?
    var showOffice = false
    var showFeatures = false
    /// The Plan shows the board by state instead of the areas.
    var planBoard = false
    var talkEmployeeId: String?
    var featureId: String?
    var pivot: PivotRows?
    var roomThreadId: String?
    /// A room to open on the Room tab (the Sci-fi command palette).
    var roomId: String?
    /// Set by a push's DECIDE action: the item opens with its options in view.
    var decideItemId: String?
    var showSettings = false
    var showAlerts = false
    var showSpend = false
    var showNewRequest = false
    var showReleases = false
    var proposalId: String?
    var featuresSegment: String?

    /// Set to show a tab's list itself (pops whatever page that tab had open); the tab clears it.
    var inboxList = false
    var roomList = false
    var talkList = false
    /// Push the chat's profile on top of the chat `talkEmployeeId` opens (DEBUG screenshots).
    var talkProfile = false

    func openInbox(_ id: String) { closeSheets(); inboxItemId = id; tab = .inbox }
    func openInboxList() { closeSheets(); inboxItemId = nil; inboxList = true; tab = .inbox }
    func openThread(_ id: String) { closeSheets(); roomThreadId = id; tab = .room }
    func openRoomList() { closeSheets(); roomThreadId = nil; roomList = true; tab = .room }
    func openRoom(_ id: String) { closeSheets(); roomId = id; tab = .room }
    func talk(to employeeId: String) { closeSheets(); talkEmployeeId = employeeId; tab = .talk }
    func openTalkList() { closeSheets(); talkEmployeeId = nil; talkList = true; tab = .talk }
    func openItem(_ id: String) { closeSheets(); itemId = id; tab = .plan }
    func openReleasePost(_ id: String) { closeSheets(); releasePostId = id; tab = .room }

    /// A jump to another tab from a sheet (the Office's cards, an alert, a notification tap) closes
    /// the sheet first. A half-written new request is left open.
    func closeSheets() {
        showOffice = false; showFeatures = false; showAlerts = false
        showSettings = false; showSpend = false; showReleases = false
    }
}

/// Owns the mode, the credential, the clients and the stores. One per app.
@MainActor @Observable
final class AppModel {
    private(set) var connection: Connection = .signedOut
    private(set) var config: ServerConfig = .relay
    private(set) var rest: RestClient?
    private(set) var health: WorkplaceHealthResponse?
    private(set) var lastSocketError: String?
    private var socket: SocketClient?
    /// True while the live socket is open. A chat on screen polls lightly while it is false.
    private(set) var socketIsOpen = false
    /// Talk threads on screen right now (thread id -> how many views show it). A reconnect re-fetches
    /// them: events sent while the socket was down (tunnel blip, app in the background) are never
    /// replayed, so without this an agent's reply only appeared after leaving and re-opening the chat.
    private(set) var openChats: [String: Int] = [:]
    /// Chats visible right now, Talk and room threads (thread id -> views): a push for one of them
    /// only taps (§6.4). Separate from `openChats`, which re-syncs Talk threads only.
    private(set) var visibleChats: [String: Int] = [:]
    /// Removes a chat's delivered notifications (installed by the app; nil in tests).
    var clearChatNotifications: ((String) -> Void)?
    private var everOpened = false

    let office = OfficeStore()
    let inbox = InboxStore()
    let talk = TalkStore()
    let features = FeaturesStore()
    let room = RoomStore()
    let coo = CooStore()
    let requests = RequestsStore()
    // v2
    let plan = PlanStore()
    let items = ItemsStore()
    let updates = UpdatesStore()
    let rooms = RoomsStore()
    let releasePosts = ReleasePostsStore()
    // Rework (Oct 2026): Settings
    let superFocus = SuperFocusStore()
    let macQueue = MacQueueStore()
    /// Chat files fetched with the session's credential, cached on disk.
    let attachments = AttachmentCache()
    /// Talk list pins and read marks (this phone's own).
    let talkPrefs: TalkPrefs
    /// Talk threads (LLD-app-fixes): nil-supported until the server answers; 404 keeps the old chat.
    let talkThreads = TalkThreadsStore()
    /// The mini dashboard (HLD-dashboard): the cached metrics snapshot, refreshed in the background.
    let dashboard = DashboardStore()
    /// Per-chat mute (CHAT-NOTIFY-CONTRACT §2): the server's, mirrored on this phone.
    let chatPrefs: ChatPrefsStore
    private var planReload: Task<Void, Never>?
    let alerts: AlertsStore
    /// Releases updated over the socket, and their streamed log lines.
    private(set) var releases: [String: Release] = [:]
    private(set) var releaseLog: [String: [String]] = [:]
    let router = Router()

    private let relayTokens: TokenStore
    private let lanTokens: TokenStore
    private let defaults: UserDefaults
    private let makeTransport: () -> SocketTransport
    private let urlSession: URLSession
    private let env: [String: String]
    private let webAuth: WebAuth
    private let offlineProbeInterval: TimeInterval
    private let pathMonitor: PathMonitoring?
    let deviceAuth: DeviceAuth
    /// The phone's copy of the main lists (DiskCache): shown at connect, refreshed by `loadAll()`.
    let cache: DiskCache?
    private var connectTask: Task<Void, Never>?
    private var offlineTask: Task<Void, Never>?

    // Push (LLD-workplace-push §6): the token from APNs, and whether the relay accepted it.
    private(set) var pushToken: String?
    private(set) var pushRegistered = false
    private(set) var pushProblem: String?
    var pushPermissionDenied = false
    /// Hooks the app installs: clear a delivered notification, keep the badge and delivered list tidy.
    var clearNotification: ((String) -> Void)?
    var housekeeping: ((Set<String>) -> Void)?

    init(relayTokens: TokenStore = Keychain.relay,
         lanTokens: TokenStore = Keychain.lan,
         defaults: UserDefaults = .standard,
         notifier: Notifier? = nil,
         urlSession: URLSession = .shared,
         makeTransport: @escaping () -> SocketTransport = { URLSessionSocketTransport() },
         webAuth: WebAuth? = nil,
         env: [String: String] = ProcessInfo.processInfo.environment,
         offlineProbeInterval: TimeInterval = 15,
         pathMonitor: PathMonitoring? = NetworkMonitor(),
         deviceAuth: DeviceAuth = LocalDeviceAuth(),
         cache: DiskCache? = nil) {
        self.relayTokens = relayTokens
        self.lanTokens = lanTokens
        self.defaults = defaults
        self.alerts = AlertsStore(notifier: notifier)
        self.talkPrefs = TalkPrefs(defaults: defaults)
        self.chatPrefs = ChatPrefsStore(defaults: defaults)
        self.urlSession = urlSession
        self.makeTransport = makeTransport
        self.webAuth = webAuth ?? ASWebAuth()
        self.env = env
        self.offlineProbeInterval = offlineProbeInterval
        self.pathMonitor = pathMonitor
        self.deviceAuth = deviceAuth
        self.cache = cache
        office.cache = cache
        inbox.cache = cache
        plan.cache = cache
        rooms.cache = cache
        dashboard.cache = cache
        pathMonitor?.onChange = { [weak self] satisfied in self?.networkChanged(satisfied: satisfied) }
        pathMonitor?.start()
        alerts.suppressLocal = { [weak self] in self?.pushRegistered ?? false }
        plan.onStale = { [weak self] in self?.reloadPlanSoon() }
        attachments.fetch = { [weak self] path in
            guard let rest = await self?.rest else { throw WorkplaceError.notPaired }
            return try await rest.download(path)
        }
    }

    /// A story moved: its epic card's progress and flags changed. One reload for a burst of moves.
    private func reloadPlanSoon() {
        planReload?.cancel()
        planReload = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled, let self, let rest = self.rest else { return }
            await self.plan.load(rest)
            if self.plan.board != nil { await self.plan.loadBoard(rest) }
        }
    }

    /// Wi-Fi ↔ cellular or airplane mode: reconnect now, or say there is no network.
    func networkChanged(satisfied: Bool) {
        guard hasCredential else { return }
        if satisfied {
            switch connection {
            case .online: socket?.reconnectNow()
            case .connecting, .unauthorized, .signedOut: break   // a connect is in flight, or there is nothing to connect with
            default: connect()
            }
        } else {
            switch connection {
            case .unauthorized, .signedOut: break
            default: connection = .offline(reason: "No internet connection", retryAt: nil)
            }
        }
    }

    /// The credential store for the current mode.
    private var tokens: TokenStore { config.mode == .relay ? relayTokens : lanTokens }
    /// Stored, not computed from the Keychain, so SwiftUI re-renders when it changes. True also while
    /// the token is there but unreadable (protected data locked): that is never "signed out".
    private(set) var hasCredential = false
    /// The Keychain refused the read (phone locked since a reboot, or a transient failure); retried on foreground.
    private(set) var credentialUnreadable = false
    private func syncCredential() {
        let read = tokens.read()
        credentialUnreadable = read == .unavailable
        hasCredential = read != .absent
    }
    static let waitingForUnlock = "Waiting for the phone to unlock"
    var mode: ServerMode { config.mode }
    /// The LAN address a developer paired with earlier, if any.
    var savedLANURL: URL? { ServerConfig.savedLAN(defaults: defaults) }

    // MARK: lifecycle

    /// Boot: load the mode and address, connect if there is a credential.
    func start() {
        config = ServerConfig.load(defaults: defaults, env: env)
        #if DEBUG
        // Scripted runs: start from a clean slate, or skip sign-in with a known credential.
        if env["WORKPLACE_FORGET"] == "1" { relayTokens.clear(); lanTokens.clear() }
        if let t = env["WORKPLACE_TOKEN"], !t.isEmpty { tokens.save(token: t) }
        #endif
        syncCredential()
        guard hasCredential else { connection = .signedOut; return }
        if credentialUnreadable { connection = .offline(reason: Self.waitingForUnlock, retryAt: nil) } else { connect() }
        #if DEBUG
        // Scripted runs (screenshots) open a screen directly.
        if let t = env["WORKPLACE_TAB"], let tab = Tab(rawValue: t) { router.tab = tab }
        if env["WORKPLACE_TAB"] == "office" { router.showOffice = true }
        if let id = env["WORKPLACE_ITEM"] { router.openItem(id) }
        if let id = env["WORKPLACE_RELEASE_POST"] { router.openReleasePost(id) }
        if env["WORKPLACE_BOARD"] == "1" { router.planBoard = true }
        if let id = env["WORKPLACE_INBOX_ITEM"] { router.openInbox(id) }
        if let id = env["WORKPLACE_TALK"] { router.talk(to: id) }
        if let id = env["WORKPLACE_CHAT_PROFILE"] { router.talk(to: id); router.talkProfile = true }
        if let id = env["WORKPLACE_FEATURE"] { router.featureId = id; router.showFeatures = true }
        if let id = env["WORKPLACE_ROOM"] { if id == "list" { router.tab = .room } else { router.openThread(id) } }
        if env["WORKPLACE_SPEND"] == "1" { router.showSpend = true }
        if env["WORKPLACE_NEW_REQUEST"] == "1" { router.showNewRequest = true }
        if env["WORKPLACE_RELEASES"] == "1" { router.showReleases = true }
        if env["WORKPLACE_FEATURES"] == "requests" { router.showFeatures = true; router.featuresSegment = "requests" }
        if env["WORKPLACE_ALERTS"] == "1" { router.showAlerts = true }
        if let p = env["WORKPLACE_PIVOT"], let rows = PivotRows(rawValue: p) { router.pivot = rows; router.showFeatures = true }
        if env["WORKPLACE_SETTINGS"] == "1" { router.showSettings = true }
        #endif
    }

    // MARK: relay sign-in

    /// Runs the relay's web sign-in (or first-time passkey enrolment) and keeps the session.
    func signIn(enrol: Bool = false) async throws {
        if config.mode != .relay { useRelay(connect: false) }
        let callback = try await webAuth.signIn(startURL: enrol ? config.enrolURL : config.loginURL)
        guard let token = AuthCallback.parse(callback) else {
            throw WorkplaceError.transport("The sign-in page did not return a session to the app.")
        }
        relayTokens.save(token: token)
        syncCredential()
        connect()
        Task { await registerPush() }
    }

    /// A URL that reached the app: the sign-in callback, or a deep link (`irisworkplace://inbox/<id>`).
    @discardableResult
    func handleOpenURL(_ url: URL) -> Bool {
        if let token = AuthCallback.parse(url) {
            if config.mode != .relay { useRelay(connect: false) }
            relayTokens.save(token: token)
            syncCredential()
            connect()
            Task { await registerPush() }
            return true
        }
        if let link = AppLink.parse(url: url) { open(link); return true }
        return false
    }

    /// Route a deep link (from a push, a notification action or a URL).
    func open(_ link: AppLink) {
        switch link {
        case .inbox(let id, let decide): router.openInbox(id); router.decideItemId = decide ? id : nil
        case .inboxList: router.openInboxList()
        case .room(let id): router.openThread(id)
        case .roomList: router.openRoomList()
        case .employee(let id): router.talk(to: id)
        case .office: router.closeSheets(); router.showOffice = true
        case .item(let id): router.openItem(id)
        case .plan: router.closeSheets(); router.tab = .plan
        case .updates: router.closeSheets(); router.tab = .updates
        case .releasePost(let id): router.openReleasePost(id)
        case .releases: router.closeSheets(); router.showReleases = true
        case .features: router.closeSheets(); router.showFeatures = true
        case .spend: router.closeSheets(); router.showSpend = true
        case .chat(let id): router.talk(to: id)
        case .talkList: router.openTalkList()
        }
    }

    // MARK: push

    /// APNs gave a token: keep it and tell the relay (every launch and foreground; it only refreshes last_seen).
    func pushTokenReceived(_ hex: String) {
        pushToken = hex
        Task { await registerPush() }
    }

    func pushTokenFailed(_ reason: String) {
        pushProblem = reason
        pushRegistered = false
    }

    static var pushEnvironment: PushEnvironment {
        #if DEBUG
        return .sandbox
        #else
        return .production
        #endif
    }

    func registerPush() async {
        guard config.mode == .relay, hasCredential, let token = pushToken, let rest else { return }
        do {
            _ = try await rest.registerPush(token: token, env: Self.pushEnvironment, device: UIDevice.current.model)
            pushRegistered = true
            pushProblem = nil
        } catch {
            pushRegistered = false
            pushProblem = error.localizedDescription
        }
    }

    /// One line for Settings: does this phone get pushes, and if not, why.
    var pushStatusLine: String {
        if pushPermissionDenied { return "No — notifications are off for this app in iOS Settings" }
        if config.mode != .relay { return "No — pushes come through the relay only" }
        if pushToken == nil { return "No — no device token yet" }
        if pushRegistered { return "Yes" }
        return "No — " + (pushProblem ?? "not registered with the relay yet")
    }

    /// Forget the relay session and go back to the sign-in screen.
    func signOut() {
        // Best effort, never waited on: drop this phone's push registration and end the session on
        // the relay (POST /logout), so a forgotten token is dead there too. Sent with a copy of the
        // token: the Keychain is cleared below before these requests are built.
        if config.mode == .relay, let session = relayTokens.token {
            let farewell = RestClient(config: config, tokens: MemoryTokenStore(token: session), session: urlSession)
            let device = pushRegistered ? pushToken : nil
            Task {
                if let device { try? await farewell.unregisterPush(token: device) }
                try? await farewell.logout()
            }
        }
        pushRegistered = false
        stopConnections()
        cache?.clearAll()   // nothing from this session stays on the phone
        dashboard.clear()
        relayTokens.clear()
        syncCredential()
        health = nil
        rest = nil
        connection = .signedOut
    }

    /// Switch to the public relay (the default). Keeps any LAN pairing for later.
    func useRelay(connect shouldConnect: Bool = true) {
        stopConnections()
        var cfg = ServerConfig.relay
        if let raw = defaults.string(forKey: ServerConfig.relayURLKey), let u = ServerConfig.parse(raw) { cfg.baseURL = u }
        #if DEBUG
        if let raw = env["WORKPLACE_RELAY_URL"], let u = ServerConfig.parse(raw) { cfg.baseURL = u }
        #endif
        config = cfg
        config.save(defaults: defaults)
        syncCredential()
        health = nil
        rest = nil
        if shouldConnect { if hasCredential { connect() } else { connection = .signedOut } }
    }

    // MARK: LAN pairing (developer option)

    /// Pair with a LAN Workplace: exchange the one-time code, keep the token, switch to LAN mode.
    func pair(urlText: String, code: String) async throws {
        guard let url = ServerConfig.parse(urlText) else {
            throw WorkplaceError.transport("Enter the server address as host:port, for example 192.168.1.5:4317.")
        }
        let cfg = ServerConfig(mode: .lan, baseURL: url)
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw WorkplaceError.transport("Enter the pairing code shown on the Mac.") }
        let token = try await RestClient.exchange(config: cfg, code: trimmed, session: urlSession)
        stopConnections()
        lanTokens.save(token: token)
        cfg.save(defaults: defaults)
        config = cfg
        syncCredential()
        health = nil
        connect()
    }

    /// Forget the LAN token and address and go back to the relay.
    func unpair() {
        stopConnections()
        lanTokens.clear()
        ServerConfig.forgetLAN(defaults: defaults)
        useRelay()   // syncs the credential for relay mode
    }

    /// Switch to a LAN Workplace paired earlier (developer toggle).
    func useSavedLAN() {
        guard let url = savedLANURL else { return }
        stopConnections()
        config = ServerConfig(mode: .lan, baseURL: url)
        config.save(defaults: defaults)
        syncCredential()
        health = nil
        rest = nil
        if hasCredential { connect() } else { connection = .signedOut }
    }

    // MARK: connection

    func chatOpened(_ threadId: String) { openChats[threadId, default: 0] += 1 }

    /// A chat (Talk or room thread) came on screen: its notifications on the lock screen go.
    func chatVisible(_ threadId: String) {
        visibleChats[threadId, default: 0] += 1
        clearChatNotifications?(threadId)
    }
    func chatHidden(_ threadId: String) {
        guard let n = visibleChats[threadId] else { return }
        if n <= 1 { visibleChats[threadId] = nil } else { visibleChats[threadId] = n - 1 }
    }
    func chatClosed(_ threadId: String) {
        guard let n = openChats[threadId] else { return }
        if n <= 1 { openChats[threadId] = nil } else { openChats[threadId] = n - 1 }
    }

    /// Re-fetch what the socket may have missed: the thread list (unread, typing) and every open chat.
    func resyncOpenChats() async {
        guard let rest, talkThreads.supported != false else { return }
        await talkThreads.load(rest)
        for id in openChats.keys { await talkThreads.loadMessages(rest, threadId: id) }
    }

    func foreground() {
        // A token that could not be read at launch (phone locked) is readable now: connect with it.
        let wasUnreadable = credentialUnreadable
        if wasUnreadable || !hasCredential { syncCredential() }
        guard hasCredential, !credentialUnreadable else { return }
        if wasUnreadable { connect(); Task { await registerPush() }; return }
        Task { await resyncOpenChats() }
        refreshDashboard()
        switch connection {
        case .macOffline, .accessOff, .unauthorized: connect()
        default: if socket == nil { connect() } else { socket?.reconnectNow() }
        }
        Task { await registerPush() }
    }

    func background() {
        // Nothing to tear down: iOS suspends the socket; on resume we reconnect.
    }

    private func stopConnections() {
        connectTask?.cancel(); connectTask = nil
        offlineTask?.cancel(); offlineTask = nil
        socket?.stop(); socket = nil
    }

    private func connect() {
        let token: String
        switch tokens.read() {
        case .present(let t): token = t
        case .absent: connection = .signedOut; return
        case .unavailable: credentialUnreadable = true; connection = .offline(reason: Self.waitingForUnlock, retryAt: nil); return
        }
        stopConnections()
        connection = .connecting
        let rest = RestClient(config: config, tokens: tokens, session: urlSession)
        // A 401 from any call (a screen's load, an answer) is checked against the relay at once, so a
        // session that ended mid-run shows the "Sign in again" strip instead of only a row's error.
        rest.onUnauthorized = { [weak self, weak rest] in
            Task { @MainActor in if let self, let rest { self.confirmSession(rest) } }
        }
        self.rest = rest
        // Stale-while-revalidate: the last good lists show now, before the health probe and the
        // loads below make their round trips through the relay; `loadAll()` replaces them.
        hydrateFromCache()
        let socket = SocketClient(socketURL: config.socketURL, token: token, makeTransport: makeTransport)
        socket.onEvent = { [weak self] e in self?.handle(e) }
        socket.onState = { [weak self] s in self?.socketState(s) }
        self.socket = socket
        connectTask = Task { [weak self] in
            guard let self else { return }
            switch await self.probe(rest) {
            case .online, .offline:
                // Offline here means the network, not the Mac: the socket's backoff will recover it.
                socket.start()
                await self.loadAll()
            case .macOffline, .accessOff:
                self.waitForMac(rest, socket: socket)
            case .unauthorized, .signedOut, .connecting:
                break
            }
        }
    }

    private var confirmingSession = false

    /// A call was refused with a 401: one health probe decides (a 4401 socket close takes the same
    /// probe in `socketState`). Only
    /// the relay answering 401 there is a confirmed-invalid session; an outage or an asleep server
    /// is offline / Mac offline and keeps everything on screen.
    private func confirmSession(_ rest: RestClient) {
        guard rest === self.rest, !confirmingSession else { return }
        switch connection {
        case .unauthorized, .signedOut, .connecting: return   // already decided, or a connect's own probe is in flight
        default: break
        }
        confirmingSession = true
        Task { [weak self] in
            guard let self else { return }
            defer { self.confirmingSession = false }
            let socket = self.socket
            let result = await self.probe(rest)
            guard rest === self.rest else { return }
            switch result {
            case .unauthorized: socket?.stop()
            case .macOffline, .accessOff: if let socket { socket.stop(); self.waitForMac(rest, socket: socket) }
            case .online: if let socket, socket.state != .open { self.connection = .offline(reason: "Connection lost", retryAt: nil) }
            default: break
            }
        }
    }

    /// One health call, translated into the connection state it implies.
    private func probe(_ rest: RestClient) async -> Connection {
        do {
            let h = try await rest.health()
            health = h
            connection = .online(version: h.version)
        } catch WorkplaceError.unauthorized {
            connection = .unauthorized
        } catch WorkplaceError.macOffline {
            connection = .macOffline
        } catch WorkplaceError.accessOff {
            connection = .accessOff
        } catch where error.isCancellation {
            // A newer connect replaced this one: it owns the state now.
        } catch {
            connection = .offline(reason: error.localizedDescription, retryAt: nil)
        }
        return connection
    }

    /// The Mac is down behind the relay: re-probe until it is back, then connect the socket.
    private func waitForMac(_ rest: RestClient, socket: SocketClient) {
        offlineTask?.cancel()
        offlineTask = Task { [weak self, offlineProbeInterval] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(offlineProbeInterval))
                guard !Task.isCancelled, let self else { return }
                // Through the relay, ask its own cheap probe first; only when the Mac is back do we hit /api.
                if self.config.mode == .relay, case .macOffline = self.connection,
                   let h = try? await rest.relayHealth(), !h.isMacOnline { continue }
                if case .online = await self.probe(rest) {
                    socket.start()
                    await self.loadAll()
                    return
                }
                if case .unauthorized = self.connection { return }
            }
        }
    }

    /// Fill the list stores from this Workplace's cached copy (only stores that are still empty).
    func hydrateFromCache() {
        guard let cache else { return }
        cache.setScope(config)
        office.hydrate()
        inbox.hydrate()
        plan.hydrate()
        rooms.hydrate()
        dashboard.hydrate()
    }

    /// Launch and foreground: fetch the snapshot behind the cached one (throttled; never blocks).
    func refreshDashboard() {
        guard let rest else { return }
        Task { await dashboard.refresh(rest) }
    }

    /// The BGAppRefreshTask run. iOS may launch the app in the background just for this, before any
    /// scene appeared, so it reads the saved mode and credential itself instead of needing `start()`.
    /// Returns false when the fetch failed (the cached copy stays either way).
    func backgroundRefreshDashboard() async -> Bool {
        if rest == nil {
            config = ServerConfig.load(defaults: defaults, env: env)
            syncCredential()
        }
        guard hasCredential else { return true }
        let client = rest ?? RestClient(config: config, tokens: tokens, session: urlSession)
        cache?.setScope(config)
        dashboard.hydrate()
        return await dashboard.load(client)
    }

    // MARK: chat notification actions (CHAT-NOTIFY-CONTRACT §6.3)

    /// A client for work that may run before any screen (a notification action launched the app in
    /// the background): the live one, else one built from the saved mode and credential.
    private func clientForBackgroundWork() -> RestClient? {
        if let rest { return rest }
        config = ServerConfig.load(defaults: defaults, env: env)
        syncCredential()
        guard hasCredential, !credentialUnreadable else { return nil }
        return RestClient(config: config, tokens: tokens, session: urlSession)
    }

    /// Reply from the notification: the COO bridge, the Talk thread, or the room thread.
    func replyFromNotification(threadId: String, isRoom: Bool, text: String) async throws {
        guard let rest = clientForBackgroundWork() else { throw WorkplaceError.notPaired }
        if isRoom {
            _ = try await rest.postMessage(threadId, text: text, mentions: RoomStore.mentions(in: text, known: mentionable))
        } else if threadId == "coo" {
            _ = try await rest.cooMessage(text)
        } else {
            _ = try await rest.sendTalk(threadId, SendTalkMessageRequest(text: text, replyTo: nil, mentions: nil, attachmentIds: nil))
        }
    }

    /// A chat notification's action: send the reply (a failure is reported in the same stack) or mute.
    func perform(_ action: ChatAction) async {
        switch action {
        case .reply(let threadId, let isRoom, let text):
            do { try await replyFromNotification(threadId: threadId, isRoom: isRoom, text: text) }
            catch { LocalNotifier.replyFailed(threadId: threadId, isRoom: isRoom, reason: error.userMessage ?? "Try again from the app.") }
        case .mute(let threadId, _):
            await muteFromNotification(threadId: threadId)
        }
    }

    /// Mute for 1 hour from the notification.
    func muteFromNotification(threadId: String) async {
        try? await chatPrefs.set(clientForBackgroundWork(), threadId: threadId, option: .hour)
    }

    func loadAll() async {
        guard let rest else { return }
        // `health` is already fresh here: both callers run this right after `probe(_:)`, which
        // just fetched and assigned it. Fetching it again here doubled every /api/health call.
        async let o: Void = office.load(rest)
        async let i: Void = inbox.load(rest)
        async let p: Void = plan.load(rest)
        async let c: Void = chatPrefs.load(rest)
        refreshDashboard()
        _ = await (o, i, p, c)
        syncNeedsYou()
        if inbox.loaded { housekeeping?(Set(inbox.open.map(\.id))) }
    }

    /// The owner answered an item from this phone: the item's notification goes, the badge follows.
    func answered(_ id: String) {
        clearNotification?(id)
        if inbox.loaded { housekeeping?(Set(inbox.open.map(\.id))) }
    }

    /// Answer with the device-owner gate the push LLD requires for dangerous and approval-type answers.
    func answer(item: InboxItem, option: InboxOption, note: String?) async throws {
        guard let rest else { throw WorkplaceError.notPaired }
        if AnswerGate.needsDeviceOwner(item: item, option: option) {
            let ok = await deviceAuth.verify(reason: "Confirm: \(option.label)")
            guard ok else { throw WorkplaceError.transport("Not confirmed on this phone.") }
        }
        try await inbox.answer(rest, id: item.id, optionId: option.id, note: note)
        answered(item.id)
    }

    private func socketState(_ s: SocketState) {
        switch s {
        case .open:
            offlineTask?.cancel(); offlineTask = nil
            connection = .online(version: health?.version ?? "")
            socketIsOpen = true
            // A RE-open (not the first): whatever was posted while it was down was never pushed.
            if everOpened { Task { await resyncOpenChats() } }
            everOpened = true
        case .closed(let retryAt):
            socketIsOpen = false
            switch connection {
            case .unauthorized, .macOffline, .accessOff, .signedOut: return
            default: break
            }
            guard let retryAt, let rest, let socket else { return }
            // The relay says why it closed: 1013 = the Mac is offline (or the server is asleep).
            if socket.lastCloseCode == SocketClosed.macOffline { socket.stop(); connection = .macOffline; waitForMac(rest, socket: socket); return }
            // 4401 is not proof the session is gone: the relay also sends it while access is switched
            // off. The probe below asks over HTTP, where 401 (session) and 503 (off, Mac offline) differ.
            connection = socket.lastCloseCode == SocketClosed.unauthorized ? .connecting : .offline(reason: "Connection lost", retryAt: retryAt)
            // Was it the network, the Mac, or the session? One health call tells.
            Task { [weak self] in
                guard let self else { return }
                let result = await self.probe(rest)
                // The probe can outlast the socket's own reconnect: never overwrite a live socket's state.
                guard self.socket === socket, socket.state != .open else { return }
                switch result {
                case .macOffline, .accessOff:
                    socket.stop()
                    self.waitForMac(rest, socket: socket)
                case .unauthorized:
                    socket.stop()
                default:
                    self.connection = .offline(reason: "Connection lost", retryAt: retryAt)
                }
            }
        case .connecting, .idle:
            break
        }
    }

    /// Every socket event reaches every store; each keeps what concerns it.
    func handle(_ event: ServerEvent) {
        office.handle(event)
        inbox.handle(event)
        talk.handle(event)
        features.handle(event)
        room.handle(event)
        coo.handle(event)
        requests.handle(event)
        alerts.handle(event)
        plan.handle(event)
        items.handle(event)
        updates.handle(event)
        rooms.handle(event)
        releasePosts.handle(event)
        talkThreads.handle(event)
        chatPrefs.handle(event)
        switch event {
        case .hello(let version, _):
            connection = .online(version: version)
        case .inboxUpdated(let item):
            syncNeedsYou()
            if item.state != .open { clearNotification?(item.id) }
            if inbox.loaded { housekeeping?(Set(inbox.open.map(\.id))) }
        case .error(let message):
            lastSocketError = message
        case .releaseUpdated(let r):
            releases[r.id] = r
            if r.state == .done || r.state == .failed {
                alerts.handle(.alert(AlertEvent(level: .info, title: "Release \(r.version) \(r.state.rawValue)", body: "\(r.shippable.rawValue) \(r.version)", inboxId: nil)))
            }
        case .releaseLog(let id, let line):
            releaseLog[id, default: []].append(line)
        default:
            break
        }
    }

    /// The Chief of Staff: the default Talk target.
    var chiefOfStaff: String? { office.data?.chiefOfStaff }

    private func syncNeedsYou() {
        if inbox.loaded { office.setNeedsYou(inbox.open.count) }
    }

    // MARK: actions used by more than one screen

    func send(_ command: ClientCommand) async throws {
        guard let socket else { throw WorkplaceError.notPaired }
        try await socket.send(command)
    }

    /// The employee's name for an id, from whatever is loaded.
    func employeeName(_ id: String?) -> String {
        guard let id, !id.isEmpty else { return "—" }
        if id == "owner" { return "You" }
        if let name = office.card(id)?.employee.name { return name }
        if let name = talkThreads.mentionable?.first(where: { $0.id == id })?.name { return name }
        switch id {
        case "workplace": return "Workplace"
        case "coo": return "Claude — COO"
        default: return id
        }
    }

    /// Who can be assigned or asked to review: the owner first, then everyone in the Office.
    var assignees: [(id: String, name: String)] {
        [("owner", "Me")] + office.cards.filter { $0.employee.virtual != true }.map { ($0.employee.id, $0.employee.name) }.sorted { $0.1 < $1.1 }
    }

    /// The charter title for an id, from whatever is loaded.
    func charterTitle(_ id: String?) -> String {
        guard let id else { return "—" }
        return office.cards.flatMap(\.charters).first { $0.id == id }?.title ?? id
    }
}
