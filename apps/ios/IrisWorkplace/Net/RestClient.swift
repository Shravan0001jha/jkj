import Foundation

enum WorkplaceError: Error, Equatable, LocalizedError {
    /// The server answered with `{ error }` and a 4xx/5xx status.
    case server(status: Int, message: String)
    /// 401: the token is missing or no longer valid.
    case unauthorized
    /// The bytes did not match the contract.
    case decoding(String)
    /// Could not reach the server at all.
    case transport(String)
    /// The app has no credential for the Workplace yet.
    case notPaired
    /// The relay is up but the Mac's tunnel to it is down (503 "The Mac is offline.").
    case macOffline
    /// The owner switched published access off (503 "Published access is switched off.").
    case accessOff

    var errorDescription: String? {
        switch self {
        case .server(_, let message): return message
        case .unauthorized: return "Your session with the Workplace has ended. Sign in again."
        case .decoding(let d): return "The server's answer did not match the contract: \(d)"
        case .transport(let d): return d
        case .notPaired: return "Sign in to the Workplace first."
        case .macOffline: return "Your Mac is offline — Workplace unavailable."
        case .accessOff: return "Access is switched off — turn it back on from your Mac or Telegram."
        }
    }
}

/// REST over URLSession. Every call carries the bearer token; every path comes from `API`.
final class RestClient {
    let config: ServerConfig
    private let tokens: TokenStore
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(config: ServerConfig, tokens: TokenStore, session: URLSession = .shared) {
        self.config = config
        self.tokens = tokens
        self.session = session
    }

    /// `IrisWorkplace/<version> CFNetwork Darwin/<kernel>`: the relay records answers from it as `via: 'phone'`.
    static let userAgent: String = {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        var u = utsname(); uname(&u)
        let release = withUnsafePointer(to: &u.release) { $0.withMemoryRebound(to: CChar.self, capacity: 256) { String(cString: $0) } }
        let major = release.split(separator: ".").first.map(String.init) ?? "24"
        return "IrisWorkplace/\(v) CFNetwork Darwin/\(major)"
    }()

    // MARK: endpoints

    func health() async throws -> WorkplaceHealthResponse { try await get(API.health) }
    func office() async throws -> OfficeResponse { try await get(API.office) }
    func inbox() async throws -> [InboxItem] { try await get(API.inbox) }
    func answer(inbox id: String, optionId: String, note: String?) async throws -> InboxItem {
        try await post(API.inboxAnswer(id), AnswerInboxRequest(optionId: optionId, note: note))
    }
    func employees() async throws -> [Employee] { try await get(API.employees) }
    func employee(_ id: String) async throws -> EmployeeDetail { try await get(API.employee(id)) }
    func talk(_ id: String, text: String, attachments: [Attachment]? = nil) async throws -> Agent {
        try await post(API.employeeTalk(id), TalkRequest(text: text, attachments: attachments))
    }
    func endSession(_ id: String) async throws { let _: OkResponse = try await post(API.employeeEndSession(id), Empty()) }
    func charter(_ id: String) async throws -> Charter { try await get(API.charter(id)) }
    func agentLog(_ id: String) async throws -> [LogEntry] { try await get(API.agentLog(id)) }
    func interrupt(agent id: String) async throws { let _: OkResponse = try await post(API.agentInterrupt(id), Empty()) }
    func features() async throws -> FeatureBoard { try await get(API.features) }
    func feature(_ id: String) async throws -> FeatureDetail { try await get(API.feature(id)) }
    func pivot(_ rows: PivotRows) async throws -> Pivot { try await get(API.featurePivot(rows)) }
    func spend(day: String? = nil) async throws -> SpendSummary { try await get(API.spend(day: day)) }
    /// Talk to the Chief of Staff without choosing anyone.
    func talkAsha(text: String) async throws -> Agent { try await post(API.talk, TalkRequest(text: text, attachments: nil, probe: nil)) }
    func createRequest(text: String, platformIds: [String]?) async throws -> RequestResponse {
        try await post(API.requests, CreateRequest(text: text, platformIds: platformIds))
    }
    func requests() async throws -> [RequestResponse] { try await get(API.requests) }
    func proposal(_ id: String) async throws -> ProposalDetail { try await get(API.proposal(id)) }
    func releasesReady() async throws -> [ReleaseReadiness] { try await get(API.releasesReady) }
    func runRelease(_ id: String) async throws { let _: OkResponse = try await post(API.releaseRun(id), Empty()) }
    func createWork(_ req: CreateWorkRequest) async throws -> WorkItem { try await post(API.work(), req) }
    func startWork(_ id: String) async throws -> Agent { try await post(API.workStart(id), Empty()) }
    func room() async throws -> RoomResponse { try await get(API.room) }
    func roomThread(_ id: String) async throws -> RoomThreadDetail { try await get(API.roomThread(id)) }
    func postMessage(_ id: String, text: String, mentions: [String]) async throws -> RoomMessage {
        try await post(API.roomMessages(id), PostMessageRequest(text: text, mentions: mentions.isEmpty ? nil : mentions))
    }
    func createThread(title: String, text: String, mentions: [String], charterIds: [String]? = nil) async throws -> RoomThreadDetail {
        try await post(API.room, CreateThreadRequest(title: title, text: text, charterIds: charterIds, mentions: mentions.isEmpty ? nil : mentions))
    }
    func resolveThread(_ id: String, summary: String) async throws -> RoomThread {
        try await post(API.roomResolve(id), ResolveThreadRequest(summary: summary))
    }

    // The COO bridge: only the phone-safe subset (reply/items/answer/forward are the lead's own,
    // loopback-only actions on the Mac and have no client here).
    func cooLog() async throws -> [CooMessage] { try await get(API.cooLog) }
    func cooMessage(_ text: String) async throws -> CooMessage { try await post(API.cooMessage, CooMessageRequest(text: text)) }
    func cooPresence() async throws -> CooPresence { try await get(API.cooPresence) }

    // Relay-only routes (never proxied to the Mac).
    func relayHealth() async throws -> RelayHealth { try await get(API.relayHealth) }
    func registerPush(token: String, env: PushEnvironment, device: String?) async throws -> PushRegisterResponse {
        try await post(API.pushRegister, PushRegisterRequest(token: token, env: env, device: device))
    }
    func unregisterPush(token: String) async throws { let _: OkResponse = try await post(API.pushUnregister, PushUnregisterRequest(token: token)) }
    func pushDevices() async throws -> PushDevicesResponse { try await get(API.pushDevices) }

    /// Pairing has no token yet; the exchange is the one unauthenticated call.
    static func exchange(config: ServerConfig, code: String, session: URLSession = .shared) async throws -> String {
        let client = RestClient(config: config, tokens: MemoryTokenStore(), session: session)
        let r: PairExchangeResponse = try await client.post(API.pairExchange, PairExchangeRequest(code: code), authenticated: false)
        return r.token
    }

    // MARK: plumbing

    func get<T: Decodable>(_ path: String) async throws -> T {
        try await send(request(path, method: "GET"))
    }

    func post<T: Decodable, B: Encodable>(_ path: String, _ body: B, authenticated: Bool = true) async throws -> T {
        var req = request(path, method: "POST", authenticated: authenticated)
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try encoder.encode(body)
        return try await send(req)
    }

    private func request(_ path: String, method: String, authenticated: Bool = true) -> URLRequest {
        var req = URLRequest(url: config.url(path))
        req.httpMethod = method
        req.timeoutInterval = 20
        req.setValue("application/json", forHTTPHeaderField: "accept")
        req.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
        if authenticated, let token = tokens.token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return req
    }

    private func send<T: Decodable>(_ req: URLRequest) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw WorkplaceError.transport(Self.describeTransport(error, host: req.url?.host ?? "the server"))
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw WorkplaceError.unauthorized }
        if Self.isAccessOff(status: status, body: data) { throw WorkplaceError.accessOff }
        if Self.isMacOffline(status: status, body: data) { throw WorkplaceError.macOffline }
        if !(200..<300).contains(status) {
            let message = (try? decoder.decode(ErrorResponse.self, from: data))?.error
            throw WorkplaceError.server(status: status, message: message ?? "HTTP \(status)")
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw WorkplaceError.decoding(describe(error))
        }
    }
}

extension RestClient {
    /// "Published access is switched off." — the owner turned the relay off; not an outage.
    static func isAccessOff(status: Int, body: Data) -> Bool {
        guard status >= 400 else { return false }
        return String(decoding: body.prefix(4096), as: UTF8.self).lowercased().contains("switched off")
    }

    /// A network failure in the owner's words: DNS, no connection, timeout.
    static func describeTransport(_ error: Error, host: String) -> String {
        guard let e = error as? URLError else { return error.localizedDescription }
        switch e.code {
        case .cannotFindHost, .dnsLookupFailed: return "Can't reach \(host) — check your connection"
        case .notConnectedToInternet, .networkConnectionLost, .internationalRoamingOff, .dataNotAllowed: return "No internet connection"
        case .timedOut: return "\(host) did not answer in time"
        case .cannotConnectToHost: return "Can't connect to \(host)"
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate: return "Secure connection to \(host) failed"
        default: return e.localizedDescription
        }
    }

    /// The relay's "Mac offline" answer: a gateway status, or any error body that says so.
    static func isMacOffline(status: Int, body: Data) -> Bool {
        if [502, 503, 504].contains(status) { return true }
        guard status >= 400 else { return false }
        let text = String(decoding: body.prefix(4096), as: UTF8.self).lowercased()
        return text.contains("mac offline") || text.contains("mac is offline")
    }
}

struct Empty: Encodable {}

/// `GET /relay/health`: the relay's own cheap probe, no session needed.
struct RelayHealth: Codable, Equatable {
    var ok: Bool
    var mac: String?
    var isMacOnline: Bool { mac == "online" }
}

enum PushEnvironment: String, Codable { case sandbox, production }
struct PushRegisterRequest: Codable, Equatable { var token: String; var env: PushEnvironment; var device: String? }
struct PushRegisterResponse: Codable, Equatable { var ok: Bool; var devices: Int? }
struct PushUnregisterRequest: Codable, Equatable { var token: String }
struct PushDevice: Codable, Equatable, Hashable {
    var env: String
    var device: String?
    var created: String?
    var lastSeen: String?
    var thisDevice: Bool?
}
struct PushDevicesResponse: Codable, Equatable { var devices: [PushDevice] }
struct OkResponse: Decodable { var ok: Bool? }

func describe(_ error: Error) -> String {
    guard let e = error as? DecodingError else { return error.localizedDescription }
    switch e {
    case .keyNotFound(let k, let c): return "missing \(path(c) + k.stringValue)"
    case .typeMismatch(let t, let c): return "wrong type at \(path(c)) (expected \(t))"
    case .valueNotFound(let t, let c): return "null at \(path(c)) (expected \(t))"
    case .dataCorrupted(let c): return "bad value at \(path(c)): \(c.debugDescription)"
    @unknown default: return e.localizedDescription
    }
}

private func path(_ c: DecodingError.Context) -> String {
    let p = c.codingPath.map { $0.intValue.map { "[\($0)]" } ?? $0.stringValue }.joined(separator: ".")
    return p.isEmpty ? "" : p + "."
}
