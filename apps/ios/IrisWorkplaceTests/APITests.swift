import XCTest
@testable import IrisWorkplace

/// `API` must produce exactly what `WORKPLACE_API` in workplace-api.ts produces.
final class APITests: XCTestCase {
    func testStaticPaths() {
        XCTAssertEqual(API.health, "/api/health")
        XCTAssertEqual(API.office, "/api/office")
        XCTAssertEqual(API.org, "/api/org")
        XCTAssertEqual(API.inbox, "/api/inbox")
        XCTAssertEqual(API.employees, "/api/employees")
        XCTAssertEqual(API.features, "/api/features")
        XCTAssertEqual(API.coverage, "/api/requirements/coverage")
        XCTAssertEqual(API.proposals, "/api/proposals")
        XCTAssertEqual(API.releases, "/api/releases")
        XCTAssertEqual(API.signals, "/api/health/signals")
        XCTAssertEqual(API.pair, "/api/pair")
        XCTAssertEqual(API.pairExchange, "/api/pair/exchange")
        XCTAssertEqual(API.socket, "/ws")
    }

    func testIdPathsEncodeLikeEncodeURIComponent() {
        XCTAssertEqual(API.charter("experts"), "/api/charters/experts")
        XCTAssertEqual(API.inboxAnswer("ib 1/x"), "/api/inbox/ib%201%2Fx/answer")
        XCTAssertEqual(API.employee("mira"), "/api/employees/mira")
        XCTAssertEqual(API.employeeTalk("mira"), "/api/employees/mira/talk")
        XCTAssertEqual(API.employeeEndSession("mira"), "/api/employees/mira/end-session")
        XCTAssertEqual(API.employeeContext("mira"), "/api/employees/mira/context")
        XCTAssertEqual(API.agentLog("s-1"), "/api/agents/s-1/log")
        XCTAssertEqual(API.agentMessage("s-1"), "/api/agents/s-1/message")
        XCTAssertEqual(API.agentInterrupt("s-1"), "/api/agents/s-1/interrupt")
        XCTAssertEqual(API.agentApprove("s-1"), "/api/agents/s-1/approve")
        XCTAssertEqual(API.agentMode("s-1"), "/api/agents/s-1/mode")
        XCTAssertEqual(API.agentImage("s-1", ref: "img/1.png"), "/api/agents/s-1/image?ref=img%2F1.png")
        XCTAssertEqual(API.workItem("w"), "/api/work/w")
        XCTAssertEqual(API.workTransition("w"), "/api/work/w/transition")
        XCTAssertEqual(API.feature("f-errands"), "/api/features/f-errands")
        XCTAssertEqual(API.featureDecompose("f"), "/api/features/f/decompose")
        XCTAssertEqual(API.proposalApply("p"), "/api/proposals/p/apply")
        XCTAssertEqual(API.releaseRun("r"), "/api/releases/r/run")
        XCTAssertEqual(API.enc("a~b!c'd(e)f*g"), "a~b!c'd(e)f*g", "encodeURIComponent keeps - _ . ! ~ * ' ( )")
        XCTAssertEqual(API.enc("a&b=c#d"), "a%26b%3Dc%23d")
    }

    func testQueryPathsMatchURLSearchParams() {
        XCTAssertEqual(API.work(), "/api/work")
        XCTAssertEqual(API.work(kind: .assignment, state: .review, employeeId: "mira"), "/api/work?kind=assignment&state=review&employeeId=mira")
        XCTAssertEqual(API.work(featureId: ""), "/api/work", "empty values are skipped")
        XCTAssertEqual(API.featurePivot(.charter), "/api/features/pivot?rows=charter")
        XCTAssertEqual(API.featurePivot(.team), "/api/features/pivot?rows=team")
        XCTAssertEqual(API.requirements(), "/api/requirements")
        XCTAssertEqual(API.requirements(group: "Cross-device"), "/api/requirements?group=Cross-device")
        XCTAssertEqual(API.requirements(group: "System actions"), "/api/requirements?group=System+actions")
        XCTAssertEqual(API.route(text: "phone mac", paths: ["a/", "b/"], platforms: ["ios"]), "/api/route?text=phone+mac&paths=a%2F%2Cb%2F&platforms=ios")
        XCTAssertEqual(API.spend(), "/api/spend")
        XCTAssertEqual(API.spend(day: "2026-09-27"), "/api/spend?day=2026-09-27")
    }
}

final class ServerConfigTests: XCTestCase {
    func testParseAcceptsHostPortAndFullURLs() {
        XCTAssertEqual(ServerConfig.parse("192.168.1.5:4317")?.absoluteString, "http://192.168.1.5:4317")
        XCTAssertEqual(ServerConfig.parse("http://mac.local:4317/")?.absoluteString, "http://mac.local:4317")
        XCTAssertEqual(ServerConfig.parse("mac.local")?.absoluteString, "http://mac.local:4317", "port 4317 is the default")
        XCTAssertEqual(ServerConfig.parse("https://mac.tail1234.ts.net")?.absoluteString, "https://mac.tail1234.ts.net")
        XCTAssertEqual(ServerConfig.parse("  100.101.102.103:4317 \n")?.absoluteString, "http://100.101.102.103:4317")
        XCTAssertNil(ServerConfig.parse(""))
        XCTAssertNil(ServerConfig.parse("ftp://x"))
        XCTAssertNil(ServerConfig.parse("http://"))
    }

    func testURLsForPathsAndSocket() {
        let c = ServerConfig(baseURL: ServerConfig.parse("192.168.1.5:4317")!)
        XCTAssertEqual(c.url(API.office).absoluteString, "http://192.168.1.5:4317/api/office")
        XCTAssertEqual(c.url(API.featurePivot(.team)).absoluteString, "http://192.168.1.5:4317/api/features/pivot?rows=team")
        XCTAssertEqual(c.socketURL.absoluteString, "ws://192.168.1.5:4317/ws")
        let s = ServerConfig(baseURL: ServerConfig.parse("https://mac.ts.net")!)
        XCTAssertEqual(s.socketURL.absoluteString, "wss://mac.ts.net/ws")
    }

    func testLoadAndSaveThroughDefaults() {
        let d = UserDefaults(suiteName: "ServerConfigTests")!
        d.removePersistentDomain(forName: "ServerConfigTests")
        XCTAssertNil(ServerConfig.load(defaults: d, env: [:]))
        ServerConfig(baseURL: ServerConfig.parse("10.0.0.2:4317")!).save(defaults: d)
        XCTAssertEqual(ServerConfig.load(defaults: d, env: [:])?.baseURL.absoluteString, "http://10.0.0.2:4317")
        ServerConfig.forget(defaults: d)
        XCTAssertNil(ServerConfig.load(defaults: d, env: [:]))
    }
}
