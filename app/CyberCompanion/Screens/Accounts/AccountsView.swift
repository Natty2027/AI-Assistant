import SwiftUI

/// Where Hera can publish for you. One row per service: connected, or a Connect button that opens
/// a short guided sheet. Credentials go straight to the server, which checks them with the
/// service and stores them encrypted; the app never keeps them.
struct AccountsView: View {
    @Environment(AppModel.self) private var model
    @State private var connecting: Service?
    @State private var pendingDisconnect: Connection?

    enum Service: String, Identifiable {
        case netlify, bluesky
        var id: Self { self }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    serviceRow(.netlify, title: "Website hosting", subtitle: "Netlify publishes your website", systemImage: "globe")
                    serviceRow(.bluesky, title: "Bluesky", subtitle: "Publishes the posts you approve", systemImage: "cloud.fill")
                } header: {
                    SectionLabel("Hera can publish to")
                } footer: {
                    Text("Nothing is published until you approve it in Review. Disconnecting deletes the saved login; anything already published stays up.")
                }

                Section {
                    ForEach([Platform.instagram, .x, .linkedin, .facebook]) { platform in
                        HStack(spacing: 12) {
                            IconTile(systemImage: platform.systemImage, size: 32)
                            Text(platform.displayName)
                            Spacer()
                            Label("You share", systemImage: "square.and.arrow.up")
                                .labelStyle(.titleAndIcon)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
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

    private func serviceRow(_ service: Service, title: String, subtitle: String, systemImage: String) -> some View {
        let connection = model.connections.first { $0.provider == service.rawValue }
        return HStack(spacing: 12) {
            IconTile(systemImage: systemImage, size: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(connection?.label ?? subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if let connection {
                Menu {
                    Button("Disconnect", systemImage: "xmark.circle", role: .destructive) { pendingDisconnect = connection }
                } label: {
                    Label("Connected", systemImage: "checkmark.circle.fill")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.green)
                }
            } else {
                Button("Connect") { connecting = service }
                    .buttonStyle(.glassProminent)
                    .controlSize(.small)
                    .disabled(!model.isConfigured)
            }
        }
    }
}

#Preview {
    AccountsView()
        .environment(AppModel())
}
