import SwiftUI

/// Type or speak a request: "make a website for my pottery class and write posts announcing it".
struct AssistantView: View {
    var openSettings: () -> Void
    var openReview: () -> Void

    @Environment(AppModel.self) private var model
    @State private var prompt = ""
    @State private var allowWebSearch = false
    @State private var voice = VoiceInput()
    /// What was typed before the mic started, so dictation is added to it rather than replacing it.
    @State private var promptBeforeVoice = ""
    @FocusState private var promptFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if !model.isConfigured {
                        setupNotice
                    } else if model.aiConsent == false {
                        consentNotice
                    }
                    promptCard
                    if let message = model.errorMessage {
                        Label(message, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                            .font(.callout)
                    }
                    if let run = model.lastRun {
                        RunResultView(run: run, openReview: openReview)
                    }
                }
                .padding()
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .navigationTitle("Create")
            .onChange(of: voice.transcript) { _, spoken in
                prompt = [promptBeforeVoice, spoken].filter { !$0.isEmpty }.joined(separator: " ")
            }
        }
    }

    /* ---------------- the prompt ---------------- */

    private var promptCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("What would you like to make?")
                .font(.headline)
            TextEditor(text: $prompt)
                .focused($promptFocused)
                .frame(minHeight: 120)
                .scrollContentBackground(.hidden)
                .padding(8)
                .background(.background.secondary, in: .rect(cornerRadius: 10))
                .overlay(alignment: .topLeading) {
                    if prompt.isEmpty && !promptFocused {
                        Text("e.g. Make a one-page website for my Saturday pottery class and write an Instagram caption and a Bluesky post announcing it.")
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 13)
                            .padding(.vertical, 16)
                            .allowsHitTesting(false)
                    }
                }
                .disabled(voice.isListening)

            voiceStatus

            Toggle("Allow web search", isOn: $allowWebSearch)
                .help("Lets the assistant look things up. Anything it reads from the web is flagged before you approve.")
                #if os(macOS)
                .toggleStyle(.checkbox)
                #endif

            HStack(spacing: 12) {
                micButton
                Spacer()
                Button {
                    Task { await send() }
                } label: {
                    if model.isRunning {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Send", systemImage: "paperplane.fill")
                    }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!canSend)
            }
        }
    }

    private var micButton: some View {
        Button {
            Task {
                if !voice.isListening { promptBeforeVoice = prompt.trimmingCharacters(in: .whitespacesAndNewlines) }
                promptFocused = false
                await voice.toggle()
            }
        } label: {
            Label(voice.isListening ? "Stop" : "Speak", systemImage: voice.isListening ? "stop.circle.fill" : "mic.fill")
                .symbolEffect(.pulse, isActive: voice.isListening)
        }
        .buttonStyle(.bordered)
        .tint(voice.isListening ? .red : .accentColor)
        .disabled(model.isRunning || isPreparingVoice)
        .accessibilityHint("Speaks your request using on-device recognition")
    }

    @ViewBuilder
    private var voiceStatus: some View {
        switch voice.state {
        case .idle:
            EmptyView()
        case .listening:
            Label("Listening… recognized on this device", systemImage: "waveform")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .preparing(let message):
            Label(message, systemImage: "arrow.down.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .unavailable(let message):
            Label(message, systemImage: "mic.slash")
                .font(.caption)
                .foregroundStyle(.orange)
        }
    }

    private var isPreparingVoice: Bool {
        if case .preparing = voice.state { return true }
        return false
    }

    private var canSend: Bool {
        model.isConfigured && !model.isRunning && !voice.isListening
            && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() async {
        promptFocused = false
        await model.runAssistant(prompt: prompt, allowWebSearch: allowWebSearch)
    }

    /* ---------------- notices ---------------- */

    private var setupNotice: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Connect to your server first", systemImage: "server.rack")
                .font(.headline)
            Text("Add your server address and access token in Settings. The assistant runs there, so your AI key and account tokens never live on this device.")
                .font(.callout)
                .foregroundStyle(.secondary)
            Button("Open Settings", action: openSettings)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.yellow.opacity(0.15), in: .rect(cornerRadius: 12))
    }

    private var consentNotice: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("The assistant needs your OK to use AI", systemImage: "hand.raised")
                .font(.headline)
            Text("What you type or say is sent to your server, which asks Claude (Anthropic) to write the site and posts. Nothing is published until you approve it.")
                .font(.callout)
                .foregroundStyle(.secondary)
            Button("Allow AI") { Task { await model.setAIConsent(true) } }
                .buttonStyle(.borderedProminent)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.blue.opacity(0.1), in: .rect(cornerRadius: 12))
    }
}

/// What the assistant said, the posts it wrote, and what's waiting for approval.
private struct RunResultView: View {
    let run: AgentRunResponse
    var openReview: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if !run.text.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Label(run.needsAnswer ? "The assistant has a question" : "Assistant", systemImage: run.needsAnswer ? "questionmark.bubble" : "sparkles")
                        .font(.headline)
                    Text(run.text)
                        .textSelection(.enabled)
                    if run.needsAnswer {
                        Text("Answer in the box above and send again.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if run.tainted {
                Label("This used content from the web. Check everything carefully before approving.", systemImage: "exclamationmark.shield")
                    .font(.callout)
                    .foregroundStyle(.orange)
            }

            let sharable = run.drafts.filter(\.isForSharing)
            if !sharable.isEmpty {
                Text("Posts to share")
                    .font(.title3.bold())
                ForEach(sharable) { DraftCard(draft: $0) }
            }

            let waiting = run.proposals.filter(\.isPending)
            if !waiting.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Waiting for your approval")
                        .font(.title3.bold())
                    ForEach(waiting) { p in
                        Label(p.summary, systemImage: p.isSite ? "globe" : "text.bubble")
                    }
                    Button("Review and publish", systemImage: "checkmark.seal", action: openReview)
                        .buttonStyle(.borderedProminent)
                }
            }

            let blocked = run.proposals.filter { $0.status == "blocked" }
            if !blocked.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Couldn't be proposed")
                        .font(.title3.bold())
                    ForEach(blocked) { p in
                        VStack(alignment: .leading) {
                            Text(p.summary).font(.headline)
                            CheckList(checks: p.checks)
                        }
                    }
                }
            }
        }
    }
}

#Preview {
    AssistantView(openSettings: {}, openReview: {})
        .environment(AppModel())
}
