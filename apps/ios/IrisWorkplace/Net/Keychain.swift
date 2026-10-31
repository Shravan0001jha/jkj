import Foundation
import Security

/// A credential in the Keychain: written on sign-in or pairing, read on every request, deleted on
/// sign-out or re-pair, and never displayed.
protocol TokenStore: AnyObject {
    var token: String? { get }
    /// Like `token`, but tells "there is none" apart from "it is there but cannot be read right now".
    func read() -> TokenRead
    func save(token: String)
    func clear()
}

/// What a credential read found. `unavailable` is never "signed out": the Keychain refuses reads
/// (`errSecInteractionNotAllowed`) while protected data is locked, e.g. after a reboot before the
/// first unlock, and a transient failure must not look like the owner signed out.
enum TokenRead: Equatable {
    case present(String)
    case absent
    case unavailable
}

extension TokenStore {
    var token: String? { if case .present(let t) = read() { return t } else { return nil } }
}

final class Keychain: TokenStore {
    /// The relay session (`irisworkplace://auth#token=…`).
    static let relay = Keychain(account: "relay-session")
    /// The LAN pairing token (`POST /api/pair/exchange`).
    static let lan = Keychain(account: "api-token")

    private let service = "com.irisforu.workplace"
    private let account: String

    init(account: String) {
        self.account = account
    }

    func read() -> TokenRead {
        var q = base()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return .absent }
        guard status == errSecSuccess, let d = out as? Data else { return .unavailable }
        let s = String(data: d, encoding: .utf8) ?? ""
        return s.isEmpty ? .absent : .present(s)
    }

    func save(token: String) {
        let data = Data(token.utf8)
        let q = base()
        let status = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = q
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    func clear() {
        SecItemDelete(base() as CFDictionary)
    }

    private func base() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }
}

/// In-memory store for tests and previews.
final class MemoryTokenStore: TokenStore {
    var token: String?
    /// Tests: the store answers like a locked Keychain (the token is kept, but unreadable).
    var unavailable = false
    init(token: String? = nil) { self.token = token }
    func read() -> TokenRead { unavailable ? .unavailable : token.map(TokenRead.present) ?? .absent }
    func save(token: String) { self.token = token }
    func clear() { token = nil }
}
