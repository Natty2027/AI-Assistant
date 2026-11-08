import AuthenticationServices
import CryptoKit
import Foundation
import Observation

/// The signed-in person. Sign in with Apple gives an identity token, which Supabase exchanges for
/// a session (an access token the server verifies, and a refresh token). Both tokens live in the
/// Keychain; the access token is refreshed shortly before it expires.
@MainActor
@Observable
final class Session {
    struct Stored: Codable, Sendable {
        var accessToken: String
        var refreshToken: String
        var expiresAt: Date
        var userID: String
        var email: String?
    }

    enum AuthError: LocalizedError {
        case notConfigured, appleTokenMissing, rejected(String), sessionEnded

        var errorDescription: String? {
            switch self {
            case .notConfigured: "Sign-in isn't set up in this build yet."
            case .appleTokenMissing: "Apple didn't return a sign-in token. Please try again."
            case .rejected(let message): message
            case .sessionEnded: "You've been signed out. Please sign in again."
            }
        }
    }

    private static let keychainAccount = "session"

    private(set) var stored: Stored?
    private var refreshTask: Task<Stored, Error>?

    var isSignedIn: Bool { stored != nil }
    var email: String? { stored?.email }

    /// Supabase address and public key: the release values in AppConfig, else the ones entered
    /// under Settings → Advanced for development.
    var supabaseURL: URL? {
        AppConfig.supabaseURL ?? UserDefaults.standard.string(forKey: "supabaseURL").flatMap(ServerAddress.normalize)
    }
    var anonKey: String? {
        AppConfig.supabaseAnonKey ?? UserDefaults.standard.string(forKey: "supabaseAnonKey").flatMap { $0.isEmpty ? nil : $0 }
    }
    var isAvailable: Bool { supabaseURL != nil && anonKey != nil }

    init() {
        if let data = Keychain.read(Self.keychainAccount)?.data(using: .utf8) {
            stored = try? JSONDecoder().decode(Stored.self, from: data)
        }
    }

    /* ---------------- Sign in with Apple ---------------- */

    /// A fresh random nonce for each attempt. Apple receives its SHA-256; Supabase receives the
    /// original, and checks they match, so a stolen identity token can't be replayed.
    private(set) var currentNonce = Session.randomNonce()

    func prepare(_ request: ASAuthorizationAppleIDRequest) {
        currentNonce = Self.randomNonce()
        request.requestedScopes = [.email]
        request.nonce = Self.sha256(currentNonce)
    }

    /// Finishes the Apple flow. Cancelling returns quietly; every other outcome either signs in
    /// or throws a message to show. Apple's sheet must never complete into nothing, which is the
    /// failure App Review flagged for Cognivate.
    func complete(_ result: Result<ASAuthorization, any Error>) async throws {
        let authorization: ASAuthorization
        switch result {
        case .success(let value):
            authorization = value
        case .failure(let error):
            if let auth = error as? ASAuthorizationError, auth.code == .canceled { return }
            throw AuthError.rejected("Sign in with Apple didn't finish: \(error.localizedDescription)")
        }
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken, let idToken = String(data: tokenData, encoding: .utf8) else {
            throw AuthError.appleTokenMissing
        }
        let session = try await exchange(grant: "id_token", body: ["provider": "apple", "id_token": idToken, "nonce": currentNonce])
        save(session)
    }

    /* ---------------- tokens ---------------- */

    /// A token that's valid for at least another minute, refreshing first if needed. Concurrent
    /// callers share one refresh.
    func validAccessToken() async throws -> String? {
        guard let current = stored else { return nil }
        if current.expiresAt.timeIntervalSinceNow > 60 { return current.accessToken }
        return try await refresh().accessToken
    }

    /// Forces a refresh, e.g. after the server answered 401. Ends the session if Supabase no
    /// longer accepts the refresh token.
    @discardableResult
    func refresh() async throws -> Stored {
        if let refreshTask { return try await refreshTask.value }
        guard let current = stored else { throw AuthError.sessionEnded }
        let task = Task { () throws -> Stored in
            try await self.exchange(grant: "refresh_token", body: ["refresh_token": current.refreshToken])
        }
        refreshTask = task
        defer { refreshTask = nil }
        do {
            let renewed = try await task.value
            save(renewed)
            return renewed
        } catch let error as AuthError {
            if case .rejected = error {
                clear()
                throw AuthError.sessionEnded
            }
            throw error
        }
    }

    func signOut() async {
        if let url = supabaseURL?.appending(path: "auth/v1/logout"), let anonKey, let token = stored?.accessToken {
            var request = URLRequest(url: url, timeoutInterval: 10)
            request.httpMethod = "POST"
            request.setValue(anonKey, forHTTPHeaderField: "apikey")
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            _ = try? await SecureSession.shared.data(for: request) // best effort: local sign-out happens regardless
        }
        clear()
    }

    /// Forgets the session locally, e.g. after the account was deleted.
    func clear() {
        stored = nil
        Keychain.write("", for: Self.keychainAccount)
    }

    /* ---------------- Supabase ---------------- */

    private struct TokenResponse: Decodable {
        struct User: Decodable { let id: String; let email: String? }
        let access_token: String
        let refresh_token: String
        let expires_in: Double
        let user: User
    }

    private struct ErrorResponse: Decodable {
        let error_description: String?
        let msg: String?
        let message: String?
    }

    private func exchange(grant: String, body: [String: String]) async throws -> Stored {
        guard let base = supabaseURL, let anonKey else { throw AuthError.notConfigured }
        var url = base.appending(path: "auth/v1/token")
        url.append(queryItems: [URLQueryItem(name: "grant_type", value: grant)])
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.httpMethod = "POST"
        request.setValue(anonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await SecureSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw AuthError.rejected("The sign-in service sent an unreadable reply.") }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode >= 500 { throw URLError(.badServerResponse) }
            let detail = (try? JSONDecoder().decode(ErrorResponse.self, from: data)).flatMap { $0.error_description ?? $0.msg ?? $0.message }
            throw AuthError.rejected(detail ?? "The sign-in service refused this sign-in.")
        }
        let token = try JSONDecoder().decode(TokenResponse.self, from: data)
        return Stored(accessToken: token.access_token, refreshToken: token.refresh_token,
                      expiresAt: Date().addingTimeInterval(token.expires_in), userID: token.user.id, email: token.user.email)
    }

    private func save(_ session: Stored) {
        stored = session
        if let data = try? JSONEncoder().encode(session), let text = String(data: data, encoding: .utf8) {
            Keychain.write(text, for: Self.keychainAccount)
        }
    }

    /* ---------------- nonce ---------------- */

    nonisolated static func randomNonce(length: Int = 32) -> String {
        let charset = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        var generator = SystemRandomNumberGenerator()
        return String((0..<length).map { _ in charset[Int.random(in: 0..<charset.count, using: &generator)] })
    }

    nonisolated static func sha256(_ input: String) -> String {
        SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
