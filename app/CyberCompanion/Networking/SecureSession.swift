import Foundation

/// The URLSession every call to our server and to Supabase goes through. Compared with
/// `URLSession.shared` it keeps nothing it doesn't need: no response cache and no cookie jar, so
/// authenticated replies are never written to disk. It also refuses redirects that would send the
/// Bearer token to another host or over plain HTTP, and it won't negotiate below TLS 1.2.
enum SecureSession {
    static let shared: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration, delegate: RedirectGuard(), delegateQueue: nil)
    }()
}

/// Follows a redirect only when it stays on the same host and keeps HTTPS (plain HTTP is allowed
/// only for a local development server in debug builds).
final class RedirectGuard: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? {
        Self.allows(from: task.originalRequest?.url, to: request.url) ? request : nil
    }

    static func allows(from original: URL?, to target: URL?) -> Bool {
        guard let original, let target, let host = original.host(), target.host() == host else { return false }
        if target.scheme?.lowercased() == "https" { return true }
        #if DEBUG
        return ServerAddress.isLocal(host: host)
        #else
        return false
        #endif
    }
}
