import Foundation

/// A Swift port of `@jkj/shared/chat-view.ts`'s `toChatView` (owner request, 29 Sep): Talk must
/// read like a chat, not a build log. The server serves this transform for
/// `GET /api/agents/:id/log?view=chat`; the app runs the *same* transform locally so the view
/// stays correct while a session is still running and raw entries keep streaming in over the
/// socket (`agent.log`) — collapsing is always applied fresh to the whole accumulated log, never
/// stored. The full log is never discarded; this only changes what `ConversationView` renders.
///
/// What counts as a message: `assistant`/`user` prose and `image` attachments pass through
/// unchanged. `read`/`edit`/`bash`/`search`/`task`/`tool` are tool activity: a run of *two or
/// more* consecutive ones collapses into one `activity` entry; a single one is left as it is,
/// since "worked · 1 step · 2s" reads worse than just showing the read. `system`/`error` entries
/// are neither tool activity nor a chat message and are left in place, uncollapsed.
///
/// v2 chat hygiene (LLD §19.9, "a chat is a chat"): a `user` entry the Workplace sent
/// (`from: workplace` — an assignment prompt, a moderation turn) and a `system` note are not
/// messages either: they fold into the activity line too, even alone, so nothing appears under the
/// owner's name that he did not write. Only a lone *tool* entry stays itself. Errors stay in place.
enum ChatView {
    private static let toolKinds: Set<LogKind> = [.read, .edit, .bash, .search, .task, .tool]

    static func isActivity(_ e: LogEntry) -> Bool {
        toolKinds.contains(e.kind) || e.kind == .system || (e.kind == .user && e.from == .workplace)
    }

    static func collapse(_ entries: [LogEntry]) -> [LogEntry] {
        var out: [LogEntry] = []
        var run: [LogEntry] = []

        func flush() {
            guard let first = run.first else { return }
            if run.count == 1 && toolKinds.contains(first.kind) { out.append(first) } else { out.append(activityEntry(run)) }
            run = []
        }

        for entry in entries {
            if isActivity(entry) {
                run.append(entry)
            } else {
                flush()
                out.append(entry)
            }
        }
        flush()
        return out
    }

    private static func activityEntry(_ run: [LogEntry]) -> LogEntry {
        let first = run[0]
        let last = run[run.count - 1]
        let durationMs = max(0, Int((Format.date(last.at) ?? Date()).timeIntervalSince(Format.date(first.at) ?? Date()) * 1000))
        return LogEntry(
            id: "activity_\(first.id)", agentId: first.agentId, at: first.at, kind: .activity, label: "",
            text: "worked · \(run.count) step\(run.count == 1 ? "" : "s") · \(humanDuration(durationMs))",
            activity: LogActivity(count: run.count, durationMs: durationMs, entries: run)
        )
    }

    private static func humanDuration(_ ms: Int) -> String {
        let totalSeconds = Int((Double(ms) / 1000).rounded())
        if totalSeconds < 60 { return "\(totalSeconds)s" }
        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        return seconds != 0 ? "\(minutes)m \(seconds)s" : "\(minutes)m"
    }
}
