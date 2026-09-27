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
    /// The relay is up but the Mac's tunnel to it is down (502/503/504, "Mac offline").
    case macOffline

    var errorDescription: String? {
        switch self {
        case .server(_, let message): return message
        case .unauthorized: return "Your session with the Workplace has ended. Sign in again."
        case .decoding(let d): return "The server's answer did not match the contract: \(d)"
        case .transport(let d): return d
        case .notPaired: return "Sign in to the Workplace first."
        case .macOffline: return "Your Mac is offline — Workplace unavailable."
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
            throw WorkplaceError.transport(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw WorkplaceError.unauthorized }
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
    /// The relay's "Mac offline" answer: a gateway status, or any error body that says so.
    static func isMacOffline(status: Int, body: Data) -> Bool {
        if [502, 503, 504].contains(status) { return true }
        guard status >= 400 else { return false }
        let text = String(decoding: body.prefix(4096), as: UTF8.self).lowercased()
        return text.contains("mac offline") || text.contains("mac is offline")
    }
}

struct Empty: Encodable {}
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
