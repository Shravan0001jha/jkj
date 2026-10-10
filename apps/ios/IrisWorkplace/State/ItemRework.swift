import Foundation

/// A status change as the owner fills it in (rework, Oct 2026): every change carries a reason,
/// Waiting names who it waits on, Parked says when it resumes, Blocked is external only. Pure, so
/// the sheet and the store share one rule and it is unit-tested without a screen. Nothing is sent
/// until `request()` accepts it.
struct StatusChange: Equatable {
    var to: ItemStatus
    var reason: String = ""
    /// Waiting: an employee id, "owner" or "coo".
    var waitingOn: String?
    /// Waiting on the owner: what the team recommends (the server asks for it).
    var recommendation: String = ""
    /// Parked: when it should resume ("after 1.4 ships").
    var resumeWhen: String = ""
    /// Blocked: "external" or "release" (a wait on a person is Waiting, not Blocked).
    var blockedOn: String = "external"
    /// Done without doing it ("won't do").
    var resolution: ItemResolution?

    /// The server's own floor (`reason` or `note`, at least 3 characters).
    static let minReason = 3
    static let blockedCauses = ["external", "release"]

    enum Invalid: Error, Equatable, LocalizedError {
        case reason, waitingOn, recommendation, resumeWhen, blockedOn

        var errorDescription: String? {
            switch self {
            case .reason: return "Give a reason for this change."
            case .waitingOn: return "Choose who it is waiting on."
            case .recommendation: return "Waiting on you needs a recommendation."
            case .resumeWhen: return "Say when it should resume."
            case .blockedOn: return "Blocked is for outside causes: an external party or the release."
            }
        }
    }

    private static func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    static func validReason(_ s: String?) -> Bool { trimmed(s ?? "").count >= minReason }

    /// The first thing missing, or nil when it can be sent.
    var problem: Invalid? {
        if !Self.validReason(reason) { return .reason }
        switch to {
        case .waiting:
            guard let w = waitingOn, !Self.trimmed(w).isEmpty else { return .waitingOn }
            if w == "owner" && Self.trimmed(recommendation).isEmpty { return .recommendation }
        case .parked:
            if Self.trimmed(resumeWhen).isEmpty { return .resumeWhen }
        case .blocked:
            if !Self.blockedCauses.contains(blockedOn) { return .blockedOn }
        default:
            break
        }
        return nil
    }

    /// `{status, reason, waitingOn?, resumeWhen?}`; `note` repeats the reason for servers that
    /// predate `reason` (they require a note to reopen).
    func request() throws -> UpdateItemRequest {
        if let problem { throw problem }
        let why = Self.trimmed(reason)
        var r = UpdateItemRequest(status: to, resolution: resolution, note: why, reason: why)
        switch to {
        case .waiting:
            r.waitingOn = waitingOn
            if waitingOn == "owner" { r.recommendation = Self.trimmed(recommendation) }
        case .parked:
            r.resumeWhen = Self.trimmed(resumeWhen)
        case .blocked:
            r.waitingOn = blockedOn
            r.blockedReason = why
        default:
            break
        }
        return r
    }
}

extension UpdateItemRequest {
    /// Changes the status or the assignee: the server refuses those without a reason.
    var needsReason: Bool { status != nil || assigneeId != nil }
    var hasReason: Bool { StatusChange.validReason(reason) || StatusChange.validReason(note) }
}

// MARK: - The audit and the chain, as the story page reads them

extension AuditEntry {
    /// Newest first (the server sends newest last).
    static func newestFirst(_ entries: [AuditEntry]) -> [AuditEntry] {
        entries.enumerated().sorted { a, b in a.element.at != b.element.at ? a.element.at > b.element.at : a.offset > b.offset }.map(\.element)
    }

    /// What happened, in words: "In progress → Waiting", "assigned to Dev".
    func what(_ name: (String?) -> String) -> String {
        func status(_ raw: String?) -> String { raw.map { ItemStatus(rawValue: $0)?.glyph.label ?? $0 } ?? "—" }
        switch kind {
        case .created: return "created"
        case .assigned: return from.map { "reassigned from \(name($0)) to \(name(to))" } ?? "assigned to \(name(to))"
        case .status: return from == nil ? "moved to \(status(to))" : "\(status(from)) → \(status(to))"
        case .reviewer: return "reviewer: \(name(to))"
        case .parked: return "parked"
        case .reopened: return "reopened"
        case .doc: return "doc linked"
        case .unknown: return to.map { "changed to \($0)" } ?? "changed"
        }
    }

    /// The reason, or "not recorded" for rows from before reasons were required.
    var reasonLine: String {
        let r = reason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return r.isEmpty ? "not recorded" : r
    }
}

extension StoryChain {
    struct Person: Equatable, Hashable { let role: String; let id: String }

    /// Everyone on the story's path to done, in order; the charter itself is not a person.
    var people: [Person] {
        var out: [Person] = []
        func add(_ role: String, _ id: String?) { if let id, !id.isEmpty { out.append(Person(role: role, id: id)) } }
        add("Developer", developer)
        add("Reviewer", devReviewer)
        for r in extraReviewers { add("Extra reviewer", r) }
        add("QA", qa)
        add("Charter lead", lead)
        add("Chief of staff", chiefOfStaff)
        add("CTO", cto)
        return out
    }
}
