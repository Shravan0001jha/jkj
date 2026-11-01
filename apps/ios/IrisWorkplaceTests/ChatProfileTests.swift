import XCTest
@testable import IrisWorkplace

/// The chat profile's header and About block (CHAT-NOTIFY-CONTRACT §3, §6.6).
final class ChatProfileTests: XCTestCase {
    private let names: (String?) -> String = { id in
        switch id {
        case "asha"?: return "Asha"
        case "owner"?: return "You"
        case let x?: return x
        case nil: return "—"
        }
    }

    func testAnEmployee() throws {
        let d = try Fixtures.decode("employee-detail", as: EmployeeDetail.self)   // Mira
        let p = ChatProfileInfo.employee(id: "mira", detail: d, card: nil, nameOf: names)
        XCTAssertEqual(p.kind, .employee)
        XCTAssertEqual(p.name, "Mira")
        XCTAssertEqual(p.subtitle, "Needs you")
        XCTAssertEqual(p.about, "waiting for your approval to run the errand tests")
        XCTAssertEqual(p.value("Role"), "Lead")
        XCTAssertEqual(p.value("Areas"), "Experts")
        XCTAssertEqual(p.value("Reports to"), "Asha")
        XCTAssertEqual(p.value("Model"), "sonnet")
        XCTAssertEqual(p.value("State"), "Needs you")
        XCTAssertEqual(p.facts.map(\.label), ["Role", "Areas", "Reports to", "Model", "State"])
    }

    func testTheRoleIsReadable() {
        XCTAssertEqual(ChatProfileInfo.roleTitle("chief-of-staff"), "Chief of staff")
        XCTAssertEqual(ChatProfileInfo.roleTitle("qa"), "QA")
        XCTAssertEqual(ChatProfileInfo.roleTitle("lead"), "Lead")
        XCTAssertEqual(ChatProfileInfo.roleTitle(""), "—")
    }

    func testTheNewestSessionsModel() throws {
        var d = try Fixtures.decode("employee-detail", as: EmployeeDetail.self)
        var newer = d.sessions[0]
        newer.id = "ag_new"; newer.model = "opus"; newer.startedAt = "2026-10-30T08:00:00.000Z"
        d.sessions = [newer, d.sessions[0]]
        XCTAssertEqual(ChatProfileInfo.employee(id: "mira", detail: d, card: nil, nameOf: names).value("Model"), "opus")
        d.sessions = []
        XCTAssertEqual(ChatProfileInfo.employee(id: "mira", detail: d, card: nil, nameOf: names).value("Model"), "—")
    }

    func testAnEmployeeFromTheCardOnlyNeverBlank() throws {
        let office = try Fixtures.decode("office", as: OfficeResponse.self)
        let card = try XCTUnwrap(office.cards().first { $0.employee.id == "dev" })
        let p = ChatProfileInfo.employee(id: "dev", detail: nil, card: card, nameOf: names)
        XCTAssertEqual(p.name, card.employee.name)
        XCTAssertEqual(p.value("Areas"), card.charters.map(\.title).joined(separator: ", ").nilIfEmpty ?? "—")
        let nothing = ChatProfileInfo.employee(id: "ghost", detail: nil, card: nil, nameOf: names)
        XCTAssertEqual(nothing.name, "ghost")
        XCTAssertEqual(nothing.value("Role"), "—")
        XCTAssertFalse(nothing.facts.isEmpty, "the rows show with dashes while loading")
    }

    func testTheCoo() {
        let now = Date(timeIntervalSince1970: 1_793_000_000)
        let seen = ISO8601DateFormatter().string(from: now.addingTimeInterval(-120))
        let on = ChatProfileInfo.coo(presence: CooPresence(online: true, lastHeartbeat: seen), now: now)
        XCTAssertEqual(on.kind, .coo)
        XCTAssertEqual(on.name, "Claude — COO")
        XCTAssertEqual(on.about, "Your COO: runs the Workplace, routes work, reports to you.")
        XCTAssertEqual(on.subtitle, "Online")
        XCTAssertEqual(on.online, true)
        XCTAssertEqual(on.value("Status"), "Online")
        XCTAssertEqual(on.value("Reports to"), "You")
        XCTAssertEqual(on.value("Last heartbeat"), "2 min ago")
        let off = ChatProfileInfo.coo(presence: CooPresence(online: false, lastHeartbeat: seen), now: now)
        XCTAssertEqual(off.subtitle, "Offline · last seen 2 min ago")
        XCTAssertEqual(off.online, false)
        let unknown = ChatProfileInfo.coo(presence: nil, now: now)
        XCTAssertEqual(unknown.subtitle, " ")
        XCTAssertEqual(unknown.value("Status"), "—")
        XCTAssertNil(unknown.online)
    }

    func testARoomThread() throws {
        let t = RoomThread(id: "th_1", title: "Errand tests", charterIds: [], createdBy: "dev", createdAt: "2026-10-01T00:00:00.000Z",
                           state: .open, summary: nil, lastAt: "2026-10-01T00:00:00.000Z", messageCount: 4,
                           participants: ["owner", "asha", "dev", "workplace"], escalations: [], headline: "")
        let p = ChatProfileInfo.room(t, id: "th_1", nameOf: names)
        XCTAssertEqual(p.kind, .room)
        XCTAssertEqual(p.name, "Errand tests")
        XCTAssertEqual(p.subtitle, "3 members")
        XCTAssertEqual(p.value("Members"), "You, Asha, dev")
        XCTAssertEqual(ChatProfileInfo.room(nil, id: "th_2", nameOf: names).name, "Thread")
    }
}
