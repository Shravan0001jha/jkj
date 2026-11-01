import XCTest
@testable import IrisWorkplace

/// Per-chat mute (CHAT-NOTIFY-CONTRACT §2, §6.5): the server's map, optimistic edits that roll
/// back, the socket event from another device, expiry, and a phone-only fallback while the
/// server has no route.
@MainActor
final class ChatPrefsTests: XCTestCase {
    private var rest: RestClient!
    private var defaults: UserDefaults!
    private var routes: [String: (Int, String)] = [:]
    private let t0 = Date(timeIntervalSince1970: 1_793_000_000)   // a fixed "now"

    override func setUp() {
        StubURLProtocol.reset()
        defaults = UserDefaults(suiteName: "ChatPrefsTests-\(UUID().uuidString)")!
        routes = [:]
        StubURLProtocol.handler = { [unowned self] req in
            let key = "\(req.httpMethod ?? "GET") \(req.url!.path)"
            return self.routes[key].map { ($0.0, Data($0.1.utf8)) } ?? (404, Data(#"{"error":"no route"}"#.utf8))
        }
        rest = RestClient(config: ServerConfig(mode: .lan, baseURL: ServerConfig.parse("127.0.0.1:4317")!),
                          tokens: MemoryTokenStore(token: "t"), session: StubURLProtocol.session())
    }

    private func store() -> ChatPrefsStore {
        let s = ChatPrefsStore(defaults: defaults)
        s.now = { [t0] in t0 }
        return s
    }

    private func iso(_ d: Date) -> String { ChatPrefsStore.iso(d) }

    func testLoadReadsTheServersMap() async {
        routes["GET /api/chats/prefs"] = (200, #"{"coo":{"muted":false,"mutedUntil":null},"dev":{"muted":true,"mutedUntil":null},"asha":{"muted":true,"mutedUntil":"\#(iso(t0.addingTimeInterval(3600)))"}}"#)
        let s = store()
        await s.load(rest)
        XCTAssertEqual(s.supported, true)
        XCTAssertFalse(s.isMuted("coo"))
        XCTAssertTrue(s.isMuted("dev"), "forever")
        XCTAssertTrue(s.isMuted("asha"), "until an hour from now")
        XCTAssertFalse(s.isMuted("mira"), "nothing stored: a 1:1 is unmuted")
        XCTAssertTrue(s.isMuted("th_1", isRoom: true), "nothing stored: a room is muted (contract default)")
        XCTAssertNil(s.error)
    }

    func testMutedUntilInThePastIsUnmuted() async {
        routes["GET /api/chats/prefs"] = (200, #"{"asha":{"muted":true,"mutedUntil":"\#(iso(t0.addingTimeInterval(-1)))"}}"#)
        let s = store()
        await s.load(rest)
        XCTAssertFalse(s.isMuted("asha"))
        s.now = { [t0] in t0.addingTimeInterval(-120) }
        XCTAssertTrue(s.isMuted("asha"), "it was muted two minutes ago")
    }

    func testAnExplicitPrefBeatsTheRoomDefault() async {
        routes["GET /api/chats/prefs"] = (200, #"{"th_1":{"muted":false,"mutedUntil":null}}"#)
        let s = store()
        await s.load(rest)
        XCTAssertFalse(s.isMuted("th_1", isRoom: true))
    }

    func testOptionsMakeTheRightPref() {
        XCTAssertEqual(MuteOption.hour.pref(now: t0), ChatPref(muted: true, mutedUntil: iso(t0.addingTimeInterval(3600))))
        XCTAssertEqual(MuteOption.eightHours.pref(now: t0), ChatPref(muted: true, mutedUntil: iso(t0.addingTimeInterval(8 * 3600))))
        XCTAssertEqual(MuteOption.day.pref(now: t0), ChatPref(muted: true, mutedUntil: iso(t0.addingTimeInterval(86_400))))
        XCTAssertEqual(MuteOption.forever.pref(now: t0), ChatPref(muted: true, mutedUntil: nil))
        XCTAssertEqual(MuteOption.unmute.pref(now: t0), ChatPref(muted: false, mutedUntil: nil))
        XCTAssertEqual(MuteOption.muting.map(\.title), ["1 hour", "8 hours", "1 day", "Forever"])
    }

    func testSetIsOptimisticThenTakesTheServersCopy() async throws {
        routes["GET /api/chats/prefs"] = (200, "{}")
        let until = iso(t0.addingTimeInterval(3600))
        routes["PUT /api/chats/asha/prefs"] = (200, #"{"muted":true,"mutedUntil":"\#(until)"}"#)
        let s = store()
        await s.load(rest)
        try await s.set(rest, threadId: "asha", option: .hour)
        XCTAssertTrue(s.isMuted("asha"))
        let put = StubURLProtocol.recorded.last { $0.request.httpMethod == "PUT" }
        XCTAssertEqual(put?.request.url?.path, "/api/chats/asha/prefs")
        let body = try JSONSerialization.jsonObject(with: put?.body ?? Data()) as? [String: Any]
        XCTAssertEqual(body?["muted"] as? Bool, true)
        XCTAssertEqual(body?["mutedUntil"] as? String, until)
        // Unmute sends an explicit null, as the contract's body says.
        routes["PUT /api/chats/asha/prefs"] = (200, #"{"muted":false,"mutedUntil":null}"#)
        try await s.set(rest, threadId: "asha", option: .unmute)
        let body2 = try JSONSerialization.jsonObject(with: StubURLProtocol.recorded.last!.body!) as? [String: Any]
        XCTAssertTrue(body2?["mutedUntil"] is NSNull)
        XCTAssertFalse(s.isMuted("asha"))
    }

    func testTheUIChangesBeforeTheServerAnswers() async throws {
        routes["GET /api/chats/prefs"] = (200, "{}")
        let s = store()
        await s.load(rest)
        let gate = DispatchSemaphore(value: 0)
        StubURLProtocol.handler = { req in
            if req.httpMethod == "PUT" { gate.wait(); return (200, #"{"muted":true,"mutedUntil":null}"#.data(using: .utf8)!) }
            return (404, Data())
        }
        let task = Task { try await s.set(rest, threadId: "dev", option: .forever) }
        await expectEventually("muted at once, before the PUT returns") { s.isMuted("dev") }
        gate.signal()
        try await task.value
        XCTAssertTrue(s.isMuted("dev"))
    }

    func testAFailureRollsBack() async {
        routes["GET /api/chats/prefs"] = (200, #"{"dev":{"muted":true,"mutedUntil":null}}"#)
        routes["PUT /api/chats/dev/prefs"] = (500, #"{"error":"Database is locked"}"#)
        routes["PUT /api/chats/asha/prefs"] = (500, #"{"error":"Database is locked"}"#)
        let s = store()
        await s.load(rest)
        do { try await s.set(rest, threadId: "dev", option: .unmute); XCTFail("should throw") } catch {}
        XCTAssertTrue(s.isMuted("dev"), "back to muted")
        XCTAssertEqual(s.error, "Database is locked")
        do { try await s.set(rest, threadId: "asha", option: .hour); XCTFail("should throw") } catch {}
        XCTAssertFalse(s.isMuted("asha"), "a new pref that failed is removed again")
        XCTAssertNil(s.pref("asha"))
        let reloaded = store()
        XCTAssertTrue(reloaded.isMuted("dev"))
        XCTAssertFalse(reloaded.isMuted("asha"), "nothing failed was persisted")
    }

    func testWithoutTheServerRouteItIsKeptOnThisPhone() async throws {
        let s = store()
        await s.load(rest)   // 404
        XCTAssertEqual(s.supported, false)
        XCTAssertTrue(s.localOnly)
        try await s.set(rest, threadId: "asha", option: .forever)   // PUT 404 too
        XCTAssertTrue(s.isMuted("asha"))
        XCTAssertNil(s.error, "a 404 is not an error to show")
        try await s.set(nil, threadId: "dev", option: .day)
        XCTAssertTrue(s.isMuted("dev"), "no client yet: still kept locally once the server is known not to have it")
        let reloaded = store()
        XCTAssertTrue(reloaded.isMuted("asha"), "persisted in UserDefaults")
        XCTAssertTrue(reloaded.isMuted("dev"))
    }

    func testAPutThatIs404FlipsToLocal() async throws {
        routes["GET /api/chats/prefs"] = (200, "{}")
        let s = store()
        await s.load(rest)
        XCTAssertEqual(s.supported, true)
        try await s.set(rest, threadId: "asha", option: .hour)
        XCTAssertEqual(s.supported, false)
        XCTAssertTrue(s.isMuted("asha"))
    }

    func testTheCacheIsKnownBeforeTheFirstLoad() async throws {
        routes["GET /api/chats/prefs"] = (200, #"{"coo":{"muted":true,"mutedUntil":null}}"#)
        await store().load(rest)
        let cold = store()
        XCTAssertNil(cold.supported)
        XCTAssertTrue(cold.isMuted("coo"), "a cold-launch push already knows the COO is muted")
    }

    func testTheSocketEventFromAnotherDevice() async {
        let s = store()
        s.handle(.chatPrefs(threadId: "asha", pref: ChatPref(muted: true, mutedUntil: nil)))
        XCTAssertTrue(s.isMuted("asha"))
        s.handle(.chatPrefs(threadId: "asha", pref: ChatPref(muted: false, mutedUntil: nil)))
        XCTAssertFalse(s.isMuted("asha"))
        XCTAssertFalse(store().isMuted("asha"), "persisted")
    }

    func testTheEventDecodes() throws {
        let e = try JSONDecoder().decode(ServerEvent.self, from: Data(#"{"type":"chat.prefs","threadId":"coo","muted":true,"mutedUntil":"2026-11-01T10:00:00.000Z"}"#.utf8))
        XCTAssertEqual(e, .chatPrefs(threadId: "coo", pref: ChatPref(muted: true, mutedUntil: "2026-11-01T10:00:00.000Z")))
        let e2 = try JSONDecoder().decode(ServerEvent.self, from: Data(#"{"type":"chat.prefs","threadId":"coo","muted":false}"#.utf8))
        XCTAssertEqual(e2, .chatPrefs(threadId: "coo", pref: ChatPref(muted: false, mutedUntil: nil)))
        XCTAssertTrue(ServerEvent.knownTypes.contains("chat.prefs"))
    }

    func testStatusText() async throws {
        let s = store()
        XCTAssertEqual(s.statusText("asha"), "On")
        s.handle(.chatPrefs(threadId: "asha", pref: ChatPref(muted: true, mutedUntil: nil)))
        XCTAssertEqual(s.statusText("asha"), "Muted")
        let until = t0.addingTimeInterval(3600)
        s.handle(.chatPrefs(threadId: "asha", pref: ChatPref(muted: true, mutedUntil: iso(until))))
        XCTAssertEqual(s.statusText("asha"), "Muted until \(until.formatted(date: .omitted, time: .shortened))")
        let later = t0.addingTimeInterval(2 * 86_400)
        s.handle(.chatPrefs(threadId: "asha", pref: ChatPref(muted: true, mutedUntil: iso(later))))
        XCTAssertTrue(s.statusText("asha").hasPrefix("Muted until "), s.statusText("asha"))
        XCTAssertEqual(s.statusText("th_1", isRoom: true), "Muted")
    }

    func testTheNextExpiryIsTheEarliestFutureOne() {
        let s = store()
        s.handle(.chatPrefs(threadId: "a", pref: ChatPref(muted: true, mutedUntil: iso(t0.addingTimeInterval(7200)))))
        s.handle(.chatPrefs(threadId: "b", pref: ChatPref(muted: true, mutedUntil: iso(t0.addingTimeInterval(600)))))
        s.handle(.chatPrefs(threadId: "c", pref: ChatPref(muted: true, mutedUntil: iso(t0.addingTimeInterval(-600)))))
        s.handle(.chatPrefs(threadId: "d", pref: ChatPref(muted: true, mutedUntil: nil)))
        XCTAssertEqual(s.nextExpiry.map { Int($0.timeIntervalSince(t0)) }, 600)
    }
}
