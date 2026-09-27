import Foundation

/// The bytes of one socket connection. `URLSessionWebSocketTask` in the app, a scripted fake in tests.
protocol SocketTransport: AnyObject {
    func connect(url: URL, onOpen: @escaping () -> Void, onText: @escaping (String) -> Void, onClose: @escaping (Error?) -> Void)
    func send(text: String) async throws
    func ping() async throws
    func close()
}

enum SocketState: Equatable {
    case idle
    case connecting
    case open
    /// Closed; will retry at `retryAt` (nil when the client was stopped on purpose).
    case closed(retryAt: Date?)
}

/// The socket: `/ws?token=…`, reconnect with jittered exponential backoff (1 s → 30 s), a ping
/// every 20 s, decoded `ServerEvent`s delivered on the main actor.
@MainActor
final class SocketClient {
    private(set) var state: SocketState = .idle { didSet { onState?(state) } }
    /// The server's close code from the last drop, when it sent one.
    private(set) var lastCloseCode: Int?
    var onEvent: ((ServerEvent) -> Void)?
    var onState: ((SocketState) -> Void)?

    private let url: URL
    private let makeTransport: () -> SocketTransport
    private var transport: SocketTransport?
    private var attempt = 0
    private var wantOpen = false
    private var retryTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private let sleep: (TimeInterval) async -> Void

    static let minBackoff: TimeInterval = 1
    static let maxBackoff: TimeInterval = 30
    static let defaultPingEvery: TimeInterval = 20
    /// Seconds between pings; 0 disables the ping loop (tests).
    let pingEvery: TimeInterval

    init(socketURL: URL, token: String?,
         makeTransport: @escaping () -> SocketTransport = { URLSessionSocketTransport() },
         pingEvery: TimeInterval = SocketClient.defaultPingEvery,
         sleep: @escaping (TimeInterval) async -> Void = { try? await Task.sleep(for: .seconds($0)) }) {
        var comps = URLComponents(url: socketURL, resolvingAgainstBaseURL: false)!
        if let token { comps.queryItems = [URLQueryItem(name: "token", value: token)] }
        self.url = comps.url!
        self.makeTransport = makeTransport
        self.pingEvery = pingEvery
        self.sleep = sleep
    }

    var connectedURL: URL { url }

    func start() {
        wantOpen = true
        attempt = 0
        open()
    }

    func stop() {
        wantOpen = false
        retryTask?.cancel(); retryTask = nil
        pingTask?.cancel(); pingTask = nil
        transport?.close(); transport = nil
        state = .closed(retryAt: nil)
    }

    /// Called on foreground: retry now instead of waiting out the backoff.
    func reconnectNow() {
        guard wantOpen else { return }
        if case .open = state { return }
        retryTask?.cancel(); retryTask = nil
        attempt = 0
        open()
    }

    func send(_ command: ClientCommand) async throws {
        guard case .open = state, let transport else { throw WorkplaceError.transport("Not connected") }
        let data = try encoder.encode(command)
        try await transport.send(text: String(decoding: data, as: UTF8.self))
    }

    /// Backoff for the n-th consecutive failure (0-based), before jitter.
    static func backoff(attempt: Int) -> TimeInterval {
        min(maxBackoff, minBackoff * pow(2, Double(attempt)))
    }

    private func open() {
        guard wantOpen else { return }
        state = .connecting
        let t = makeTransport()
        transport = t
        t.connect(url: url, onOpen: { [weak self] in
            Task { @MainActor in self?.opened(t) }
        }, onText: { [weak self] text in
            Task { @MainActor in self?.received(text, from: t) }
        }, onClose: { [weak self] error in
            Task { @MainActor in self?.closed(t, error: error) }
        })
    }

    private func opened(_ t: SocketTransport) {
        guard t === transport else { return }
        attempt = 0
        state = .open
        pingTask?.cancel()
        guard pingEvery > 0 else { return }
        let every = pingEvery
        pingTask = Task { [weak self, sleep] in
            while !Task.isCancelled {
                await sleep(every)
                guard !Task.isCancelled, let self, self.transport === t else { return }
                do { try await t.ping() } catch { self.closed(t, error: error) }
            }
        }
    }

    private func received(_ text: String, from t: SocketTransport) {
        guard t === transport else { return }
        do {
            let event = try decoder.decode(ServerEvent.self, from: Data(text.utf8))
            onEvent?(event)
        } catch {
            onEvent?(.error(message: "Bad socket event: \(describe(error))"))
        }
    }

    private func closed(_ t: SocketTransport, error: Error?) {
        guard t === transport else { return }
        lastCloseCode = (error as? SocketClosed)?.code
        pingTask?.cancel(); pingTask = nil
        transport?.close(); transport = nil
        guard wantOpen else { state = .closed(retryAt: nil); return }
        let base = Self.backoff(attempt: attempt)
        let delay = base * Double.random(in: 0.8...1.2)
        attempt += 1
        state = .closed(retryAt: Date().addingTimeInterval(delay))
        retryTask = Task { [weak self, sleep] in
            await sleep(delay)
            guard !Task.isCancelled else { return }
            self?.open()
        }
    }
}

/// The server closed the socket with a code: 4401 = no or invalid session (or access off),
/// 1013 = the Mac is offline (relay LLD).
struct SocketClosed: Error, Equatable {
    let code: Int
    let reason: String?
    static let unauthorized = 4401
    static let macOffline = 1013
}

/// The real transport.
final class URLSessionSocketTransport: NSObject, SocketTransport, URLSessionWebSocketDelegate {
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var onOpen: (() -> Void)?
    private var onText: ((String) -> Void)?
    private var onClose: ((Error?) -> Void)?
    private var finished = false

    func connect(url: URL, onOpen: @escaping () -> Void, onText: @escaping (String) -> Void, onClose: @escaping (Error?) -> Void) {
        self.onOpen = onOpen; self.onText = onText; self.onClose = onClose
        let cfg = URLSessionConfiguration.default
        cfg.waitsForConnectivity = false
        cfg.timeoutIntervalForRequest = 15
        cfg.httpAdditionalHeaders = ["User-Agent": RestClient.userAgent]
        let session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        self.session = session
        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
        receiveLoop()
    }

    func send(text: String) async throws {
        guard let task else { throw WorkplaceError.transport("Not connected") }
        try await task.send(.string(text))
    }

    func ping() async throws {
        guard let task else { throw WorkplaceError.transport("Not connected") }
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            task.sendPing { error in
                if let error { c.resume(throwing: error) } else { c.resume() }
            }
        }
    }

    func close() {
        finished = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self, !self.finished else { return }
            switch result {
            case .success(.string(let s)):
                self.onText?(s)
                self.receiveLoop()
            case .success(.data(let d)):
                self.onText?(String(decoding: d, as: UTF8.self))
                self.receiveLoop()
            case .success:
                self.receiveLoop()
            case .failure(let error):
                self.finish(error)
            }
        }
    }

    private func finish(_ error: Error?) {
        guard !finished else { return }
        finished = true
        onClose?(error)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        onOpen?()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        finish(SocketClosed(code: closeCode.rawValue, reason: reason.map { String(decoding: $0, as: UTF8.self) }))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finish(error)
    }
}
