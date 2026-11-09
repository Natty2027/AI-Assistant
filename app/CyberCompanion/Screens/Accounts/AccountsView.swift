import AuthenticationServices
import SwiftUI

/// Where Hera can publish for you. One row per service: connected, or a Connect button.
/// Netlify and Bluesky open a short guided sheet; X and Facebook & Instagram open the platform's
/// own sign-in page in a secure browser sheet, so the app never sees those passwords. Either way
/// the server stores what it needs encrypted; the app never keeps it.
struct AccountsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var connecting: Service?
    @State private var signingIn: SignInProvider?
    /// What the last sign-in came to: connected, or why not.
    @State private var outcome: SignInOutcome?
    @State private var pendingDisconnect: Connection?

    enum Service: String, Identifiable {
        case netlify, bluesky
        var id: Self { self }
    }

    struct SignInOutcome {
        let title: String
        let message: String
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    serviceRow(title: "Website hosting", subtitle: "Netlify publishes your website", systemImage: "globe",
                               connections: connections("netlify")) { connecting = .netlify }
                } header: {
                    SectionLabel("Your website")
                }

                Section {
                    serviceRow(title: "Instagram & Facebook", subtitle: "Your Facebook Page and its Instagram account",
                               systemImage: "camera", connections: connections("facebook", "instagram"),
                               available: model.signInAvailability.meta, busy: signingIn == .meta) { signIn(.meta) }
                    instagramBusinessNote
                    serviceRow(title: "X", subtitle: "Posts to your X account", systemImage: "xmark",
                               connections: connections("x"), available: model.signInAvailability.x, busy: signingIn == .x) { signIn(.x) }
                    serviceRow(title: "Bluesky", subtitle: "Posts to your Bluesky account", systemImage: "cloud.fill",
                               connections: connections("bluesky")) { connecting = .bluesky }
                } header: {
                    SectionLabel("Your posts")
                } footer: {
                    Text("Nothing is published until you approve it in Review. Disconnecting deletes the saved login; anything already published stays up.")
                }

                Section {
                    HStack(spacing: 12) {
                        IconTile(systemImage: Platform.linkedin.systemImage, size: 32)
                        Text(Platform.linkedin.displayName)
                        Spacer()
                        Label("You share", systemImage: "square.and.arrow.up")
                            .labelStyle(.titleAndIcon)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    SectionLabel("You post these yourself")
                } footer: {
                    Text("Hera writes posts for these too. Tap Share on a post to open the app with the text ready.")
                }
            }
            .formStyle(.grouped)
            .auroraBackground()
            .navigationTitle("Accounts")
            .task { await model.refreshConnections() }
            .sheet(item: $connecting) { service in
                switch service {
                case .netlify: ConnectNetlifySheet()
                case .bluesky: ConnectBlueskySheet()
                }
            }
            .alert(outcome?.title ?? "", isPresented: Binding(get: { outcome != nil }, set: { if !$0 { outcome = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(outcome?.message ?? "")
            }
            .confirmationDialog("Disconnect \(pendingDisconnect?.label ?? "this account")?",
                                isPresented: Binding(get: { pendingDisconnect != nil }, set: { if !$0 { pendingDisconnect = nil } }),
                                titleVisibility: .visible) {
                Button("Disconnect", role: .destructive) {
                    if let connection = pendingDisconnect {
                        Task { await model.disconnect(connection) }
                    }
                    pendingDisconnect = nil
                }
            } message: {
                Text("The saved login is deleted. Anything already published stays up.")
            }
        }
    }

    /// Instagram's own rule, explained before someone tries to connect a personal account.
    private var instagramBusinessNote: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Instagram needs a Business or Creator account", systemImage: "info.circle")
                .font(.footnote.weight(.semibold))
            Text("Instagram only lets apps post to Business or Creator accounts that are linked to a Facebook Page. Personal accounts can't be connected.")
            Text("Switching is free and takes a minute: in Instagram, go to Settings → Account type and tools → Switch to professional account. Then link it to your Facebook Page from Edit profile → Page. When you connect here, choose that Page.")
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
    }

    private func connections(_ providers: String...) -> [Connection] {
        model.connections.filter { providers.contains($0.provider) }
    }

    /// Opens the platform's sign-in page. The server finishes the sign-in and sends the sheet to
    /// hera://connected, which closes it and says whether it worked.
    private func signIn(_ provider: SignInProvider) {
        signingIn = provider
        Task {
            defer { signingIn = nil }
            guard let page = await model.signInPage(for: provider) else {
                outcome = SignInOutcome(title: "Couldn't start connecting", message: model.errorMessage ?? "Please try again.")
                return
            }
            let callback: URL
            do {
                callback = try await webAuthenticationSession.authenticate(using: page, callbackURLScheme: "hera")
            } catch {
                // Closing the sheet is a choice, not an error; nothing to show.
                return
            }
            if await model.finishSignIn(callback: callback) {
                outcome = SignInOutcome(title: provider == .x ? "X is connected" : "Facebook and Instagram are connected",
                                        message: "Hera can now write posts for it. You approve each one before it goes out.")
            } else {
                outcome = SignInOutcome(title: "Not connected", message: model.errorMessage ?? "Please try again.")
            }
        }
    }

    /// `available` is false when the server isn't set up for that sign-in yet.
    private func serviceRow(title: String, subtitle: String, systemImage: String, connections: [Connection],
                            available: Bool = true, busy: Bool = false, connect: @escaping () -> Void) -> some View {
        HStack(spacing: 12) {
            IconTile(systemImage: systemImage, size: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(connections.isEmpty ? (available ? subtitle : "Coming soon") : connections.map(\.label).joined(separator: ", "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer()
            if busy {
                ProgressView()
            } else if !connections.isEmpty {
                Menu {
                    if available {
                        Button("Connect again", systemImage: "arrow.clockwise", action: connect)
                    }
                    ForEach(connections) { connection in
                        Button("Disconnect \(connection.label)", systemImage: "xmark.circle", role: .destructive) { pendingDisconnect = connection }
                    }
                } label: {
                    Label("Connected", systemImage: "checkmark.circle.fill")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.green)
                }
            } else {
                Button("Connect", action: connect)
                    .buttonStyle(.glassProminent)
                    .controlSize(.small)
                    .disabled(!model.isConfigured || !available)
            }
        }
    }
}

#Preview {
    AccountsView()
        .environment(AppModel())
}
