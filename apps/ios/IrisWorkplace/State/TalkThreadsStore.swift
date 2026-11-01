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

    /// The phone's copy (DiskCache, owner 1 Nov: chats open instantly, like Telegram): the thread
    /// list and each chat's newest messages. Nil in tests that do not want one.
    var cache: DiskCache?
    /// True while `threads` is the cached list and the fresh one has not landed.
    private(set) var listFromCache = false
    /// Chats showing their cached copy while the fresh page is on its way ("Updating…").
    private(set) var staleThreads: Set<String> = []

    /// What the list cache holds: the threads, and that this server has them at all.
    struct ListCache: Codable { var threads: [TalkThread] }

    /// At connect: the cached thread list, so a chat opens on the thread view at once instead of
    /// waiting for the server to say it has threads (`supported` nil showed the older chat's spinner).
    func hydrate() {
        guard supported == nil, threads.isEmpty, let cached = cache?.load(ListCache.self, key: .talkThreads) else { return }
        threads = Dictionary(cached.threads.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        supported = true
        listFromCache = true
    }

    /// Opening a chat: its cached messages, when memory has none yet. Memory always wins (it is newer).
    func hydrateMessages(_ threadId: String) {
        guard messages[threadId] == nil, let cached = cache?.loadChat(TalkMessage.self, threadId: threadId), !cached.isEmpty else { return }
        messages[threadId] = Self.merge(cached, [])
        staleThreads.insert(threadId)
    }

    func load(_ rest: RestClient) async {
        do {
            let list = try await rest.talkThreads()
            threads = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            typing = Set(list.filter(\.typing).map(\.id))
            supported = true
            listFromCache = false
            error = nil
            cache?.save(ListCache(threads: list), as: .talkThreads)
        } catch {
            if error.isNotFound { unsupported(); return }
            if let m = error.userMessage { self.error = m }
        }
        if supported == true, mentionable == nil { mentionable = try? await rest.mentionable() }
    }

    func loadMessages(_ rest: RestClient, threadId: String) async {
        loadingThread.insert(threadId)
        defer { loadingThread.remove(threadId) }
        do {
            let page = try await rest.talkMessages(threadId)
            messages[threadId] = Self.merge(messages[threadId] ?? [], page)
            staleThreads.remove(threadId)
            error = nil
            persist(threadId)
        } catch {
            if error.isNotFound { unsupported(); return }
            if let m = error.userMessage { self.error = m }
        }
    }

    /// The chat's spinner: only while its first page loads and the phone has nothing to show.
    func showsSpinner(_ threadId: String) -> Bool { loadingThread.contains(threadId) && messages[threadId] == nil }
    /// The cached copy is on screen and the fresh page is on its way ("Updating…" in the header).
    func isUpdating(_ threadId: String) -> Bool { staleThreads.contains(threadId) && loadingThread.contains(threadId) }

    /// Cached (or in-memory) and fresh in one list: one copy per id (the fresh one wins: receipts,
    /// edits), oldest first; equal times keep a stable order by id.
    static func merge(_ old: [TalkMessage], _ fresh: [TalkMessage]) -> [TalkMessage] {
        var byId = Dictionary(old.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
        for m in fresh { byId[m.id] = m }
        return byId.values.sorted { $0.at != $1.at ? $0.at < $1.at : $0.id < $1.id }
    }

    /// A server without threads (404): drop what the cache claimed, the older chat takes over.
    private func unsupported() {
        supported = false
        listFromCache = false
        staleThreads.removeAll()
        cache?.remove(.talkThreads)
    }

    private func persist(_ threadId: String) {
        guard let cache, let list = messages[threadId] else { return }
        cache.saveChat(list, threadId: threadId)
    }

    /// Sign-out: nothing of the old session stays in memory either.
    func clear() {
        supported = nil; threads = [:]; messages = [:]; loadingThread = []; sending = []; error = nil
        typing = []; mentionable = nil; outgoing = [:]; sentFiles = [:]; listFromCache = false; staleThreads = []
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
        persist(threadId)
        return r.agent
    }

    func sendVoice(_ rest: RestClient, threadId: String, note: OutgoingAttachment, replyTo: TalkMessage?) async throws -> Agent? {
        sending.insert(threadId)
        defer { sending.remove(threadId) }
        let r = try await rest.sendVoice(threadId, name: note.name, durationMs: note.durationMs, replyTo: replyTo?.id, data: note.data)
        if let att = r.message.voice?.attachmentId ?? r.message.attachments.first?.id, let url = note.savedLocally() { sentFiles[att] = url }
        upsert(r.message)
        persist(threadId)
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
            persist(m.threadId)
            if !listFromCache { cache?.save(ListCache(threads: Array(threads.values)), as: .talkThreads) }
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
        if let i = list.firstIndex(where: { $0.id == m.id }) { list[i] = m } else { list.append(m); list.sort { $0.at != $1.at ? $0.at < $1.at : $0.id < $1.id } }
        messages[m.threadId] = list
    }

    /// What the chat shows: the server's messages, then the ones still on their way.
    func shown(_ threadId: String) -> [TalkMessage] { (messages[threadId] ?? []) + (outgoing[threadId] ?? []) }
}
