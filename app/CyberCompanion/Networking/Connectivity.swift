import Foundation
import Network
import Observation

/// Whether the device has a network path, so the app can say "You're offline" up front instead
/// of letting a request time out.
@MainActor
@Observable
final class Connectivity {
    private(set) var isOnline = true
    private let monitor = NWPathMonitor()

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in self?.isOnline = online }
        }
        monitor.start(queue: DispatchQueue(label: "connectivity"))
    }

    deinit {
        monitor.cancel()
    }
}
