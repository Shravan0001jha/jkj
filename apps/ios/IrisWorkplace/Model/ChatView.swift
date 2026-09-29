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
enum ChatView {
    private static let toolKinds: Set<LogKind> = [.read, .edit, .bash, .search, .task, .tool]

    static func collapse(_ entries: [LogEntry]) -> [LogEntry] {
        var out: [LogEntry] = []
        var run: [LogEntry] = []

        func flush() {
            guard let first = run.first else { return }
            if run.count == 1 { out.append(first) } else { out.append(activityEntry(run)) }
            run = []
        }

        for entry in entries {
            if toolKinds.contains(entry.kind) {
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
