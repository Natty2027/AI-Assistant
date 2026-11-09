import Foundation

/// When a failed request is worth retrying, ported from the taxonomy in Cognivate's withAiRetry.
/// Only reads (GET) are retried automatically: repeating a POST could publish or run twice.
enum RetryPolicy {
    static let maxAttempts = 3

    /// Brief failures that often succeed a moment later. Being offline isn't one: that fails
    /// at once with a clear message instead of making the person wait.
    static func isTransient(_ error: Error) -> Bool {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .timedOut, .networkConnectionLost, .cannotConnectToHost, .dnsLookupFailed, .badServerResponse:
                return true
            default:
                return false
            }
        }
        if case APIClient.APIError.server(let status, _, _, _) = error {
            return status == 429 || status == 502 || status == 503 || status == 504
        }
        return false
    }

    /// 0.5s, then 1.5s, plus up to 0.25s of jitter, unless the server said how long to wait
    /// (capped at 8s).
    static func delay(beforeRetry attempt: Int, retryAfter: TimeInterval?, jitter: Double = .random(in: 0..<0.25)) -> TimeInterval {
        if let retryAfter { return min(max(retryAfter, 0), 8) }
        return min(0.5 * pow(3, Double(attempt - 1)) + jitter, 8)
    }

    static func retryAfter(from response: HTTPURLResponse) -> TimeInterval? {
        guard let value = response.value(forHTTPHeaderField: "Retry-After") else { return nil }
        if let seconds = TimeInterval(value) { return seconds }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return formatter.date(from: value).map { $0.timeIntervalSinceNow }
    }

    /// Words for a person instead of a raw error.
    static func message(for error: Error) -> String {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .notConnectedToInternet, .dataNotAllowed:
                return "You're offline. Check your connection and try again."
            case .timedOut:
                return "Hera took too long to answer. Please try again."
            case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed:
                return "Can't reach Hera right now. Check your connection and try again."
            case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
                 .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot, .clientCertificateRejected:
                return "Hera's secure connection couldn't be verified, so the app didn't connect."
            case .networkConnectionLost:
                return "The connection dropped. Please try again."
            default:
                return "Something went wrong connecting to Hera. Please try again."
            }
        }
        return error.localizedDescription
    }
}
