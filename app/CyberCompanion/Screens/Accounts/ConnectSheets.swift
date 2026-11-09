import SwiftUI

/// Connect Netlify: create a personal access token there, paste it here.
struct ConnectNetlifySheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var token = ""
    @State private var isWorking = false

    var body: some View {
        ConnectSheet(
            title: "Connect Netlify",
            intro: "Your website is published to your own Netlify account. It takes about a minute.",
            steps: [
                "Open Netlify and sign in (or create a free account).",
                "Create a new personal access token. Any name works, for example \"Hera\".",
                "Copy the token and paste it below.",
            ],
            link: ("Open Netlify tokens", URL(string: "https://app.netlify.com/user/applications#personal-access-tokens")!),
            isWorking: isWorking,
            canConnect: !token.trimmingCharacters(in: .whitespaces).isEmpty,
            connect: connect
        ) {
            SecureField("Personal access token", text: $token)
                .textContentType(.password)
                .autocorrectionDisabled()
        }
    }

    private func connect() {
        Task {
            isWorking = true
            let ok = await model.connectNetlify(token: token)
            isWorking = false
            if ok { dismiss() }
        }
    }
}

/// Connect Bluesky with an app password, never the main password.
struct ConnectBlueskySheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var handle = ""
    @State private var appPassword = ""
    @State private var isWorking = false

    var body: some View {
        ConnectSheet(
            title: "Connect Bluesky",
            intro: "Posts you approve are published to your Bluesky account. Use an app password, never your main password; you can revoke it in Bluesky at any time.",
            steps: [
                "Open Bluesky's app password settings and sign in.",
                "Add an app password. Any name works, for example \"Hera\".",
                "Enter your handle and the app password below.",
            ],
            link: ("Open Bluesky app passwords", URL(string: "https://bsky.app/settings/app-passwords")!),
            isWorking: isWorking,
            canConnect: !handle.isEmpty && !appPassword.isEmpty,
            connect: connect
        ) {
            TextField("Handle, e.g. yourname.bsky.social", text: $handle)
                .textContentType(.username)
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
            SecureField("App password (xxxx-xxxx-xxxx-xxxx)", text: $appPassword)
                .textContentType(.password)
                .autocorrectionDisabled()
        }
    }

    private func connect() {
        Task {
            isWorking = true
            let ok = await model.connectBluesky(handle: handle, appPassword: appPassword)
            isWorking = false
            if ok { dismiss() }
        }
    }
}

/// The shared layout: what this is for, numbered steps, a link to the right page, the fields,
/// and one Connect button. Errors from the server appear in the sheet, next to the fields.
private struct ConnectSheet<Fields: View>: View {
    let title: String
    let intro: String
    let steps: [String]
    let link: (String, URL)
    let isWorking: Bool
    let canConnect: Bool
    let connect: () -> Void
    @ViewBuilder var fields: Fields

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                        Label {
                            Text(step)
                        } icon: {
                            Text("\(index + 1)")
                                .font(.footnote.weight(.bold))
                                .frame(width: 22, height: 22)
                                .background(Theme.spectrumGradient, in: .circle)
                                .foregroundStyle(.white)
                        }
                    }
                    Link(destination: link.1) { Label(link.0, systemImage: "arrow.up.right.square") }
                } header: {
                    Text(intro).textCase(nil).font(.callout).foregroundStyle(.secondary)
                }

                Section {
                    fields
                } footer: {
                    if let message = model.errorMessage {
                        Text(message).foregroundStyle(.red)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isWorking {
                        ProgressView()
                    } else {
                        Button("Connect", action: connect)
                            .disabled(!canConnect || !model.isConfigured)
                    }
                }
            }
            // A message left over from another screen doesn't belong here.
            .onAppear { model.errorMessage = nil }
        }
        .presentationDetents([.large])
    }
}

#Preview {
    ConnectBlueskySheet()
        .environment(AppModel())
}
