import AuthenticationServices
import SwiftUI

/// The first screen for someone who isn't signed in.
struct SignInView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @State private var isWorking = false
    @State private var message: String?

    var body: some View {
        VStack(spacing: 28) {
            Spacer()
            IconTile(systemImage: "sparkles", size: 84)
            VStack(spacing: 10) {
                Text("Hera")
                    .font(Theme.heading())
                    .foregroundStyle(Theme.spectrumGradient)
                Text("Speak an idea. Get a website and posts for it.\nNothing is published until you approve it.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            Spacer()

            VStack(spacing: 14) {
                SignInWithAppleButton(.signIn) { request in
                    model.session.prepare(request)
                } onCompletion: { result in
                    Task { await finish(result) }
                }
                .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
                .frame(height: 52)
                .clipShape(.capsule)
                .disabled(isWorking)
                .overlay { if isWorking { ProgressView() } }

                if let message {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .multilineTextAlignment(.center)
                }

                legalLinks
            }
            .frame(maxWidth: 380)
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .auroraBackground()
    }

    private var legalLinks: some View {
        HStack(spacing: 16) {
            if let base = model.serverURL {
                Link("Privacy", destination: base.appending(path: "privacy"))
                Link("Terms", destination: base.appending(path: "terms"))
                Link("Support", destination: base.appending(path: "support"))
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
    }

    private func finish(_ result: Result<ASAuthorization, any Error>) async {
        isWorking = true
        defer { isWorking = false }
        do {
            try await model.session.complete(result)
            message = nil
            if model.session.isSignedIn { await model.refreshAll() }
        } catch {
            // Every failure is said out loud: a sign-in sheet that completes into nothing is the
            // problem Apple's reviewers flagged for Cognivate.
            message = RetryPolicy.message(for: error)
        }
    }
}

#Preview {
    SignInView()
        .environment(AppModel())
}
