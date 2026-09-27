import Foundation
import Security

/// The pairing token, and nothing else, in the Keychain. It is written on pairing, read on every
/// request, deleted on re-pair, and never displayed.
protocol TokenStore: AnyObject {
    var token: String? { get }
    func save(token: String)
    func clear()
}

final class Keychain: TokenStore {
    static let shared = Keychain()

    private let service = "com.irisforu.workplace"
    private let account = "api-token"

    var token: String? {
        var q = base()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        let s = String(data: d, encoding: .utf8)
        return (s ?? "").isEmpty ? nil : s
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
    init(token: String? = nil) { self.token = token }
    func save(token: String) { self.token = token }
    func clear() { token = nil }
}
