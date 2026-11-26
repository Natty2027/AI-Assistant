import PhotosUI
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var serverURL = ""
    @State private var accessToken = ""
    @State private var supabaseURL = ""
    @State private var supabaseAnonKey = ""
    @State private var status: String?
    @State private var showDelete = false
    @State private var newMemory = ""
    @State private var logoItem: PhotosPickerItem?
    @State private var memoryNote: String?
    @AppStorage(HeraVoice.speakRepliesKey) private var speakReplies = true
    @AppStorage(EventReminders.enabledKey) private var eventReminders = true
    @AppStorage(EventReminders.leadKey) private var reminderLead = 15
    @AppStorage(EventReminders.spokenKey) private var spokenReminders = true

    var body: some View {
        NavigationStack {
            Form {
                account
                if model.isConfigured { planSection }
                if model.isConfigured { aiSection }
                brandSection
                if model.isConfigured { memorySection }
                remindersSection
                if HeraVoice.isAvailable { voiceSection }
                onDeviceSection
                legal
                // Server addresses and the staging token are for development only. Release builds
                // (TestFlight, App Store) connect through AppConfig and sign in with Apple.
                #if DEBUG
                advanced
                #endif
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
                Text("Deleting your account removes your posts, drafts, connected accounts and sign-in from our servers. Anything already published stays where it was published.")
            }
        }
    }

    private var aiSection: some View {
        Section {
            Toggle("Use AI to create posters and posts", isOn: Binding(
                get: { model.aiConsent ?? false },
                set: { granted in Task { await model.setAIConsent(granted) } }
            ))
        } header: {
            SectionLabel("AI")
        } footer: {
            Text("What you ask Hera is sent to Claude, by Anthropic, to make your posters and posts. When you use Schedule, your upcoming events and open reminders are sent with that request. Your voice is recognized on this device; only the finished text is sent. You can turn this off at any time.")
        }
    }

    /// The business's name, colors and logo, used on every poster. Kept on this device.
    private var brandSection: some View {
        let brand = model.brand
        return Section {
            TextField("Business name", text: Binding(
                get: { brand.kit.businessName },
                set: { name in brand.update { $0.businessName = String(name.prefix(60)) } }))
            ColorPicker("Main color", selection: Binding(
                get: { brand.kit.primary },
                set: { color in brand.update { $0.primaryHex = color.hexString() } }), supportsOpacity: false)
            ColorPicker("Accent color", selection: Binding(
                get: { brand.kit.accent },
                set: { color in brand.update { $0.accentHex = color.hexString() } }), supportsOpacity: false)
            HStack(spacing: 12) {
                if let data = brand.kit.logo, let image = PosterView.image(from: data) {
                    Image(decorative: image, scale: 1).resizable().scaledToFit().frame(width: 44, height: 44)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                PhotosPicker(brand.kit.logo == nil ? "Add your logo" : "Change logo", selection: $logoItem, matching: .images)
                Spacer()
                if brand.kit.logo != nil {
                    Button("Remove", role: .destructive) { brand.removeLogo() }
                        .buttonStyle(.borderless)
                }
            }
            .onChange(of: logoItem) { _, item in
                guard let item else { return }
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self) { brand.setLogo(from: data) }
                    logoItem = nil
                }
            }
        } header: {
            SectionLabel("Brand kit")
        } footer: {
            Text("Used on every poster and flyer Hera makes. Kept on this device.")
        }
    }

    /// Lasting facts Hera saved (or the person added), used in every task. Deleting one means Hera
    /// no longer knows it.
    private var memorySection: some View {
        Section {
            if model.memories.isEmpty {
                Text("Nothing yet. Tell Hera about your business, such as its name, hours or the tone you like, and she'll remember it.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            ForEach(model.memories) { memory in
                HStack(alignment: .firstTextBaseline) {
                    Text(memory.text)
                    Spacer()
                    Button("Forget", systemImage: "trash") { Task { await model.forget(memory) } }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.borderless)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Forget “\(memory.text)”")
                }
            }
            HStack {
                TextField("Add something for Hera to remember", text: $newMemory)
                    .onSubmit(addMemory)
                Button("Add", action: addMemory)
                    .disabled(newMemory.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if let memoryNote {
                Text(memoryNote).font(.caption).foregroundStyle(.secondary)
            }
        } header: {
            SectionLabel("What Hera remembers")
        } footer: {
            Text("Hera uses these in every poster, post and schedule task so you don't have to repeat yourself. They're sent to Claude with your requests. Delete anything you'd rather she forgot.")
        }
        .task { await model.refreshMemories() }
    }

    private func addMemory() {
        let text = newMemory
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        newMemory = ""
        Task { memoryNote = await model.addMemory(text) }
    }

    private var remindersSection: some View {
        Section {
            Toggle("Remind me before events", isOn: $eventReminders)
            if eventReminders {
                Picker("How early", selection: $reminderLead) {
                    ForEach(EventReminders.leadChoices, id: \.self) { minutes in
                        Text("\(EventReminderPlanner.leadPhrase(minutes)) before").tag(minutes)
                    }
                }
                if HeraVoice.isAvailable {
                    Toggle("Hera says the reminder out loud", isOn: $spokenReminders)
                }
                switch model.reminders.status {
                case .noCalendar:
                    Button("Let Hera see your calendar", systemImage: "calendar") {
                        Task { await model.allowRemindersCalendar() }
                    }
                case .notificationsDenied:
                    Label("Notifications are off for Hera. Turn them on in Settings → Apps → Hera → Notifications.",
                          systemImage: "bell.slash")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                default:
                    EmptyView()
                }
            }
        } header: {
            SectionLabel("Event reminders")
        } footer: {
            Text("Before each event on your calendar, Hera sends an alert and says what it is and when it starts. Her voice is recorded on this device ahead of time, so you hear it even when Hera is closed, unless your phone is on silent.")
        }
        .onChange(of: eventReminders) { Task { await model.refreshReminders() } }
        .onChange(of: reminderLead) { Task { await model.refreshReminders() } }
        .onChange(of: spokenReminders) { Task { await model.refreshReminders() } }
    }

    /// Hera Pro: this month's requests, and upgrading or managing the subscription.
    private var planSection: some View {
        Section {
            HStack(spacing: 12) {
                IconTile(systemImage: model.pro.status?.isPro == true ? "sparkles" : "person.fill", size: 34)
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.pro.status?.isPro == true ? "Hera Pro" : "Free")
                    if let status = model.pro.status {
                        Text(status.usageLine).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if model.pro.status?.isPro == true {
                    Link("Manage", destination: URL(string: "https://apps.apple.com/account/subscriptions")!)
                        .buttonStyle(.glass)
                        .controlSize(.small)
                } else {
                    Button("Upgrade") { model.pro.showPlans = true }
                        .buttonStyle(.glassProminent)
                        .controlSize(.small)
                }
            }
            if let status = model.pro.status {
                ProgressView(value: Double(min(status.used, status.limit)), total: Double(max(status.limit, 1)))
                    .tint(status.remaining == 0 && status.enforced ? .orange : Theme.spectrum[1])
                    .accessibilityLabel(status.usageLine)
            }
        } header: {
            SectionLabel("Plan")
        } footer: {
            Text(model.pro.status?.resetsLine.map { "\($0). Each request to Hera counts as one: a set of posts, a launch, a listing, a reply." }
                 ?? "Each request to Hera counts as one: a set of posts, a launch, a listing, a reply.")
        }
        .task { await model.pro.refresh(client: model.client) }
    }

    private var voiceSection: some View {
        Section {
            Toggle("Hera speaks her replies", isOn: $speakReplies)
                .onChange(of: speakReplies) { _, on in if !on { model.speech.stop() } }
        } header: {
            SectionLabel("Voice")
        } footer: {
            Text("Hera reads her replies aloud. Her voice is made on this device, so nothing is sent anywhere to speak.")
        }
    }

    /// Rewrites, hashtags and quick replies made with Apple Intelligence on this device.
    private var onDeviceSection: some View {
        Section {
            if let reason = model.onDevice.unavailableReason {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Not available")
                        Text(reason).font(.footnote).foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: "exclamationmark.circle")
                }
                .labelStyle(.alignedIcon)
            } else {
                Label("Ready on this \(ThisDevice.name)", systemImage: "checkmark.circle.fill")
                    .labelStyle(.alignedIcon)
            }
        } header: {
            SectionLabel("On-device")
        } footer: {
            Text("Rewrites and quick replies run on this \(ThisDevice.name) with Apple Intelligence: instant, private, and free. They don't use your monthly requests.")
        }
    }

    @ViewBuilder
    private var legal: some View {
        if let base = model.serverURL {
            Section {
                Link(destination: base.appending(path: "privacy")) { Label("Privacy Policy", systemImage: "hand.raised").labelStyle(.alignedIcon) }
                Link(destination: base.appending(path: "terms")) { Label("Terms of Use", systemImage: "doc.text").labelStyle(.alignedIcon) }
                Link(destination: base.appending(path: "support")) { Label("Support", systemImage: "questionmark.circle").labelStyle(.alignedIcon) }
            } header: {
                SectionLabel("About")
            } footer: {
                // Required by the Apache License 2.0 that Hera's voice is used under.
                Text("Hera's voice: Kokoro-82M \"af_heart\" by hexgrad, with Core ML by kokoro-coreml, both under the Apache License 2.0.")
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
                    Text("Your posts, drafts, approvals, connected accounts and your sign-in account are permanently deleted from our servers. Posts and listings you already published stay where they were published; remove them there if you want them gone.")
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
