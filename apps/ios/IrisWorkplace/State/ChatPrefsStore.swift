import Foundation
import Observation

/// What the mute menu offers (Telegram's set): CHAT-NOTIFY-CONTRACT §2.
enum MuteOption: String, CaseIterable, Identifiable {
    case hour, eightHours, day, forever, unmute

    var id: String { rawValue }
    /// The muting choices, in menu order (Unmute is offered separately, only when muted).
    static let muting: [MuteOption] = [.hour, .eightHours, .day, .forever]

    var title: String {
        switch self {
        case .hour: return "1 hour"
        case .eightHours: return "8 hours"
        case .day: return "1 day"
        case .forever: return "Forever"
        case .unmute: return "Unmute"
        }
    }

    var seconds: TimeInterval? {
        switch self {
        case .hour: return 3600
        case .eightHours: return 8 * 3600
        case .day: return 86_400
        case .forever, .unmute: return nil
        }
    }

    func pref(now: Date) -> ChatPref {
        switch self {
        case .unmute: return ChatPref(muted: false, mutedUntil: nil)
        case .forever: return ChatPref(muted: true, mutedUntil: nil)
        default: return ChatPref(muted: true, mutedUntil: ChatPrefsStore.iso(now.addingTimeInterval(seconds ?? 0)))
        }
    }
}

/// Per-chat mute (CHAT-NOTIFY-CONTRACT §2, §6.5). The server owns the setting; this phone mirrors
/// it in UserDefaults so a push that cold-launches the app already knows, and keeps it alone while
/// the server has no route yet (404: `supported == false`, "applies on this phone").
@MainActor @Observable
final class ChatPrefsStore {
    /// nil until `GET /api/chats/prefs` answers; false when the server has no such route.
    private(set) var supported: Bool?
    private(set) var prefs: [String: ChatPref] = [:]
    /// The last failed change, in words (a rolled-back mute).
    private(set) var error: String?
    /// Bumped when a timed mute runs out, so icons drop without a reload.
    private(set) var revision = 0
    /// Injectable for tests.
    var now: () -> Date = Date.init

    static let defaultsKey = "iris.chatPrefs.v1"
    static let localNote = "Mute applies on this phone until the server update"

    private let defaults: UserDefaults
    private var expiryTask: Task<Void, Never>?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.defaultsKey),
           let cached = try? JSONDecoder().decode([String: ChatPref].self, from: data) {
            prefs = cached
        }
    }

    /// True while changes stay on this phone only.
    var localOnly: Bool { supported == false }

    func pref(_ threadId: String) -> ChatPref? { prefs[threadId] }

    /// Muted right now: the stored pref, else the contract's default (rooms muted, 1:1 and the COO not).
    func isMuted(_ threadId: String, isRoom: Bool = false) -> Bool {
        _ = revision
        guard let p = prefs[threadId] else { return isRoom }
        return Self.isMuted(p, now: now())
    }

    nonisolated static func isMuted(_ p: ChatPref, now: Date) -> Bool {
        guard p.muted else { return false }
        guard let raw = p.mutedUntil else { return true }
        guard let until = date(raw) else { return true }
        return until > now
    }

    /// When a timed mute ends (nil: forever, or not muted).
    func mutedUntil(_ threadId: String) -> Date? {
        guard let p = prefs[threadId], Self.isMuted(p, now: now()), let raw = p.mutedUntil else { return nil }
        return Self.date(raw)
    }

    /// "On", "Muted", "Muted until 14:05" (today) or "Muted until 3 Nov, 14:05".
    func statusText(_ threadId: String, isRoom: Bool = false) -> String {
        guard isMuted(threadId, isRoom: isRoom) else { return "On" }
        guard let until = mutedUntil(threadId) else { return "Muted" }
        if Calendar.current.isDate(until, inSameDayAs: now()) {
            return "Muted until \(until.formatted(date: .omitted, time: .shortened))"
        }
        return "Muted until \(until.formatted(.dateTime.day().month(.abbreviated).hour().minute()))"
    }

    /// The earliest timed mute still to run out.
    var nextExpiry: Date? {
        let n = now()
        return prefs.values.compactMap { p -> Date? in
            guard p.muted, let raw = p.mutedUntil, let d = Self.date(raw), d > n else { return nil }
            return d
        }.min()
    }

    // MARK: server

    func load(_ rest: RestClient) async {
        do {
            let map = try await rest.chatPrefs()
            prefs = map
            supported = true
            error = nil
            persist()
        } catch {
            if error.isNotFound { supported = false; return }
            // Offline: the cached map stays; nothing to show (the connection strip already says so).
        }
        scheduleExpiry()
    }

    /// Optimistic: the pref changes now; a failure puts the old one back and throws.
    func set(_ rest: RestClient?, threadId: String, option: MuteOption) async throws {
        let old = prefs[threadId]
        let new = option.pref(now: now())
        prefs[threadId] = new
        error = nil
        scheduleExpiry()
        if supported == false { persist(); return }
        do {
            guard let rest else { throw WorkplaceError.notPaired }
            let saved = try await rest.setChatPref(threadId, new)
            prefs[threadId] = saved
            supported = true
            persist()
        } catch {
            if error.isNotFound {
                supported = false
                persist()
                return
            }
            prefs[threadId] = old
            scheduleExpiry()
            if let m = error.userMessage { self.error = m }
            throw error
        }
        scheduleExpiry()
    }

    func handle(_ event: ServerEvent) {
        guard case .chatPrefs(let threadId, let pref) = event else { return }
        prefs[threadId] = pref
        persist()
        scheduleExpiry()
    }

    func clearError() { error = nil }

    // MARK: local

    private func persist() {
        if let data = try? JSONEncoder().encode(prefs) { defaults.set(data, forKey: Self.defaultsKey) }
    }

    private func scheduleExpiry() {
        expiryTask?.cancel()
        guard let next = nextExpiry else { return }
        let wait = max(0.5, next.timeIntervalSince(now()) + 0.5)
        expiryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled, let self else { return }
            self.revision += 1
            self.scheduleExpiry()
        }
    }

    // MARK: dates

    nonisolated static func iso(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: d)
    }

    nonisolated static func date(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}
