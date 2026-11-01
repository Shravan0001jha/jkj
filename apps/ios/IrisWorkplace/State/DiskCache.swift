import Foundation
import CryptoKit

/// The last good copy of the main lists, kept on the phone so a screen shows at once (owner, 23 Oct:
/// "make it faster by keeping some data in the phone itself").
///
/// Stale-while-revalidate: at connect the stores are filled from here before the first network call
/// lands, then `loadAll()` refreshes them and every successful load writes its fresh copy back.
/// The lists (Office, Inbox, Plan, Rooms), and since 1 Nov the chats (owner: "open instantly with
/// the data the phone already has, like Telegram"): the Talk thread list, the COO log and each
/// thread's latest `chatKeep` messages. Never a credential. Files are written with
/// `.completeFileProtection` (encrypted at rest, unreadable while the phone is locked), kept per
/// Workplace (relay or LAN address), and all deleted on sign-out.
///
/// A copy that is too old (`maxAge`) or from an older layout (`schema`) is discarded rather than shown:
/// a stale screen that looks current would be worse than a spinner. The one exception is the
/// dashboard snapshot (HLD-dashboard §2): it carries its own `generatedAt` and is always shown with
/// its age ("updated 3 h ago"), so it never expires — the Workplace server sleeps, and an old
/// snapshot that says how old it is beats an empty tab.
final class DiskCache: @unchecked Sendable {
    /// Bump when a cached type's layout changes in a way old files would decode wrongly.
    static let schema = 1
    static let maxAge: TimeInterval = 24 * 3600

    enum Key: String, CaseIterable {
        case office, inbox, plan, rooms, dashboard
        /// The Talk thread list, and the COO bridge log (servers without Talk threads).
        case talkThreads, cooLog

        /// How long a copy may be shown; nil = always (the screen shows the copy's own age).
        var maxAge: TimeInterval? {
            switch self {
            case .dashboard: return nil
            case .talkThreads, .cooLog: return DiskCache.chatMaxAge
            default: return DiskCache.maxAge
            }
        }
    }

    /// Chats: every message carries its own time, so an old copy is still true (only incomplete),
    /// and it is refreshed the moment the chat opens. A month bounds what sits on a phone unused.
    static let chatMaxAge: TimeInterval = 30 * 24 * 3600
    /// Messages kept per chat on disk (the newest).
    static let chatKeep = 200

    private struct Envelope<T: Codable>: Codable {
        let schema: Int
        let savedAt: Date
        let value: T
    }

    private let root: URL
    private let fm = FileManager.default
    private let lock = NSLock()
    private var scope = "default"
    /// Injectable for tests.
    var now: () -> Date = Date.init

    init(root: URL) {
        self.root = root
    }

    /// Application Support/WorkplaceCache: backed up with the app's data class, never in a shared container.
    static func appDefault() -> DiskCache {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                 appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
        return DiskCache(root: base.appendingPathComponent("WorkplaceCache", isDirectory: true))
    }

    /// One folder per Workplace, so a relay copy is never shown while paired to a LAN Mac (or vice versa).
    func setScope(_ config: ServerConfig) {
        let raw = "\(config.mode)-\(config.baseURL.host ?? "")-\(config.baseURL.port.map(String.init) ?? "")"
        lock.lock(); defer { lock.unlock() }
        scope = raw.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "." ? $0 : "_" }.reduce(into: "") { $0.append($1) }
    }

    private func file(_ key: Key) -> URL {
        lock.lock(); defer { lock.unlock() }
        return root.appendingPathComponent(scope, isDirectory: true).appendingPathComponent("\(key.rawValue).json")
    }

    /// One chat's messages: `<scope>/chats/<thread>.json`. Thread ids are server ids (employee ids,
    /// `coo`); anything outside a safe file-name alphabet, or long, is hashed.
    private func chatFile(_ threadId: String) -> URL {
        let safe = threadId.count <= 64 && !threadId.isEmpty && threadId.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
        let name = safe ? threadId : "h-" + SHA256.hash(data: Data(threadId.utf8)).map { String(format: "%02x", $0) }.joined()
        lock.lock(); defer { lock.unlock() }
        return root.appendingPathComponent(scope, isDirectory: true).appendingPathComponent("chats", isDirectory: true)
            .appendingPathComponent("\(name).json")
    }

    func save<T: Codable>(_ value: T, as key: Key) { write(value, to: file(key)) }

    func load<T: Codable>(_ type: T.Type, key: Key) -> T? { read(type, from: file(key), maxAge: key.maxAge) }

    /// The newest `chatKeep` messages of one chat (the caller passes them in order, oldest first).
    func saveChat<T: Codable>(_ messages: [T], threadId: String) {
        write(Array(messages.suffix(Self.chatKeep)), to: chatFile(threadId))
    }

    func loadChat<T: Codable>(_ type: T.Type, threadId: String) -> [T]? {
        read([T].self, from: chatFile(threadId), maxAge: Self.chatMaxAge)
    }

    func removeChat(threadId: String) { try? fm.removeItem(at: chatFile(threadId)) }

    func remove(_ key: Key) { try? fm.removeItem(at: file(key)) }

    private func write<T: Codable>(_ value: T, to url: URL) {
        do {
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(Envelope(schema: Self.schema, savedAt: now(), value: value))
            try data.write(to: url, options: [.atomic, .completeFileProtection])
        } catch {
            // A cache that cannot write only costs speed, never correctness.
        }
    }

    /// The cached value, or nil when there is none, it is too old, or it is from another schema.
    private func read<T: Codable>(_ type: T.Type, from url: URL, maxAge: TimeInterval?) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let env = try? JSONDecoder().decode(Envelope<T>.self, from: data),
              env.schema == Self.schema,
              maxAge.map({ now().timeIntervalSince(env.savedAt) <= $0 }) ?? true else {
            try? fm.removeItem(at: url)
            return nil
        }
        return env.value
    }

    /// Sign-out: nothing from the old session stays on the phone.
    func clearAll() {
        try? fm.removeItem(at: root)
    }
}
