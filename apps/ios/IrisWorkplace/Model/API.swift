import Foundation

/// `WORKPLACE_API` from workplace-api.ts, one function per entry, so the app never guesses a path.
enum API {
    static let health = "/api/health"
    static let office = "/api/office"
    static let org = "/api/org"
    static func charter(_ id: String) -> String { "/api/charters/\(enc(id))" }
    static let inbox = "/api/inbox"
    static func inboxAnswer(_ id: String) -> String { "/api/inbox/\(enc(id))/answer" }
    static let talk = "/api/talk"
    static let requests = "/api/requests"
    static let employees = "/api/employees"
    static func employee(_ id: String) -> String { "/api/employees/\(enc(id))" }
    static func employeeTalk(_ id: String) -> String { "/api/employees/\(enc(id))/talk" }
    static func employeeEndSession(_ id: String) -> String { "/api/employees/\(enc(id))/end-session" }
    static func employeeContext(_ id: String) -> String { "/api/employees/\(enc(id))/context" }
    static func agentLog(_ id: String, view: String? = nil) -> String {
        let base = "/api/agents/\(enc(id))/log"
        return view.map { "\(base)?view=\($0)" } ?? base
    }
    static func agentMessage(_ id: String) -> String { "/api/agents/\(enc(id))/message" }
    static func agentInterrupt(_ id: String) -> String { "/api/agents/\(enc(id))/interrupt" }
    static func agentApprove(_ id: String) -> String { "/api/agents/\(enc(id))/approve" }
    static func agentMode(_ id: String) -> String { "/api/agents/\(enc(id))/mode" }
    static func agentImage(_ id: String, ref: String) -> String { "/api/agents/\(enc(id))/image?ref=\(enc(ref))" }
    static func work(kind: WorkKind? = nil, state: WorkState? = nil, charterId: String? = nil,
                     employeeId: String? = nil, featureId: String? = nil) -> String {
        withQuery("/api/work", [
            ("kind", kind?.rawValue), ("state", state?.rawValue), ("charterId", charterId),
            ("employeeId", employeeId), ("featureId", featureId),
        ])
    }
    static func workItem(_ id: String) -> String { "/api/work/\(enc(id))" }
    static func workTransition(_ id: String) -> String { "/api/work/\(enc(id))/transition" }
    static func workStart(_ id: String) -> String { "/api/work/\(enc(id))/start" }
    static let features = "/api/features"
    static func feature(_ id: String) -> String { "/api/features/\(enc(id))" }
    static func featureDecompose(_ id: String) -> String { "/api/features/\(enc(id))/decompose" }
    static func featurePivot(_ rows: PivotRows) -> String { "/api/features/pivot?rows=\(rows.rawValue)" }
    static func requirements(group: String? = nil) -> String { withQuery("/api/requirements", [("group", group)]) }
    static let coverage = "/api/requirements/coverage"
    static func route(text: String? = nil, paths: [String]? = nil, platforms: [String]? = nil,
                      requirementIds: [String]? = nil) -> String {
        withQuery("/api/route", [
            ("text", text), ("paths", paths?.joined(separator: ",")),
            ("platforms", platforms?.joined(separator: ",")), ("requirementIds", requirementIds?.joined(separator: ",")),
        ])
    }
    static let proposals = "/api/proposals"
    static func proposal(_ id: String) -> String { "/api/proposals/\(enc(id))" }
    static func proposalApply(_ id: String) -> String { "/api/proposals/\(enc(id))/apply" }
    static let releases = "/api/releases"
    static let releasesReady = "/api/releases/ready"
    static func releaseRun(_ id: String) -> String { "/api/releases/\(enc(id))/run" }
    static func spend(day: String? = nil) -> String { withQuery("/api/spend", [("day", day)]) }
    static let signals = "/api/health/signals"
    static let room = "/api/room"
    static func roomThread(_ id: String) -> String { "/api/room/\(enc(id))" }
    static func roomMessages(_ id: String) -> String { "/api/room/\(enc(id))/messages" }
    static func roomResolve(_ id: String) -> String { "/api/room/\(enc(id))/resolve" }
    static let pair = "/api/pair"
    static let pairExchange = "/api/pair/exchange"

    // The COO bridge: log/message/presence reach the phone over the session, like anything else;
    // reply/items/answer/forward are the lead's own actions and stay loopback-only.
    static let cooLog = "/api/coo/log"
    static let cooMessage = "/api/coo/message"
    static let cooReply = "/api/coo/reply"
    static let cooItems = "/api/coo/items"
    static let cooAnswer = "/api/coo/answer"
    static let cooForward = "/api/coo/forward"
    static let cooPresence = "/api/coo/presence"

    // v2 (LLD §19.8)
    static func plan(view: String? = nil) -> String { view.map { "/api/plan?view=\($0)" } ?? "/api/plan" }
    static let focus = "/api/focus"
    static func items(level: ItemLevel? = nil, status: ItemStatus? = nil, assigneeId: String? = nil,
                      areaId: String? = nil, parentId: String? = nil) -> String {
        withQuery("/api/items", [
            ("level", level?.rawValue), ("status", status?.rawValue), ("assigneeId", assigneeId),
            ("areaId", areaId), ("parentId", parentId),
        ])
    }
    static func item(_ id: String) -> String { "/api/items/\(enc(id))" }
    static func itemComments(_ id: String) -> String { "/api/items/\(enc(id))/comments" }
    static func itemMerge(_ id: String) -> String { "/api/items/\(enc(id))/merge" }
    static func updates(limit: Int? = nil, before: String? = nil) -> String {
        withQuery("/api/updates", [("limit", limit.map(String.init)), ("before", before)])
    }
    static func inboxThread(_ id: String) -> String { "/api/inbox/\(enc(id))" }
    static func inboxReply(_ id: String) -> String { "/api/inbox/\(enc(id))/reply" }
    static func status(_ q: String) -> String { withQuery("/api/status", [("q", q)]) }
    static let areas = "/api/areas"
    static func area(_ id: String) -> String { "/api/areas/\(enc(id))" }
    static let rooms = "/api/rooms"
    static func roomDetail(_ id: String) -> String { "/api/rooms/\(enc(id))" }
    static let releasePosts = "/api/releases/posts"
    static func releasePost(_ id: String) -> String { "/api/releases/posts/\(enc(id))" }

    static let socket = "/ws"

    // Relay-only (LLD-workplace-push §2, relay LLD): answered by the relay, never proxied.
    static let relayHealth = "/relay/health"
    static let pushRegister = "/api/push/register"
    static let pushUnregister = "/api/push/unregister"
    static let pushDevices = "/api/push/devices"

    /// `encodeURIComponent`: everything but A–Z a–z 0–9 - _ . ! ~ * ' ( ) is percent-encoded.
    static func enc(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_.!~*'()")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }

    /// `URLSearchParams` semantics: empty values are skipped, spaces become `+`.
    private static func withQuery(_ path: String, _ q: [(String, String?)]) -> String {
        let parts = q.compactMap { (k, v) -> String? in
            guard let v, !v.isEmpty else { return nil }
            return "\(formEnc(k))=\(formEnc(v))"
        }
        return parts.isEmpty ? path : "\(path)?\(parts.joined(separator: "&"))"
    }

    private static func formEnc(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "*-._")
        let e = s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
        return e.replacingOccurrences(of: "%20", with: "+")
    }
}
