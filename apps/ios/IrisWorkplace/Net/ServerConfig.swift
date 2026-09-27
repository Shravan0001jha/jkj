import Foundation

/// Where the Workplace is. The URL is not a secret and lives in UserDefaults; the token is in the
/// Keychain (`Keychain`). Debug builds also accept `WORKPLACE_URL` / `WORKPLACE_TOKEN` launch
/// environment variables so scripted simulator and device runs can skip the pairing screen.
struct ServerConfig: Equatable {
    var baseURL: URL

    static let defaultsKey = "workplace.serverURL"

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

    func url(_ path: String) -> URL {
        // `path` may carry a query; build by string so `?` is kept.
        URL(string: baseURL.absoluteString.trimmingSuffix("/") + path)!
    }

    static func load(defaults: UserDefaults = .standard, env: [String: String] = ProcessInfo.processInfo.environment) -> ServerConfig? {
        #if DEBUG
        if let raw = env["WORKPLACE_URL"], let u = parse(raw) { return ServerConfig(baseURL: u) }
        #endif
        guard let raw = defaults.string(forKey: defaultsKey), let u = parse(raw) else { return nil }
        return ServerConfig(baseURL: u)
    }

    func save(defaults: UserDefaults = .standard) {
        defaults.set(baseURL.absoluteString, forKey: Self.defaultsKey)
    }

    static func forget(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: defaultsKey)
    }
}

extension String {
    func trimmingSuffix(_ suffix: String) -> String {
        hasSuffix(suffix) ? String(dropLast(suffix.count)) : self
    }
}
