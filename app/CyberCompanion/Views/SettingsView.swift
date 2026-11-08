import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var serverURL = ""
    @State private var accessToken = ""
    @State private var supabaseURL = ""
    @State private var supabaseAnonKey = ""
    @State private var status: String?
    @State private var showDelete = false

    var body: some View {
        NavigationStack {
            Form {
                account
                if model.isConfigured { aiSection }
                legal
                advanced
            }
            .formStyle(.grouped)
            .auroraBackground()
            .navigationTitle("Settings")
            .onAppear {
                serverURL = model.serverURLString
                accessToken = model.accessToken
                supabaseURL = UserDefaults.standard.string(forKey: "supabaseURL") ?? ""
                supabaseAnonKey = UserDefaults.standard.string(forKey: "supabaseAnonKey") ?? ""
            }
            .sheet(isPresented: $showDelete) { DeleteAccountSheet() }
        }
    }

    /* ---------------- account ---------------- */

    @ViewBuilder
    private var account: some View {
        if model.session.isSignedIn || !model.accessToken.isEmpty {
            Section {
                HStack(spacing: 12) {
                    IconTile(systemImage: "person.fill", size: 34)
                    VStack(alignment: .leading) {
                        Text(model.session.email ?? (model.session.isSignedIn ? "Signed in with Apple" : "Developer token"))
                        Text(model.session.isSignedIn ? "Signed in with Apple" : "Staging access")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                if model.session.isSignedIn {
                    Button("Sign out") { Task { await model.signOut() } }
                }
                Button("Delete account…", role: .destructive) { showDelete = true }
                    .disabled(!model.isConfigured)
            } header: {
                SectionLabel("Account")
            } footer: {
                Text("Deleting your account removes your websites, posts, connected accounts and sign-in from our servers. Anything already published stays where it was published.")
            }
        }
    }

    private var aiSection: some View {
        Section {
            Toggle("Use AI to create websites and posts", isOn: Binding(
                get: { model.aiConsent ?? false },
                set: { granted in Task { await model.setAIConsent(granted) } }
            ))
        } header: {
            SectionLabel("AI")
        } footer: {
            Text("Your requests are sent to your server, which asks Claude (Anthropic) to do the work. Voice is recognized on this device; only the finished text is sent. Turn this off at any time.")
        }
    }

    @ViewBuilder
    private var legal: some View {
        if let base = model.serverURL {
            Section {
                Link(destination: base.appending(path: "privacy")) { Label("Privacy Policy", systemImage: "hand.raised") }
                Link(destination: base.appending(path: "terms")) { Label("Terms of Use", systemImage: "doc.text") }
                Link(destination: base.appending(path: "support")) { Label("Support", systemImage: "questionmark.circle") }
            } header: {
                SectionLabel("About")
            }
        }
    }

    /* ---------------- advanced ---------------- */

    private var advanced: some View {
        Section {
            DisclosureGroup("Advanced") {
                if AppConfig.serverURL == nil {
                    TextField("Server address, e.g. api.example.com", text: $serverURL)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        #endif
                }
                if AppConfig.supabaseURL == nil {
                    TextField("Sign-in service (Supabase URL)", text: $supabaseURL)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                    TextField("Sign-in public key (anon key)", text: $supabaseAnonKey)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                }
                SecureField("Developer access token (staging)", text: $accessToken)
                    .textContentType(.password)
                Button("Save and connect") { Task { await save() } }
                    .buttonStyle(.glassProminent)
                if let status {
                    Text(status).font(.callout).foregroundStyle(.secondary)
                }
            }
        } footer: {
            Text("For development and testing. Release builds connect automatically. A developer token is the server's TEST_ACCESS_TOKEN and replaces signing in.")
        }
    }

    private func save() async {
        model.saveSettings(serverURL: serverURL, accessToken: accessToken)
        model.saveSignInService(url: supabaseURL, anonKey: supabaseAnonKey)
        guard model.serverURL != nil else {
            status = "That address isn't valid. Use an https address, or http://localhost for development."
            return
        }
        guard model.isConfigured else {
            status = model.session.isAvailable ? "Saved. Sign in with Apple to connect." : "Saved. Add a developer token, or the sign-in service, to connect."
            return
        }
        status = "Connecting…"
        await model.refreshAll()
        status = model.errorMessage.map { "Couldn't connect: \($0)" } ?? "Connected."
    }
}

/// Account deletion, as Apple requires (guideline 5.1.1(v)): reachable in the app, explicit,
/// and impossible to fire twice (Cognivate's TestFlight checklist).
private struct DeleteAccountSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var typed = ""
    @State private var isDeleting = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label("This can't be undone", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .font(.headline)
                    Text("Your websites, drafts, approvals, connected accounts and your sign-in account are permanently deleted from our servers. Sites and posts you already published stay where they were published; remove them there if you want them gone.")
                        .font(.callout)
                    TextField("Type DELETE to confirm", text: $typed)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.characters)
                        #endif
                }
                if let failure {
                    Section { Text(failure).foregroundStyle(.red) }
                }
                Section {
                    Button(role: .destructive) {
                        Task { await delete() }
                    } label: {
                        HStack {
                            Text("Permanently delete account")
                            if isDeleting { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(typed != "DELETE" || isDeleting)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Delete account")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(isDeleting) }
            }
            .interactiveDismissDisabled(isDeleting)
        }
        .frame(minWidth: 380, minHeight: 360)
    }

    private func delete() async {
        guard !isDeleting else { return }
        isDeleting = true
        defer { isDeleting = false }
        if await model.deleteAccount() {
            dismiss()
        } else {
            failure = model.errorMessage ?? "The account couldn't be deleted. Please try again."
        }
    }
}

#Preview {
    SettingsView()
        .environment(AppModel())
}
