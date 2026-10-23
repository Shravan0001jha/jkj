import Foundation

/// The last good copy of the main lists, kept on the phone so a screen shows at once (owner, 23 Oct:
/// "make it faster by keeping some data in the phone itself").
///
/// Stale-while-revalidate: at connect the stores are filled from here before the first network call
/// lands, then `loadAll()` refreshes them and every successful load writes its fresh copy back.
/// Only the lists are kept (Office, Inbox, Plan, Rooms) — never a chat's message stream, never a
/// credential. Files are written with `.completeFileProtection` (encrypted at rest, unreadable while
/// the phone is locked), kept per Workplace (relay or LAN address), and all deleted on sign-out.
///
/// A copy that is too old (`maxAge`) or from an older layout (`schema`) is discarded rather than shown:
/// a stale screen that looks current would be worse than a spinner.
final class DiskCache: @unchecked Sendable {
    /// Bump when a cached type's layout changes in a way old files would decode wrongly.
    static let schema = 1
    static let maxAge: TimeInterval = 24 * 3600

    enum Key: String, CaseIterable {
        case office, inbox, plan, rooms
    }

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

    func save<T: Codable>(_ value: T, as key: Key) {
        let url = file(key)
        do {
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(Envelope(schema: Self.schema, savedAt: now(), value: value))
            try data.write(to: url, options: [.atomic, .completeFileProtection])
        } catch {
            // A cache that cannot write only costs speed, never correctness.
        }
    }

    /// The cached value, or nil when there is none, it is too old, or it is from another schema.
    func load<T: Codable>(_ type: T.Type, key: Key) -> T? {
        let url = file(key)
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let env = try? JSONDecoder().decode(Envelope<T>.self, from: data),
              env.schema == Self.schema,
              now().timeIntervalSince(env.savedAt) <= Self.maxAge else {
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
