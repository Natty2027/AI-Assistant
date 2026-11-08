import SwiftUI

/// The accounts the assistant may publish to. Credentials go straight to the server, which checks
/// them with the provider and stores them encrypted; the app never keeps them.
struct AccountsView: View {
    @Environment(AppModel.self) private var model
    @State private var netlifyToken = ""
    @State private var blueskyHandle = ""
    @State private var blueskyPassword = ""
    @State private var isWorking = false
    @State private var pendingDisconnect: Connection?

    var body: some View {
        NavigationStack {
            Form {
                if !model.connections.isEmpty {
                    Section {
                        ForEach(model.connections) { connection in
                            HStack(spacing: 12) {
                                IconTile(systemImage: connection.kind == "hosting" ? "globe" : "cloud.fill", size: 32)
                                Text(connection.label)
                                Spacer()
                                Button("Disconnect", role: .destructive) { pendingDisconnect = connection }
                                    .buttonStyle(.borderless)
                            }
                        }
                    } header: {
                        SectionLabel("Connected", color: .green)
                    }
                }

                Section {
                    SecureField("Personal access token", text: $netlifyToken)
                        .textContentType(.password)
                        .autocorrectionDisabled()
                    Button("Connect Netlify") {
                        Task {
                            isWorking = true
                            if await model.connectNetlify(token: netlifyToken) { netlifyToken = "" }
                            isWorking = false
                        }
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(netlifyToken.isEmpty || isWorking || !model.isConfigured)
                } header: {
                    SectionLabel("Website hosting · Netlify")
                } footer: {
                    Text("Your website is published to your own Netlify account. Create a token in Netlify under User settings → Applications → Personal access tokens.")
                }

                Section {
                    TextField("Handle, e.g. yourname.bsky.social", text: $blueskyHandle)
                        .textContentType(.username)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                    SecureField("App password (xxxx-xxxx-xxxx-xxxx)", text: $blueskyPassword)
                        .textContentType(.password)
                        .autocorrectionDisabled()
                    Button("Connect Bluesky") {
                        Task {
                            isWorking = true
                            if await model.connectBluesky(handle: blueskyHandle, appPassword: blueskyPassword) {
                                blueskyHandle = ""
                                blueskyPassword = ""
                            }
                            isWorking = false
                        }
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(blueskyHandle.isEmpty || blueskyPassword.isEmpty || isWorking || !model.isConfigured)
                } header: {
                    SectionLabel("Social · Bluesky")
                } footer: {
                    Text("Approved posts are published to your account. Use an app password, never your main password: create one in Bluesky under Settings → Privacy and security → App passwords. You can revoke it there at any time.")
                }

                Section {
                    ForEach([Platform.instagram, .x, .linkedin, .facebook]) { platform in
                        HStack(spacing: 12) {
                            IconTile(systemImage: platform.systemImage, size: 32)
                            Text(platform.displayName)
                            Spacer()
                            Text("Share")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                    }
                } header: {
                    SectionLabel("Other platforms")
                } footer: {
                    Text("The assistant writes posts for these too. You post them yourself with the Share button, which opens the platform's app with the text ready. Direct publishing needs each platform's approval of this app and will come later.")
                }

                if let message = model.errorMessage {
                    Section { Text(message).foregroundStyle(.red) }
                }
            }
            .formStyle(.grouped)
            .auroraBackground()
            .navigationTitle("Accounts")
            .overlay { if isWorking { ProgressView() } }
            .task { await model.refreshConnections() }
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
                Text("The saved credential is deleted from the server. Anything already published stays up.")
            }
        }
    }
}

#Preview {
    AccountsView()
        .environment(AppModel())
}
