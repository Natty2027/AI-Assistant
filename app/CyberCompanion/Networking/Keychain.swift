import Foundation
import Security

/// Keeps the access token in the Keychain rather than in preferences, so it isn't in backups in
/// plain text and other apps can't read it.
enum Keychain {
    private static let service = "com.natty2027.hera"

    /// The modern, per-app keychain on every platform. On a Mac, without this, items go to the
    /// older file-based keychain, which ignores the accessibility setting below.
    private static var base: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecUseDataProtectionKeychain as String: true]
    }

    static func read(_ account: String) -> String? {
        var query = base
        query[kSecAttrAccount as String] = account
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Returns false if the value couldn't be saved.
    @discardableResult
    static func write(_ value: String, for account: String) -> Bool {
        var item = base
        item[kSecAttrAccount as String] = account
        SecItemDelete(item as CFDictionary)
        guard !value.isEmpty else { return true }
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }
}
