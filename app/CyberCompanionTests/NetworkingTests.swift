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
        #expect(connections.connections.isEmpty)
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

    @Test func longRunsAreStartedThenCheckedUntilTheyFinish() async throws {
        var checks = 0
        StubProtocol.handler = { request in
            if request.httpMethod == "POST" { return (200, #"{"run_id":"6f1c2d3e-0000-4000-8000-000000000001"}"#) }
            checks += 1
            return checks < 3 ? (200, #"{"status":"running"}"#)
                : (200, #"{"status":"finished","result":{"status":"done","text":"Your launch is ready.","tainted":false,"drafts":[],"proposals":[]}}"#)
        }
        let client = APIClient(baseURL: URL(string: "https://api.test")!, tokenProvider: { "t" }, session: StubProtocol.session, sleep: { _ in })
        let run = try await client.runAssistant(request: "Launch my workshop", mode: .launch, allowWebSearch: false)
        #expect(run.text == "Your launch is ready.")
        #expect(checks == 3)
        let start = try #require(StubProtocol.requests.first)
        #expect(start.url?.path() == "/agent/runs")
        let body = try #require(StubProtocol.bodies.first.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
        #expect(body["brand"] == nil, "the server no longer uses the brand")
        let checkRequests = StubProtocol.requests.dropFirst()
        #expect(checkRequests.count == 3)
        for check in checkRequests {
            #expect(check.url?.path() == "/agent/runs/6f1c2d3e-0000-4000-8000-000000000001")
            #expect(check.url?.query() == "wait=20")
        }
    }

    /// Talk asks for the answer as it's written: each check says how much the app has, every new
    /// piece is passed on and asked after again at once, and the body asks the server to stream.
    @Test func talkHearsTheAnswerAsItsWritten() async throws {
        var checks = 0
        StubProtocol.handler = { request in
            if request.httpMethod == "POST" { return (200, #"{"run_id":"6f1c2d3e-0000-4000-8000-000000000009"}"#) }
            checks += 1
            switch checks {
            case 1: return (200, #"{"status":"running","partial_text":"Hi! It’s"}"#)
            case 2: return (200, #"{"status":"running","partial_text":"Hi! It’s sunny."}"#)
            default: return (200, #"{"status":"finished","result":{"status":"done","text":"Hi! It’s sunny.","tainted":false,"drafts":[],"proposals":[]}}"#)
            }
        }
        let heard = HeardText()
        let client = APIClient(baseURL: URL(string: "https://api.test")!, tokenProvider: { "t" }, session: StubProtocol.session, sleep: { _ in })
        let run = try await client.runAssistant(request: "Weather?", mode: .talk, allowWebSearch: false, onText: { await heard.add($0) })
        #expect(run.text == "Hi! It\u{2019}s sunny.")
        #expect(await heard.all == ["Hi! It\u{2019}s", "Hi! It\u{2019}s sunny."])
        let body = try #require(StubProtocol.bodies.first.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
        #expect(body["stream"] as? Bool == true)
        // Counted in UTF-16, as the server counts: the curly apostrophe is one.
        #expect(StubProtocol.requests.dropFirst().map { $0.url?.query() } == ["wait=20&after=0", "wait=20&after=8", "wait=20&after=15"])
    }

    @Test func otherRequestsDontAskForTheAnswerAsItsWritten() async throws {
        StubProtocol.handler = { request in
            request.httpMethod == "POST" ? (200, #"{"run_id":"6f1c2d3e-0000-4000-8000-00000000000a"}"#)
                : (200, #"{"status":"finished","result":{"status":"done","text":"Done.","tainted":false,"drafts":[],"proposals":[]}}"#)
        }
        let client = APIClient(baseURL: URL(string: "https://api.test")!, tokenProvider: { "t" }, session: StubProtocol.session, sleep: { _ in })
        _ = try await client.runAssistant(request: "Posts", mode: .posts, allowWebSearch: false)
        let body = try #require(StubProtocol.bodies.first.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
        #expect(body["stream"] == nil)
    }

    /// Each check asks the server to hold on until the run is done, so a finished run is
    /// answered on the first check, with no waiting in between.
    @Test func aRunThatFinishesWhileWaitingIsAnsweredWithoutSleeping() async throws {
        StubProtocol.handler = { request in
            request.httpMethod == "POST" ? (200, #"{"run_id":"6f1c2d3e-0000-4000-8000-000000000004"}"#)
                : (200, #"{"status":"finished","result":{"status":"done","text":"Done.","tainted":false,"drafts":[],"proposals":[]}}"#)
        }
        let sleeps = SleepCounter()
        let client = APIClient(baseURL: URL(string: "https://api.test")!, tokenProvider: { "t" }, session: StubProtocol.session,
                               sleep: { _ in sleeps.count() })
        let run = try await client.runAssistant(request: "Posts for Saturday", mode: .posts, allowWebSearch: false)
        #expect(run.text == "Done.")
        #expect(sleeps.total == 0)
        #expect(StubProtocol.requests.count == 2)
        let check = try #require(StubProtocol.requests.last)
        #expect(check.url?.query() == "wait=20")
        #expect(check.timeoutInterval == 35)
    }

    @Test func aRunThatFailsOnTheServerSaysWhy() async throws {
        StubProtocol.handler = { request in
            request.httpMethod == "POST" ? (200, #"{"run_id":"6f1c2d3e-0000-4000-8000-000000000002"}"#)
                : (404, #"{"error":"Hera lost track of that request.","code":"run_lost"}"#)
        }
        let client = APIClient(baseURL: URL(string: "https://api.test")!, tokenProvider: { "t" }, session: StubProtocol.session, sleep: { _ in })
        do {
            _ = try await client.runAssistant(request: "Launch my workshop", mode: .launch, allowWebSearch: false)
            Issue.record("expected the run to fail")
        } catch let error as APIClient.APIError {
            #expect(error.code == "run_lost")
        }
    }

    @Test func purchasesAreSentToTheServerWithTheServersFieldName() async throws {
        StubProtocol.handler = { _ in
            (200, #"{"plan":"pro","used":3,"limit":300,"resetsAt":null,"enforced":true,"proExpiresAt":"2026-12-19T00:00:00Z"}"#)
        }
        let client = APIClient(baseURL: URL(string: "https://api.test")!, tokenProvider: { "t" }, session: StubProtocol.session, sleep: { _ in })
        let status = try await client.redeemPurchase(signedTransaction: "header.payload.signature")
        #expect(status.isPro)
        let request = try #require(StubProtocol.requests.last)
        #expect(request.url?.path() == "/billing/verify")
        let body = StubProtocol.bodies.last.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }
        #expect(body?["signed_transaction"] == "header.payload.signature")
    }

    @Test func aUsedUpMonthComesBackAsTheLimitCode() async throws {
        StubProtocol.handler = { _ in (402, #"{"error":"That's all 20 free requests for this month.","code":"limit_reached"}"#) }
        let client = APIClient(baseURL: URL(string: "https://api.test")!, tokenProvider: { "t" }, session: StubProtocol.session, sleep: { _ in })
        do {
            _ = try await client.runAssistant(request: "hi", mode: .posts, allowWebSearch: false)
            Issue.record("expected the limit")
        } catch let error as APIClient.APIError {
            #expect(error.code == "limit_reached")
        }
    }

    @Test func aRunCarriesTheDevicesClock() async throws {
        StubProtocol.handler = { request in
            request.httpMethod == "POST" ? (200, #"{"run_id":"6f1c2d3e-0000-4000-8000-000000000003"}"#)
                : (200, #"{"status":"finished","result":{"status":"done","text":"ok","tainted":false,"drafts":[],"proposals":[]}}"#)
        }
        let client = APIClient(baseURL: URL(string: "https://api.test")!, tokenProvider: { "t" }, session: StubProtocol.session, sleep: { _ in })
        _ = try await client.runAssistant(request: "Post every Monday", mode: .posts, allowWebSearch: false)
        let body = try #require(StubProtocol.bodies.first.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
        let clock = try #require(body["local_time"] as? [String: String])
        #expect(clock["time_zone"] == TimeZone.current.identifier)
        #expect(clock["now"].flatMap(HeraTime.parse) != nil)
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

/// Counts the injected sleeps.
private final class SleepCounter: @unchecked Sendable {
    private(set) var total = 0
    func count() { total += 1 }
}

/// Answers requests from a closure instead of the network.
private final class StubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (URLRequest) -> (Int, String) = { _ in (404, "{}") }
    nonisolated(unsafe) static var requests: [URLRequest] = []
    /// Each request's body. URLSession hands a protocol the body as a stream, not httpBody.
    nonisolated(unsafe) static var bodies: [Data] = []

    static var session: URLSession {
        requests = []
        bodies = []
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.requests.append(request)
        Self.bodies.append(Self.read(request))
        let (status, body) = Self.handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func read(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }
}

/// Collects what a streaming check passed on.
private actor HeardText {
    private(set) var all: [String] = []
    func add(_ text: String) { all.append(text) }
}
