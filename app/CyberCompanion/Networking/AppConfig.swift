import Foundation

/// Where a release build connects. Fill these in before shipping (the counterpart of Cognivate's
/// EXPO_PUBLIC_DOMAIN). While they're nil, the app uses the addresses entered under Settings →
/// Advanced, which is how development and the mock server work.
///
/// None of these are secrets: the Supabase anon key is designed to ship in apps. The
/// service-role key must never appear here; it lives only on the server.
enum AppConfig {
    /// e.g. URL(string: "https://api.cybercompanion.app")
    static let serverURL: URL? = nil
    /// e.g. URL(string: "https://abcd.supabase.co")
    static let supabaseURL: URL? = nil
    static let supabaseAnonKey: String? = nil
}

/// Normalizes what someone types as a server address. "api.example.com/" and
/// "https://api.example.com" both become https://api.example.com; plain http is kept only for
/// this machine, for development (ported from Cognivate's normalizeDomain).
enum ServerAddress {
    static func normalize(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasWebScheme = text.lowercased().hasPrefix("http://") || text.lowercased().hasPrefix("https://")
        // Any other scheme (ftp://, file://, ...) is refused rather than treated as a host name.
        if !hasWebScheme && text.contains("://") { return nil }
        if !hasWebScheme { text = "https://" + text }
        // Trim trailing slashes from the address itself, never into the scheme's "//".
        while text.hasSuffix("/") && !text.hasSuffix("://") { text.removeLast() }
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(), let host = url.host(), !host.isEmpty else { return nil }
        guard scheme == "https" || (scheme == "http" && allowsPlainHTTP(host: host)) else { return nil }
        return url
    }

    static func isLocal(host: String) -> Bool {
        host == "localhost" || host == "127.0.0.1"
    }

    /// Plain HTTP exists only for the mock server on this machine, and only in debug builds, so a
    /// release build can never be pointed at an unencrypted address.
    private static func allowsPlainHTTP(host: String) -> Bool {
        #if DEBUG
        isLocal(host: host)
        #else
        false
        #endif
    }
}
