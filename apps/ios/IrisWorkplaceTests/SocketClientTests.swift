import XCTest
@testable import IrisWorkplace

@MainActor
final class SocketClientTests: XCTestCase {
    private var transports: [FakeSocketTransport] = []
    private var sleeps: [TimeInterval] = []
    /// Set to release the sleeping reconnect task.
    private var wake: CheckedContinuation<Void, Never>?

    private func makeClient(token: String? = "tok", pingEvery: TimeInterval = 0) -> SocketClient {
        let c = SocketClient(socketURL: URL(string: "ws://192.168.1.5:4317/ws")!, token: token,
                             makeTransport: { [unowned self] in
                                 let t = FakeSocketTransport()
                                 self.transports.append(t)
                                 return t
                             },
                             pingEvery: pingEvery,
                             sleep: { [unowned self] s in
                                 if s == pingEvery { try? await Task.sleep(for: .seconds(s)); return }
                                 self.sleeps.append(s)
                                 await withCheckedContinuation { self.wake = $0 }
                             })
        return c
    }

    func testPingFailureClosesAndReconnects() async {
        let c = makeClient(pingEvery: 0.02)
        c.start()
        transports[0].open()
        await expectEventually { c.state == .open }
        await expectEventually { self.transports[0].pings >= 2 }
        transports[0].failPing = true
        await expectEventually { self.sleeps.count == 1 }
        XCTAssertTrue(transports[0].closed, "a failed ping closes the transport and schedules a retry")
        c.stop()
        wake?.resume(); wake = nil
    }

    func testTokenGoesInTheQuery() {
        let c = makeClient()
        XCTAssertEqual(c.connectedURL.absoluteString, "ws://192.168.1.5:4317/ws?token=tok")
        XCTAssertEqual(makeClient(token: nil).connectedURL.absoluteString, "ws://192.168.1.5:4317/ws")
    }

    func testOpenDeliversDecodedEvents() async throws {
        let c = makeClient()
        var events: [ServerEvent] = []
        var states: [SocketState] = []
        c.onEvent = { events.append($0) }
        c.onState = { states.append($0) }
        c.start()
        XCTAssertEqual(transports.count, 1)
        XCTAssertEqual(transports[0].url?.query, "token=tok")
        transports[0].open()
        await expectEventually { c.state == .open }
        transports[0].push(#"{"type":"hello","version":"1.0","startedAt":"2026-09-27T09:00:00.000Z"}"#)
        transports[0].push(#"{"type":"alert","level":"cap","title":"Cap","body":"₹1000 reached"}"#)
        transports[0].push(#"{"type":"something.new","x":1}"#)
        transports[0].push("not json")
        await expectEventually { events.count == 4 }
        XCTAssertEqual(events[0], .hello(version: "1.0", startedAt: "2026-09-27T09:00:00.000Z"))
        XCTAssertEqual(events[1], .alert(AlertEvent(level: .cap, title: "Cap", body: "₹1000 reached", inboxId: nil)))
        XCTAssertEqual(events[2], .unknown(type: "something.new"))
        guard case .error = events[3] else { return XCTFail("malformed frames become an error event, not a crash") }
        XCTAssertEqual(states.first, .connecting)
        c.stop()
    }

    func testSendEncodesTheCommand() async throws {
        let c = makeClient()
        c.start()
        transports[0].open()
        await expectEventually { c.state == .open }
        try await c.send(.agentApprove(agentId: "s-1", approvalId: "ap-1", decision: .once))
        let sent = try JSONSerialization.jsonObject(with: Data(transports[0].sent[0].utf8)) as! [String: Any]
        XCTAssertEqual(sent as NSDictionary, ["type": "agent.approve", "agentId": "s-1", "approvalId": "ap-1", "decision": "once"] as NSDictionary)
        c.stop()
    }

    func testSendWhileClosedThrows() async {
        let c = makeClient()
        do {
            try await c.send(.agentInterrupt(agentId: "s-1"))
            XCTFail("expected an error")
        } catch let e as WorkplaceError {
            XCTAssertEqual(e, .transport("Not connected"))
        } catch { XCTFail("\(error)") }
    }

    func testBackoffDoublesAndCaps() {
        XCTAssertEqual(SocketClient.backoff(attempt: 0), 1)
        XCTAssertEqual(SocketClient.backoff(attempt: 1), 2)
        XCTAssertEqual(SocketClient.backoff(attempt: 3), 8)
        XCTAssertEqual(SocketClient.backoff(attempt: 5), 30)
        XCTAssertEqual(SocketClient.backoff(attempt: 20), 30)
    }

    func testReconnectsAfterADropWithGrowingDelay() async throws {
        let c = makeClient()
        c.start()
        transports[0].open()
        await expectEventually { c.state == .open }

        transports[0].drop(WorkplaceError.transport("reset"))
        await expectEventually { self.sleeps.count == 1 }
        guard case .closed(let retryAt) = c.state, let retryAt else { return XCTFail("closed with a retry time, got \(c.state)") }
        XCTAssertTrue(retryAt > Date())
        XCTAssertEqual(sleeps[0], 1, accuracy: 0.25, "first retry ≈ 1 s with jitter")
        XCTAssertTrue(transports[0].closed)

        wake?.resume(); wake = nil
        await expectEventually { self.transports.count == 2 }
        XCTAssertEqual(c.state, .connecting)
        transports[1].drop(nil)
        await expectEventually { self.sleeps.count == 2 }
        XCTAssertEqual(sleeps[1], 2, accuracy: 0.5, "second retry ≈ 2 s")

        wake?.resume(); wake = nil
        await expectEventually { self.transports.count == 3 }
        transports[2].open()
        await expectEventually { c.state == .open }

        // A successful open resets the backoff.
        transports[2].drop(nil)
        await expectEventually { self.sleeps.count == 3 }
        XCTAssertEqual(sleeps[2], 1, accuracy: 0.25)
        c.stop()
        wake?.resume(); wake = nil
    }

    func testStopDoesNotRetry() async {
        let c = makeClient()
        c.start()
        transports[0].open()
        await expectEventually { c.state == .open }
        c.stop()
        XCTAssertEqual(c.state, .closed(retryAt: nil))
        XCTAssertTrue(transports[0].closed)
        transports[0].drop(nil)
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(transports.count, 1, "no reconnect after stop")
        XCTAssertEqual(sleeps.count, 0)
    }

    func testReconnectNowSkipsTheBackoff() async {
        let c = makeClient()
        c.start()
        transports[0].open()
        await expectEventually { c.state == .open }
        transports[0].drop(nil)
        await expectEventually { self.sleeps.count == 1 }
        c.reconnectNow()
        await expectEventually { self.transports.count == 2 }
        XCTAssertEqual(c.state, .connecting)
        c.stop()
        wake?.resume(); wake = nil
    }

    func testFramesFromAStaleTransportAreIgnored() async {
        let c = makeClient()
        var events: [ServerEvent] = []
        c.onEvent = { events.append($0) }
        c.start()
        transports[0].open()
        await expectEventually { c.state == .open }
        transports[0].drop(nil)
        await expectEventually { self.sleeps.count == 1 }
        transports[0].push(#"{"type":"error","message":"late"}"#)
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(events.isEmpty)
        c.stop()
        wake?.resume(); wake = nil
    }
}
