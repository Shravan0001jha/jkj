import Foundation
import Observation

enum Connection: Equatable {
    /// No credential for the current mode: relay → sign in; LAN → pair.
    case signedOut
    case connecting
    case online(version: String)
    /// Cannot reach the server (network, DNS, relay down). Retried with backoff.
    case offline(reason: String, retryAt: Date?)
    /// The relay answers, but the Mac's tunnel to it is down. Probed every few seconds.
    case macOffline
    /// The credential was refused: sign in again (relay) or re-pair (LAN).
    case unauthorized
}

enum Tab: String, CaseIterable {
    case office, inbox, talk, features, alerts
}

/// Cross-tab navigation: an alert opens its Inbox item, an Office card opens Talk.
@MainActor @Observable
final class Router {
    var tab: Tab = .office
    var inboxItemId: String?
    var talkEmployeeId: String?
    var featureId: String?
    var pivot: PivotRows?
    var showSettings = false

    func openInbox(_ id: String) { inboxItemId = id; tab = .inbox }
    func talk(to employeeId: String) { talkEmployeeId = employeeId; tab = .talk }
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

    let office = OfficeStore()
    let inbox = InboxStore()
    let talk = TalkStore()
    let features = FeaturesStore()
    let alerts: AlertsStore
    let router = Router()

    private let relayTokens: TokenStore
    private let lanTokens: TokenStore
    private let defaults: UserDefaults
    private let makeTransport: () -> SocketTransport
    private let urlSession: URLSession
    private let env: [String: String]
    private let webAuth: WebAuth
    private let offlineProbeInterval: TimeInterval
    private var connectTask: Task<Void, Never>?
    private var offlineTask: Task<Void, Never>?

    init(relayTokens: TokenStore = Keychain.relay,
         lanTokens: TokenStore = Keychain.lan,
         defaults: UserDefaults = .standard,
         notifier: Notifier? = nil,
         urlSession: URLSession = .shared,
         makeTransport: @escaping () -> SocketTransport = { URLSessionSocketTransport() },
         webAuth: WebAuth? = nil,
         env: [String: String] = ProcessInfo.processInfo.environment,
         offlineProbeInterval: TimeInterval = 15) {
        self.relayTokens = relayTokens
        self.lanTokens = lanTokens
        self.defaults = defaults
        self.alerts = AlertsStore(notifier: notifier)
        self.urlSession = urlSession
        self.makeTransport = makeTransport
        self.webAuth = webAuth ?? ASWebAuth()
        self.env = env
        self.offlineProbeInterval = offlineProbeInterval
    }

    /// The credential store for the current mode.
    private var tokens: TokenStore { config.mode == .relay ? relayTokens : lanTokens }
    /// Stored, not computed from the Keychain, so SwiftUI re-renders when it changes.
    private(set) var hasCredential = false
    private func syncCredential() { hasCredential = tokens.token != nil }
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
        connect()
        #if DEBUG
        // Scripted runs (screenshots) open a screen directly.
        if let t = env["WORKPLACE_TAB"], let tab = Tab(rawValue: t) { router.tab = tab }
        if let id = env["WORKPLACE_INBOX_ITEM"] { router.openInbox(id) }
        if let id = env["WORKPLACE_TALK"] { router.talk(to: id) }
        if let id = env["WORKPLACE_FEATURE"] { router.featureId = id; router.tab = .features }
        if let p = env["WORKPLACE_PIVOT"], let rows = PivotRows(rawValue: p) { router.pivot = rows; router.tab = .features }
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
    }

    /// A callback that reached the app outside the auth session (`.onOpenURL`).
    @discardableResult
    func handleOpenURL(_ url: URL) -> Bool {
        guard let token = AuthCallback.parse(url) else { return false }
        if config.mode != .relay { useRelay(connect: false) }
        relayTokens.save(token: token)
        syncCredential()
        connect()
        return true
    }

    /// Forget the relay session and go back to the sign-in screen.
    func signOut() {
        stopConnections()
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

    func foreground() {
        guard hasCredential else { return }
        switch connection {
        case .macOffline, .unauthorized: connect()
        default: if socket == nil { connect() } else { socket?.reconnectNow() }
        }
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
        guard let token = tokens.token else { connection = .signedOut; return }
        stopConnections()
        connection = .connecting
        let rest = RestClient(config: config, tokens: tokens, session: urlSession)
        self.rest = rest
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
            case .macOffline:
                self.waitForMac(rest, socket: socket)
            case .unauthorized, .signedOut, .connecting:
                break
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
                if case .online = await self.probe(rest) {
                    socket.start()
                    await self.loadAll()
                    return
                }
                if case .unauthorized = self.connection { return }
            }
        }
    }

    func loadAll() async {
        guard let rest else { return }
        async let o: Void = office.load(rest)
        async let i: Void = inbox.load(rest)
        _ = await (o, i)
        syncNeedsYou()
    }

    private func socketState(_ s: SocketState) {
        switch s {
        case .open:
            offlineTask?.cancel(); offlineTask = nil
            connection = .online(version: health?.version ?? "")
        case .closed(let retryAt):
            switch connection {
            case .unauthorized, .macOffline, .signedOut: return
            default: break
            }
            guard let retryAt, let rest, let socket else { return }
            connection = .offline(reason: "Connection lost", retryAt: retryAt)
            // Was it the network, the Mac, or the session? One health call tells.
            Task { [weak self] in
                guard let self else { return }
                switch await self.probe(rest) {
                case .macOffline:
                    socket.stop()
                    self.waitForMac(rest, socket: socket)
                case .unauthorized:
                    socket.stop()
                case .online:
                    self.connection = .offline(reason: "Connection lost", retryAt: retryAt)
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
        alerts.handle(event)
        switch event {
        case .hello(let version, _):
            connection = .online(version: version)
        case .inboxUpdated:
            syncNeedsYou()
        case .error(let message):
            lastSocketError = message
        default:
            break
        }
    }

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
        guard let id else { return "—" }
        return office.card(id)?.employee.name ?? id
    }

    /// The charter title for an id, from whatever is loaded.
    func charterTitle(_ id: String?) -> String {
        guard let id else { return "—" }
        return office.cards.flatMap(\.charters).first { $0.id == id }?.title ?? id
    }
}
