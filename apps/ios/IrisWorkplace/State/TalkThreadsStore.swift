import Foundation
import Observation

/// Talk threads (LLD-app-fixes §2–§4): the list with unread, pins and typing; each thread's
/// messages with their real sender, receipts, replies and files; sending text, files and voice.
///
/// `supported` stays nil until the first load answers: a server without `/api/talk/threads` (404)
/// sets it false and the app keeps today's chat (the session log, the COO bridge, local pins).
@MainActor @Observable
final class TalkThreadsStore {
    private(set) var supported: Bool?
    private(set) var threads: [String: TalkThread] = [:]
    private(set) var messages: [String: [TalkMessage]] = [:]
    private(set) var loadingThread: Set<String> = []
    private(set) var sending: Set<String> = []
    private(set) var error: String?
    /// Thread id → typing, from `talk.typing` (and `TalkThread.typing` on load).
    private(set) var typing: Set<String> = []
    /// Who can be @mentioned, from `/api/mentionable` (nil until loaded or on an older server).
    private(set) var mentionable: [Mentionable]?
    /// Messages the owner just sent, shown at once with a clock until the server's copy lands.
    private(set) var outgoing: [String: [TalkMessage]] = [:]

    func load(_ rest: RestClient) async {
        do {
            let list = try await rest.talkThreads()
            threads = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            typing = Set(list.filter(\.typing).map(\.id))
            supported = true
            error = nil
        } catch {
            if error.isNotFound { supported = false; return }
            if let m = error.userMessage { self.error = m }
        }
        if supported == true, mentionable == nil { mentionable = try? await rest.mentionable() }
    }

    func loadMessages(_ rest: RestClient, threadId: String) async {
        loadingThread.insert(threadId)
        defer { loadingThread.remove(threadId) }
        do {
            let page = try await rest.talkMessages(threadId)
            var merged = Dictionary((messages[threadId] ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            for m in page { merged[m.id] = m }
            messages[threadId] = merged.values.sorted { $0.at < $1.at }
            error = nil
        } catch {
            if error.isNotFound { supported = false; return }
            if let m = error.userMessage { self.error = m }
        }
    }

    /// Order of the Talk list: the server's own when it sent one, re-applied live.
    func ordered(_ ids: [String]) -> [String] {
        let pinned = threads.values.filter(\.pinned).sorted { ($0.pinnedAt ?? "") > ($1.pinnedAt ?? "") }.map(\.id)
        return TalkPrefs.order(ids, id: { $0 }, lastAt: { self.threads[$0]?.lastMessageAt }, unread: { self.threads[$0]?.unreadCount ?? 0 },
                               pinned: pinned, name: { self.threads[$0]?.name ?? $0 })
    }

    // MARK: actions

    /// Text, a reply, mentions and files (uploaded first, then referenced). The message shows at
    /// once with a clock; the server's copy (with its receipt) replaces it.
    func send(_ rest: RestClient, threadId: String, text: String, replyTo: TalkMessage?, mentions: [String],
              files: [OutgoingAttachment]) async throws -> Agent? {
        sending.insert(threadId)
        defer { sending.remove(threadId) }
        let local = TalkMessage(id: "local-\(UUID().uuidString)", threadId: threadId, at: TalkPrefs.iso(Date()), from: "owner", fromName: "You",
                                direction: .in, text: text,
                                replyTo: replyTo.map { TalkReplyRef(id: $0.id, from: $0.from, fromName: $0.fromName, text: String($0.text.prefix(140))) },
                                mentions: mentions)
        outgoing[threadId, default: []].append(local)
        defer { outgoing[threadId]?.removeAll { $0.id == local.id } }
        var ids: [String] = []
        for f in files {
            let a = try await rest.uploadTalkAttachment(threadId, name: f.name, mediaType: f.mediaType, data: f.data)
            if let url = f.savedLocally() { sentFiles[a.id] = url }
            ids.append(a.id)
        }
        let r = try await rest.sendTalk(threadId, SendTalkMessageRequest(text: text.isEmpty ? nil : text, replyTo: replyTo?.id,
                                                                       mentions: mentions.isEmpty ? nil : mentions,
                                                                       attachmentIds: ids.isEmpty ? nil : ids))
        upsert(r.message)
        return r.agent
    }

    func sendVoice(_ rest: RestClient, threadId: String, note: OutgoingAttachment, replyTo: TalkMessage?) async throws -> Agent? {
        sending.insert(threadId)
        defer { sending.remove(threadId) }
        let r = try await rest.sendVoice(threadId, name: note.name, durationMs: note.durationMs, replyTo: replyTo?.id, data: note.data)
        if let att = r.message.voice?.attachmentId ?? r.message.attachments.first?.id, let url = note.savedLocally() { sentFiles[att] = url }
        upsert(r.message)
        return r.agent
    }

    /// The bytes of a file this phone just sent, so it plays/previews without a download.
    private(set) var sentFiles: [String: URL] = [:]

    func markRead(_ rest: RestClient, threadId: String) async {
        guard supported == true else { return }
        if var t = threads[threadId] { t.unreadCount = 0; threads[threadId] = t }
        if let t = try? await rest.readTalk(threadId) { threads[threadId] = t }
    }

    func setPinned(_ rest: RestClient, threadId: String, pinned: Bool) async throws {
        let t = try await rest.pinTalk(threadId, pinned: pinned)
        threads[threadId] = t
    }

    // MARK: events

    func handle(_ event: ServerEvent) {
        switch event {
        case .talkMessage(let m, let t):
            if supported == nil { supported = true }
            threads[t.id] = t
            upsert(m)
            // A reply landed: the turn that wrote it is the one typing; the event that ends it follows.
            if m.direction == .out, m.quiet != true, !t.typing { typing.remove(t.id) }
        case .talkThread(let t):
            threads[t.id] = t
            if t.typing { typing.insert(t.id) } else { typing.remove(t.id) }
        case .talkTyping(let threadId, _, let on):
            if on { typing.insert(threadId) } else { typing.remove(threadId) }
        default:
            break
        }
    }

    private func upsert(_ m: TalkMessage) {
        var list = messages[m.threadId] ?? []
        if let i = list.firstIndex(where: { $0.id == m.id }) { list[i] = m } else { list.append(m); list.sort { $0.at < $1.at } }
        messages[m.threadId] = list
    }

    /// What the chat shows: the server's messages, then the ones still on their way.
    func shown(_ threadId: String) -> [TalkMessage] { (messages[threadId] ?? []) + (outgoing[threadId] ?? []) }
}
