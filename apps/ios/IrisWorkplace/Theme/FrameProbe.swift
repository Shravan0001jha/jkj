import QuartzCore
import os

/// Debug-only: WORKPLACE_AMBIENT_OFF=stars,shimmer,radar,pulse switches single ambient effects off,
/// to find which one costs frames. Always empty in release builds.
enum AmbientDebug {
    static let off: Set<String> = {
        #if DEBUG
        return Set((ProcessInfo.processInfo.environment["WORKPLACE_AMBIENT_OFF"] ?? "").split(separator: ",").map(String.init))
        #else
        return []
        #endif
    }()
}

#if DEBUG
/// A debug-only frame-time probe (docs/THEMES.md §2.5): with WORKPLACE_FRAME_PROBE=1 it watches
/// every display frame and logs, every 3 s, how many frames ran and how many took longer than
/// 1.5× the display interval (a dropped frame). Read with:
///   xcrun simctl spawn booted log show --last 5m --predicate 'eventMessage CONTAINS "FRAMEPROBE"'
final class FrameProbe: NSObject {
    static let shared = FrameProbe()
    private var link: CADisplayLink?
    private var last: CFTimeInterval = 0
    private var frames = 0, slow = 0, worst: CFTimeInterval = 0, windowStart: CFTimeInterval = 0
    private let log = Logger(subsystem: "com.irisforu.workplace", category: "frameprobe")

    func startIfAsked(_ env: [String: String] = ProcessInfo.processInfo.environment) {
        guard env["WORKPLACE_FRAME_PROBE"] == "1", link == nil else { return }
        let l = CADisplayLink(target: self, selector: #selector(tick(_:)))
        l.add(to: .main, forMode: .common)
        link = l
    }

    @objc private func tick(_ l: CADisplayLink) {
        let now = l.timestamp
        if last > 0 {
            let dt = now - last
            let expected = l.targetTimestamp - l.timestamp > 0 ? l.targetTimestamp - l.timestamp : 1.0 / 60
            frames += 1
            if dt > expected * 1.5 { slow += 1 }
            worst = max(worst, dt)
        } else { windowStart = now }
        last = now
        if now - windowStart >= 3 {
            log.notice("FRAMEPROBE frames=\(self.frames) slow=\(self.slow) worstMs=\(Int(self.worst * 1000))")
            frames = 0; slow = 0; worst = 0; windowStart = now
        }
    }
}
#endif
