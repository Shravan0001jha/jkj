import Foundation
import Network

/// Tells the model when the network path changes (Wi-Fi ↔ cellular, airplane mode), so the socket
/// reconnects at once instead of waiting out its backoff. A fake drives it in tests.
protocol PathMonitoring: AnyObject {
    var onChange: ((_ satisfied: Bool) -> Void)? { get set }
    func start()
    func stop()
}

final class NetworkMonitor: PathMonitoring {
    var onChange: ((Bool) -> Void)?
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.irisforu.workplace.path")
    private var last: Bool?

    func start() {
        monitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            guard let self, self.last != satisfied else { return }
            self.last = satisfied
            DispatchQueue.main.async { self.onChange?(satisfied) }
        }
        monitor.start(queue: queue)
    }

    func stop() { monitor.cancel() }
}
