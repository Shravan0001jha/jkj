import BackgroundTasks
import Foundation
import Observation

/// Whether the server has the snapshot endpoint at all.
enum DashAvailability: Equatable {
    /// No answer yet this session.
    case unknown
    case available
    /// 404: the Workplace has no `/api/metrics/snapshot` yet. Shown over any cached copy.
    case notYet
}

/// The mini dashboard (HLD-dashboard §2, §5): the last snapshot, kept on the phone and shown at once.
///
/// Refresh is automatic only — on launch, on foreground and from a background app refresh — and
/// never clears what is on screen: a 404, an offline Mac or a bad answer all keep the cached copy.
@MainActor @Observable
final class DashboardStore {
    private(set) var snapshot: DashboardSnapshot?
    private(set) var availability: DashAvailability = .unknown
    /// The last refresh's failure (not a 404), shown as a quiet line under the age.
    private(set) var error: String?
    private(set) var loading = false
    /// True while `snapshot` is the cached copy and no fresh one has landed yet.
    private(set) var fromCache = false
    private var lastAttempt: Date?
    /// The phone's last good copy (DiskCache); nil in tests that do not want one.
    var cache: DiskCache?
    /// Injectable for tests.
    var now: () -> Date = Date.init

    /// Launch and foreground often fire together; the snapshot is hourly, so once a minute is plenty.
    static let minInterval: TimeInterval = 60

    /// Show the cached snapshot at once, however old (its age is on screen).
    func hydrate() {
        guard snapshot == nil, let cached = cache?.load(DashboardSnapshot.self, key: .dashboard) else { return }
        snapshot = cached
        fromCache = true
    }

    /// Launch / foreground: fetch unless a fetch is running or one started under a minute ago.
    func refresh(_ rest: RestClient) async {
        if loading { return }
        if let last = lastAttempt, now().timeIntervalSince(last) < Self.minInterval { return }
        await load(rest)
    }

    /// Fetch now. Returns true when a fresh snapshot (or a definite "not yet") came back.
    @discardableResult
    func load(_ rest: RestClient) async -> Bool {
        loading = true
        lastAttempt = now()
        defer { loading = false }
        do {
            let s = try await rest.metricsSnapshot()
            snapshot = s
            availability = .available
            error = nil
            fromCache = false
            cache?.save(s, as: .dashboard)
            return true
        } catch {
            if error.isNotFound {
                availability = .notYet
                self.error = nil
                return true
            }
            if let m = error.userMessage { self.error = m }
            return false
        }
    }

    /// Sign-out: the stores outlive the session, the snapshot must not.
    func clear() {
        snapshot = nil
        availability = .unknown
        error = nil
        fromCache = false
        lastAttempt = nil
    }

    var updatedText: String? { snapshot.map { Self.updatedText($0.generatedAt, now: now()) } }

    /// "Updated just now", "Updated 12 min ago", "Updated 3 h ago", "Updated 2 d ago".
    static func updatedText(_ generatedAt: String, now: Date) -> String {
        guard let d = Format.date(generatedAt) else { return "Updated time unknown" }
        let secs = max(0, now.timeIntervalSince(d))
        if secs < 60 { return "Updated just now" }
        if secs < 3600 { return "Updated \(Int(secs / 60)) min ago" }
        if secs < 86_400 { return "Updated \(Int(secs / 3600)) h ago" }
        return "Updated \(Int(secs / 86_400)) d ago"
    }

    /// The snapshot is written hourly; older than two hours means refreshes are not landing.
    static func isStale(_ generatedAt: String, now: Date) -> Bool {
        guard let d = Format.date(generatedAt) else { return true }
        return now.timeIntervalSince(d) > 2 * 3600
    }
}

/// The background app refresh for the dashboard (BGAppRefreshTask). The identifier is listed in
/// Info.plist `BGTaskSchedulerPermittedIdentifiers`; SwiftUI's `.backgroundTask(.appRefresh(_:))`
/// registers the handler at launch, and every run schedules the next one.
enum DashboardRefresh {
    static let identifier = "com.irisforu.workplace.dashboard-refresh"
    /// The snapshot is regenerated hourly; iOS decides the real time anyway.
    static let interval: TimeInterval = 3600

    static func schedule() {
        let req = BGAppRefreshTaskRequest(identifier: identifier)
        req.earliestBeginDate = Date().addingTimeInterval(interval)
        // Fails on the simulator and when Background App Refresh is off: then the dashboard
        // refreshes on launch and foreground only, which is the designed fallback.
        try? BGTaskScheduler.shared.submit(req)
    }
}
