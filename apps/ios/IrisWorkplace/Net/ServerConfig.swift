import Foundation

/// How the app reaches the Workplace: through the public relay (default) or a LAN address it
/// paired with (a developer option). Neither is a secret, so both live in UserDefaults; the
/// credential for each lives in its own Keychain item (`Keychain.relay`, `Keychain.lan`).
enum ServerMode: String, Codable, CaseIterable {
    case relay, lan
}

struct ServerConfig: Equatable {
    var mode: ServerMode
    var baseURL: URL

    static let relayURL = URL(string: "https://work.irisforu.com")!
    static let modeKey = "workplace.mode"
    static let lanURLKey = "workplace.serverURL"
    static let relayURLKey = "workplace.relayURL"

    static var relay: ServerConfig { ServerConfig(mode: .relay, baseURL: relayURL) }

    /// Accepts `192.168.1.5:4317`, `http://mac.local:4317/`, `mac.local` (port 4317 assumed).
    static func parse(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") { s = "http://" + s }
        guard var comps = URLComponents(string: s), let host = comps.host, !host.isEmpty else { return nil }
        if comps.port == nil && comps.scheme == "http" { comps.port = 4317 }
        comps.path = ""
        comps.query = nil
        comps.fragment = nil
        guard comps.scheme == "http" || comps.scheme == "https" else { return nil }
        return comps.url
    }

    var socketURL: URL {
        var comps = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        comps.scheme = baseURL.scheme == "https" ? "wss" : "ws"
        comps.path = API.socket
        return comps.url!
    }

    /// Where the relay's sign-in starts, and where a first passkey is enrolled.
    var loginURL: URL { url("/login?app=1") }
    var enrolURL: URL { url("/login/enrol?app=1") }

    func url(_ path: String) -> URL {
        // `path` may carry a query; build by string so `?` is kept.
        URL(string: baseURL.absoluteString.trimmingSuffix("/") + path)!
    }

    /// Never nil: relay mode with the public URL is the default for a fresh install.
    static func load(defaults: UserDefaults = .standard, env: [String: String] = ProcessInfo.processInfo.environment) -> ServerConfig {
        #if DEBUG
        if let raw = env["WORKPLACE_URL"], let u = parse(raw) { return ServerConfig(mode: .lan, baseURL: u) }
        if let raw = env["WORKPLACE_RELAY_URL"], let u = parse(raw) { return ServerConfig(mode: .relay, baseURL: u) }
        #endif
        let mode = ServerMode(rawValue: defaults.string(forKey: modeKey) ?? "") ?? .relay
        switch mode {
        case .lan:
            if let raw = defaults.string(forKey: lanURLKey), let u = parse(raw) { return ServerConfig(mode: .lan, baseURL: u) }
            return .relay
        case .relay:
            if let raw = defaults.string(forKey: relayURLKey), let u = parse(raw) { return ServerConfig(mode: .relay, baseURL: u) }
            return .relay
        }
    }

    func save(defaults: UserDefaults = .standard) {
        defaults.set(mode.rawValue, forKey: Self.modeKey)
        switch mode {
        case .lan: defaults.set(baseURL.absoluteString, forKey: Self.lanURLKey)
        case .relay: defaults.set(baseURL.absoluteString, forKey: Self.relayURLKey)
        }
    }

    /// The LAN address the developer last paired with, if any.
    static func savedLAN(defaults: UserDefaults = .standard) -> URL? {
        defaults.string(forKey: lanURLKey).flatMap(parse)
    }

    static func forgetLAN(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: lanURLKey)
        if defaults.string(forKey: modeKey) == ServerMode.lan.rawValue { defaults.set(ServerMode.relay.rawValue, forKey: modeKey) }
    }
}

extension String {
    func trimmingSuffix(_ suffix: String) -> String {
        hasSuffix(suffix) ? String(dropLast(suffix.count)) : self
    }
}
