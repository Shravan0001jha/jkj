import Foundation
import XCTest
@testable import IrisWorkplace

enum Fixtures {
    static func data(_ name: String) throws -> Data {
        let bundle = Bundle(for: Marker.self)
        guard let url = bundle.url(forResource: name, withExtension: "json", subdirectory: "fixtures")
                ?? bundle.url(forResource: name, withExtension: "json") else {
            throw NSError(domain: "fixtures", code: 1, userInfo: [NSLocalizedDescriptionKey: "missing fixture \(name).json"])
        }
        return try Data(contentsOf: url)
    }

    static func decode<T: Decodable>(_ name: String, as type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(T.self, from: try data(name))
    }

    static func json(_ name: String) throws -> Any {
        try JSONSerialization.jsonObject(with: try data(name))
    }

    private final class Marker {}
}

/// Answers every request from a script; records what it saw.
final class StubURLProtocol: URLProtocol {
    struct Recorded { let request: URLRequest; let body: Data? }
    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, Data))?
    nonisolated(unsafe) static var recorded: [Recorded] = []

    static func session() -> URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: cfg)
    }

    static func reset() { handler = nil; recorded = [] }
    /// A handler status that makes the stub fail the load with `URLError(.cancelled)`.
    static let cancelledStatus = -999

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = request.httpBody ?? request.httpBodyStream.map { stream -> Data in
            stream.open()
            defer { stream.close() }
            var out = Data()
            var buf = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buf, maxLength: buf.count)
                if n <= 0 { break }
                out.append(buf, count: n)
            }
            return out
        }
        Self.recorded.append(Recorded(request: request, body: body))
        let (status, data) = Self.handler?(request) ?? (404, Data("{\"error\":\"no handler\"}".utf8))
        // `cancelledStatus`: the load is cancelled, as when the view that started it goes away.
        if status == Self.cancelledStatus {
            client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// A socket whose frames the test scripts.
final class FakeSocketTransport: SocketTransport {
    private(set) var url: URL?
    private(set) var sent: [String] = []
    private(set) var pings = 0
    private(set) var closed = false
    private var onOpen: (() -> Void)?
    private var onText: ((String) -> Void)?
    private var onClose: ((Error?) -> Void)?
    var failPing = false

    func connect(url: URL, onOpen: @escaping () -> Void, onText: @escaping (String) -> Void, onClose: @escaping (Error?) -> Void) {
        self.url = url
        self.onOpen = onOpen; self.onText = onText; self.onClose = onClose
    }

    func send(text: String) async throws { sent.append(text) }
    func ping() async throws {
        pings += 1
        if failPing { throw WorkplaceError.transport("ping failed") }
    }
    func close() { closed = true }

    // Script
    func open() { onOpen?() }
    func push(_ text: String) { onText?(text) }
    func drop(_ error: Error? = nil) { onClose?(error) }
}

final class FakeNotifier: Notifier {
    var delivered: [AlertEvent] = []
    func notify(_ alert: AlertEvent) { delivered.append(alert) }
}

/// Waits (on the main actor) until a condition holds or the deadline passes.
@MainActor
func eventually(_ timeout: TimeInterval = 2, _ condition: @escaping @MainActor () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
}

/// Asserts that the condition becomes true within the timeout.
@MainActor
func expectEventually(_ message: String = "", timeout: TimeInterval = 2, file: StaticString = #filePath, line: UInt = #line,
                      _ condition: @escaping @MainActor () -> Bool) async {
    let ok = await eventually(timeout, condition)
    XCTAssertTrue(ok, message.isEmpty ? "condition did not become true within \(timeout)s" : message, file: file, line: line)
}

func stripNulls(_ value: Any) -> Any {
    if let d = value as? [String: Any] {
        var out: [String: Any] = [:]
        for (k, v) in d where !(v is NSNull) { out[k] = stripNulls(v) }
        return out
    }
    if let a = value as? [Any] { return a.map(stripNulls) }
    return value
}

/// The first differing path between two JSON values, for a readable failure.
func diff(_ a: Any, _ b: Any, path: String = "$") -> String {
    if let da = a as? [String: Any], let db = b as? [String: Any] {
        for k in Set(da.keys).union(db.keys).sorted() {
            guard let va = da[k] else { return "\(path).\(k): only in the re-encoded value" }
            guard let vb = db[k] else { return "\(path).\(k): only in the fixture (missing from the Swift model)" }
            let d = diff(va, vb, path: "\(path).\(k)")
            if !d.isEmpty { return d }
        }
        return ""
    }
    if let aa = a as? [Any], let ab = b as? [Any] {
        if aa.count != ab.count { return "\(path): \(aa.count) vs \(ab.count) elements" }
        for (i, (x, y)) in zip(aa, ab).enumerated() {
            let d = diff(x, y, path: "\(path)[\(i)]")
            if !d.isEmpty { return d }
        }
        return ""
    }
    return (a as AnyObject).isEqual(b) ? "" : "\(path): \(a) vs \(b)"
}

extension OfficeResponse {
    func cards() -> [EmployeeCard] { units.flatMap(\.employees) }
}

func jsonObject<T: Encodable>(_ value: T) throws -> Any {
    try JSONSerialization.jsonObject(with: try JSONEncoder().encode(value))
}
