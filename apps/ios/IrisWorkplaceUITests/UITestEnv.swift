import Foundation
import XCTest

/// Where the UI tests find the mock, and which theme they run under (docs/THEMES.md §4).
/// Set on the xcodebuild line with the TEST_RUNNER_ prefix:
///   TEST_RUNNER_MOCK_PORT=4415 TEST_RUNNER_TALK_MOCK_PORT=4416 TEST_RUNNER_THEME=scifi xcodebuild … test
/// Defaults: 4399, 4411, and no theme override (the app's own choice, Default on a fresh install).
enum UITestEnv {
    private static let env = ProcessInfo.processInfo.environment
    static var port: String { env["MOCK_PORT"] ?? "4399" }
    static var talkPort: String { env["TALK_MOCK_PORT"] ?? "4411" }
    static var host: String { "127.0.0.1:\(port)" }
    static var talkHost: String { "127.0.0.1:\(talkPort)" }
    static var theme: String? { env["THEME"].flatMap { $0.isEmpty ? nil : $0 } }
}

extension XCUIApplication {
    /// `launch()` with the run's theme (WORKPLACE_THEME) when one is set.
    func launchThemed() {
        if let t = UITestEnv.theme { launchEnvironment["WORKPLACE_THEME"] = t }
        launch()
    }
}
