import Foundation
import Observation

/// The Sci-fi CX's state (docs/THEMES.md §3): the decision queue and its undo window, the
/// since-you-last-looked baseline, the command palette. Lives for the app's lifetime; Default never
/// shows any of it.
@MainActor @Observable
final class SciFiCX {
    var queue = DecisionQueue()
    let stager: DecisionStager
    /// What the owner saw at the end of the last session with the Bridge on screen.
    private(set) var baseline: BridgeSnapshot?
    @ObservationIgnored var bridgeSeen = false
    var showPalette = false
    /// The last staged answer that failed, shown under the queue.
    var lastError: String?

    @ObservationIgnored private let snapshots: BridgeSnapshotStore
    @ObservationIgnored private weak var model: AppModel?

    init(model: AppModel, defaults: UserDefaults = .standard, window: TimeInterval = 4) {
        self.model = model
        snapshots = BridgeSnapshotStore(defaults: defaults)
        baseline = snapshots.load()
        var send: (DecisionStager.Pending) async -> Void = { _ in }
        stager = DecisionStager(window: window) { await send($0) }
        send = { [weak self] p in await self?.send(p) }
    }

    func current(at now: Date = Date()) -> BridgeSnapshot? {
        guard let model, model.plan.plan != nil else { return nil }
        return BridgeSnapshot.capture(plan: model.plan.plan, open: model.inbox.open, updates: model.updates.updates, at: now)
    }

    var digest: BridgeDigest? { current().flatMap { BridgeDigest.diff(from: baseline, to: $0) } }

    /// Going to the background: send what is waiting in the undo window, and remember what was seen.
    func background() async {
        await stager.commitAll()
        if bridgeSeen, let now = current() {
            snapshots.save(now)
            baseline = now
            bridgeSeen = false
        }
    }

    private func send(_ p: DecisionStager.Pending) async {
        guard let model, let item = model.inbox.item(p.itemId) else { return }
        do {
            try await model.answer(item: item, option: p.option, note: p.note)
            lastError = nil
        } catch {
            lastError = error.userMessage
        }
    }
}
