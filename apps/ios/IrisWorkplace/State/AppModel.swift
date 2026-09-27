import Foundation
import Observation

enum Connection: Equatable {
    case unpaired
    case connecting
    case online(version: String)
    case offline(reason: String, retryAt: Date?)
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
    var showSettings = false

    func openInbox(_ id: String) { inboxItemId = id; tab = .inbox }
    func talk(to employeeId: String) { talkEmployeeId = employeeId; tab = .talk }
}

/// Owns the connection, the clients and the stores. One per app.
@MainActor @Observable
final class AppModel {
    private(set) var connection: Connection = .unpaired
    private(set) var config: ServerConfig?
    private(set) var rest: RestClient?
    private(set) var health: WorkplaceHealthResponse?
    private var socket: SocketClient?

    let office = OfficeStore()
    let inbox = InboxStore()
    let talk = TalkStore()
    let features = FeaturesStore()
    let alerts: AlertsStore
    let router = Router()

    private let tokens: TokenStore
    private let defaults: UserDefaults
    private let makeTransport: () -> SocketTransport
    private let urlSession: URLSession
    private let env: [String: String]
    private var connectTask: Task<Void, Never>?

    init(tokens: TokenStore = Keychain.shared,
         defaults: UserDefaults = .standard,
         notifier: Notifier? = nil,
         urlSession: URLSession = .shared,
         makeTransport: @escaping () -> SocketTransport = { URLSessionSocketTransport() },
         env: [String: String] = ProcessInfo.processInfo.environment) {
        self.tokens = tokens
        self.defaults = defaults
        self.alerts = AlertsStore(notifier: notifier)
        self.urlSession = urlSession
        self.makeTransport = makeTransport
        self.env = env
        #if DEBUG
        if let t = env["WORKPLACE_TOKEN"], !t.isEmpty { tokens.save(token: t) }
        #endif
    }

    var isPaired: Bool { config != nil && tokens.token != nil }

    // MARK: lifecycle

    /// Boot: load the config and token, connect if both exist.
    func start() {
        config = ServerConfig.load(defaults: defaults, env: env)
        guard isPaired else { connection = .unpaired; return }
        connect()
    }

    /// Pairing: exchange the one-time code, keep the token, connect.
    func pair(urlText: String, code: String) async throws {
        guard let url = ServerConfig.parse(urlText) else {
            throw WorkplaceError.transport("Enter the server address as host:port, for example 192.168.1.5:4317.")
        }
        let cfg = ServerConfig(baseURL: url)
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw WorkplaceError.transport("Enter the pairing code shown on the Mac.") }
        let token = try await RestClient.exchange(config: cfg, code: trimmed, session: urlSession)
        tokens.save(token: token)
        cfg.save(defaults: defaults)
        config = cfg
        connect()
    }

    /// Forget the token (and the URL) and go back to Pairing.
    func unpair() {
        connectTask?.cancel()
        socket?.stop(); socket = nil
        tokens.clear()
        ServerConfig.forget(defaults: defaults)
        config = nil
        rest = nil
        health = nil
        connection = .unpaired
    }

    func foreground() {
        guard isPaired else { return }
        if socket == nil { connect() } else { socket?.reconnectNow() }
    }

    func background() {
        // Nothing to tear down: iOS suspends the socket; on resume we reconnect.
    }

    private func connect() {
        guard let config, let token = tokens.token else { connection = .unpaired; return }
        connectTask?.cancel()
        socket?.stop()
        connection = .connecting
        let rest = RestClient(config: config, tokens: tokens, session: urlSession)
        self.rest = rest
        let socket = SocketClient(socketURL: config.socketURL, token: token, makeTransport: makeTransport)
        socket.onEvent = { [weak self] e in self?.handle(e) }
        socket.onState = { [weak self] s in self?.socketState(s) }
        self.socket = socket
        connectTask = Task { [weak self] in
            guard let self else { return }
            do {
                let h = try await rest.health()
                guard !Task.isCancelled else { return }
                self.health = h
                self.connection = .online(version: h.version)
            } catch WorkplaceError.unauthorized {
                self.connection = .unauthorized
                return
            } catch {
                self.connection = .offline(reason: error.localizedDescription, retryAt: nil)
            }
            socket.start()
            await self.loadAll()
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
            if let h = health { connection = .online(version: h.version) } else { connection = .online(version: "") }
        case .closed(let retryAt):
            if case .unauthorized = connection { return }
            if let retryAt { connection = .offline(reason: "Connection lost", retryAt: retryAt) }
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

    private(set) var lastSocketError: String?

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
