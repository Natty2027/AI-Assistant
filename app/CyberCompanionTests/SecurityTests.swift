import Foundation
import Security
import Testing
@testable import CyberCompanion

/// Client-side protections: where the Bearer token may travel, what the session keeps on disk,
/// and that stored tokens stay on this device.
struct SecurityTests {
    @Test func redirectsStayOnTheSameHostOverHTTPS() {
        let origin = URL(string: "https://api.example.com/agent/run")
        #expect(RedirectGuard.allows(from: origin, to: URL(string: "https://api.example.com/v2/agent/run")))
        #expect(!RedirectGuard.allows(from: origin, to: URL(string: "https://evil.example.net/steal")), "another host never receives the token")
        #expect(!RedirectGuard.allows(from: origin, to: URL(string: "http://api.example.com/agent/run")), "no downgrade to plain http")
        #expect(!RedirectGuard.allows(from: origin, to: nil))
    }

    @Test func sessionKeepsNoCacheOrCookies() {
        let configuration = SecureSession.shared.configuration
        #expect(configuration.urlCache == nil)
        #expect(configuration.httpCookieStorage == nil)
        #expect(configuration.httpShouldSetCookies == false)
        #expect(configuration.tlsMinimumSupportedProtocolVersion == .TLSv12)
    }

    @Test func lookalikeAddressesAreRejected() {
        #expect(ServerAddress.normalize("ftp://api.example.com") == nil)
        #expect(ServerAddress.normalize("https://") == nil)
        #expect(ServerAddress.normalize("http://localhost.evil.com") == nil)
    }

    @Test func keychainRoundTripsAndClears() {
        let account = "test-\(UUID().uuidString)"
        Keychain.write("secret", for: account)
        #expect(Keychain.read(account) == "secret")
        Keychain.write("", for: account)
        #expect(Keychain.read(account) == nil)
    }
}
