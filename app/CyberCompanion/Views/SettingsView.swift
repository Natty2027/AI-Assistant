import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var serverURL = ""
    @State private var accessToken = ""
    @State private var status: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Server address, e.g. https://api.example.com", text: $serverURL)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        #endif
                    SecureField("Access token", text: $accessToken)
                        .textContentType(.password)
                    Button("Save and connect") {
                        Task { await save() }
                    }
                    .disabled(serverURL.isEmpty || accessToken.isEmpty)
                    if let status {
                        Text(status).font(.callout).foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Server")
                } footer: {
                    Text("The assistant runs on your Cyber Companion server. The token is kept in this device's Keychain. Addresses must use https (http is allowed only for localhost while developing).")
                }

                if model.isConfigured {
                    Section {
                        Toggle("Use AI to create websites and posts", isOn: Binding(
                            get: { model.aiConsent ?? false },
                            set: { granted in Task { await model.setAIConsent(granted) } }
                        ))
                    } header: {
                        Text("AI")
                    } footer: {
                        Text("Your requests are sent to your server, which asks Claude (Anthropic) to do the work. Voice is recognized on this device; only the finished text is sent. Turn this off at any time.")
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Settings")
            .onAppear {
                serverURL = model.serverURLString
                accessToken = model.accessToken
            }
        }
    }

    private func save() async {
        model.saveSettings(serverURL: serverURL, accessToken: accessToken)
        guard model.isConfigured else {
            status = "That address isn't valid. Use https://, or http://localhost for development."
            return
        }
        status = "Connecting…"
        await model.refreshAll()
        status = model.errorMessage.map { "Couldn't connect: \($0)" } ?? "Connected."
    }
}

#Preview {
    SettingsView()
        .environment(AppModel())
}
