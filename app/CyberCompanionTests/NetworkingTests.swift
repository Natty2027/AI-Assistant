import Foundation
import Testing
@testable import CyberCompanion

/// The network layer ported from Cognivate: address cleanup, what's retried, the 401
/// refresh-and-retry contract, and the words people see when something fails.
@Suite(.serialized)
struct NetworkingTests {
    /* ---------------- addresses ---------------- */

    @Test func typedAddressesAreCleanedUp() {
        #expect(ServerAddress.normalize("api.example.com/")?.absoluteString == "https://api.example.com")
        #expect(ServerAddress.normalize("  https://api.example.com//  ")?.absoluteString == "https://api.example.com")
        #expect(ServerAddress.normalize("http://localhost:4480")?.absoluteString == "http://localhost:4480")
        #expect(ServerAddress.normalize("http://api.example.com") == nil, "plain http only for this machine")
        #expect(ServerAddress.normalize("") == nil)
    }

    /* ---------------- retry rules ---------------- */

    @Test func briefFailuresAreRetriedButOfflineAndBadRequestsAreNot() {
        #expect(RetryPolicy.isTransient(URLError(.timedOut)))
        #expect(RetryPolicy.isTransient(URLError(.networkConnectionLost)))
        #expect(!RetryPolicy.isTransient(URLError(.notConnectedToInternet)))
        #expect(RetryPolicy.isTransient(APIClient.APIError.server(status: 503, message: "", code: nil, requestID: nil)))
        #expect(RetryPolicy.isTransient(APIClient.APIError.server(status: 429, message: "", code: nil, requestID: nil)))
        #expect(!RetryPolicy.isTransient(APIClient.APIError.server(status: 400, message: "", code: nil, requestID: nil)))
        #expect(!RetryPolicy.isTransient(APIClient.APIError.server(status: 500, message: "", code: nil, requestID: nil)))
    }

    @Test func backoffMatchesCognivate() {
        #expect(RetryPolicy.delay(beforeRetry: 1, retryAfter: nil, jitter: 0) == 0.5)
        #expect(RetryPolicy.delay(beforeRetry: 2, retryAfter: nil, jitter: 0) == 1.5)
        #expect(RetryPolicy.delay(beforeRetry: 1, retryAfter: 3) == 3)
        #expect(RetryPolicy.delay(beforeRetry: 1, retryAfter: 600) == 8)
    }

    @Test func failuresReadAsSentences() {
        #expect(RetryPolicy.message(for: URLError(.notConnectedToInternet)).contains("offline"))
        #expect(RetryPolicy.message(for: URLError(.serverCertificateUntrusted)).contains("secure connection"))
        let error = APIClient.APIError.server(status: 500, message: "Something went wrong on our side.", code: nil, requestID: "ab12cd34")
        #expect(error.localizedDescription == "Something went wrong on our side. (Ref: ab12cd34)")
        // Sign-in failures never show the server's developer wording.
        let signedOut = APIClient.APIError.server(status: 401, message: "Not signed in. Send a Supabase access token…", code: nil, requestID: nil)
        #expect(signedOut.localizedDescription == "You've been signed out. Please sign in again.")
    }

    @Test func noncesAreRandomAndHashedForApple() {
        let a = Session.randomNonce(), b = Session.randomNonce()
        #expect(a.count == 32 && a != b)
        #expect(Session.sha256("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    /* ---------------- the transport, against a stubbed network ---------------- */

    @Test func a401RefreshesOnceAndRetriesWithTheNewToken() async throws {
        let tokens = TokenBox(["old", "new"])
        StubProtocol.handler = { request in
            let auth = request.value(forHTTPHeaderField: "Authorization")
            return auth == "Bearer new" ? (200, #"{"connections":[]}"#) : (401, #"{"error":"Token expired"}"#)
        }
        let client = APIClient(baseURL: URL(string: "https://api.test")!,
                               tokenProvider: { tokens.current },
                               refreshAfterUnauthorized: { tokens.advance() },
                               session: StubProtocol.session, sleep: { _ in })
        let connections = try await client.connections()
        #expect(connections.isEmpty)
        #expect(StubProtocol.requests.count == 2)
    }

    @Test func readsAreRetriedOnA503ButCreatesAreNot() async throws {
        var calls = 0
        StubProtocol.handler = { _ in
            calls += 1
            return calls < 3 ? (503, #"{"error":"busy"}"#) : (200, #"{"proposals":[]}"#)
        }
        let client = APIClient(baseURL: URL(string: "https://api.test")!, tokenProvider: { "t" }, session: StubProtocol.session, sleep: { _ in })
        _ = try await client.proposals()
        #expect(calls == 3)

        calls = 0
        StubProtocol.handler = { _ in calls += 1; return (503, #"{"error":"busy"}"#) }
        await #expect(throws: APIClient.APIError.self) { try await client.runAssistant(request: "hi", mode: .posts, allowWebSearch: false) }
        #expect(calls == 1, "a POST is never repeated automatically")
    }

    @Test func requestsCarryTheTokenAndLanguage() async throws {
        StubProtocol.handler = { _ in (200, #"{"granted":true}"#) }
        let client = APIClient(baseURL: URL(string: "https://api.test")!, tokenProvider: { "abc" }, session: StubProtocol.session)
        _ = try await client.aiConsent()
        let request = try #require(StubProtocol.requests.last)
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer abc")
        #expect(request.value(forHTTPHeaderField: "Accept-Language")?.isEmpty == false)
    }
}

/* ---------------- helpers ---------------- */

/// A token that changes when refreshed.
private final class TokenBox: @unchecked Sendable {
    private var values: [String]
    init(_ values: [String]) { self.values = values }
    var current: String { values[0] }
    func advance() -> Bool {
        guard values.count > 1 else { return false }
        values.removeFirst()
        return true
    }
}

/// Answers requests from a closure instead of the network.
private final class StubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (URLRequest) -> (Int, String) = { _ in (404, "{}") }
    nonisolated(unsafe) static var requests: [URLRequest] = []

    static var session: URLSession {
        requests = []
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.requests.append(request)
        let (status, body) = Self.handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
