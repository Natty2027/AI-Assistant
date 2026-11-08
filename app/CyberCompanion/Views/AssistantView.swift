import SwiftUI

/// Type or speak a request: "make a website for my pottery class and write posts announcing it".
struct AssistantView: View {
    var openSettings: () -> Void
    var openReview: () -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var prompt = ""
    @State private var allowWebSearch = false
    @State private var voice = VoiceInput()
    /// What was typed before the mic started, so dictation is added to it rather than replacing it.
    @State private var promptBeforeVoice = ""
    @FocusState private var promptFocused: Bool

    private let suggestions: [(String, String)] = [
        ("globe", "Make a one-page website for my business"),
        ("calendar.badge.plus", "Announce my next event on social media"),
        ("sparkles", "Write a week of posts about what I do"),
    ]

    var body: some View {
        ScrollViewReader { proxy in
        ScrollView {
            VStack(spacing: 28) {
                hero
                if !model.isConfigured {
                    setupNotice
                } else if model.aiConsent == false {
                    consentNotice
                }
                VoiceOrb(isListening: voice.isListening, isBusy: isPreparingVoice, level: voice.level) {
                    Task { await toggleVoice() }
                }
                .disabled(model.isRunning)
                voiceStatus
                composer
                if prompt.isEmpty && model.lastRun == nil && !model.isRunning {
                    suggestionChips
                }
                if model.isRunning {
                    working
                }
                if let message = model.errorMessage {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout)
                        .foregroundStyle(.red)
                        .glowCard(padding: 14)
                }
                if let run = model.lastRun, !model.isRunning {
                    RunResultView(run: run, openReview: openReview)
                        .id("results")
                        .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 24)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
            .animation(.spring(duration: 0.45), value: model.isRunning)
            .animation(.spring(duration: 0.45), value: model.lastRun)
        }
        .scrollDismissesKeyboard(.interactively)
        .onChange(of: model.isRunning) { wasRunning, isRunning in
            // Results appear when a run finishes, usually below the fold: bring them into view.
            guard wasRunning, !isRunning, model.lastRun != nil else { return }
            withAnimation(reduceMotion ? nil : .spring(duration: 0.6)) { proxy.scrollTo("results", anchor: .top) }
        }
        }
        .auroraBackground()
        .onChange(of: voice.transcript) { _, spoken in
            prompt = [promptBeforeVoice, spoken].filter { !$0.isEmpty }.joined(separator: " ")
        }
        .sensoryFeedback(.start, trigger: voice.isListening) { _, listening in listening }
        .sensoryFeedback(.success, trigger: model.lastRun)
    }

    /* ---------------- header ---------------- */

    private var hero: some View {
        VStack(spacing: 8) {
            Text("What should we create?")
                .font(Theme.heading())
                .foregroundStyle(Theme.spectrumGradient)
                .multilineTextAlignment(.center)
            Text("Speak or type. Nothing is published until you approve it.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.top, 8)
    }

    @ViewBuilder
    private var voiceStatus: some View {
        Group {
            switch voice.state {
            case .idle:
                Text("Tap to speak")
            case .listening:
                Label("Listening · recognized on this device", systemImage: "lock.fill")
            case .preparing(let message):
                Text(message)
            case .unavailable(let message):
                Label(message, systemImage: "mic.slash").foregroundStyle(.orange)
            }
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .contentTransition(.opacity)
        .animation(.easeInOut, value: voice.state)
    }

    /* ---------------- the composer ---------------- */

    private var composer: some View {
        let shape = RoundedRectangle(cornerRadius: 28, style: .continuous)
        return VStack(alignment: .leading, spacing: 12) {
            TextField("Describe what you'd like…", text: $prompt, axis: .vertical)
                .lineLimit(3...10)
                .font(.body)
                .focused($promptFocused)
                .textFieldStyle(.plain)
                .disabled(voice.isListening)

            HStack(spacing: 10) {
                Toggle(isOn: $allowWebSearch) {
                    Label("Web search", systemImage: "globe")
                        .font(.footnote.weight(.semibold))
                }
                .toggleStyle(.button)
                .buttonStyle(.glass)
                .help("Lets the assistant look things up. Anything it reads from the web is flagged before you approve.")

                Spacer()

                Button {
                    Task { await send() }
                } label: {
                    Label("Create", systemImage: "arrow.up")
                        .font(.body.weight(.semibold))
                        .padding(.horizontal, 4)
                }
                .buttonStyle(.glassProminent)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!canSend)
            }
        }
        .padding(16)
        .glassEffect(.regular, in: shape)
        .overlay { SpectrumEdge(cornerRadius: 28, isActive: model.isRunning || voice.isListening) }
    }

    private var suggestionChips: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel("Try")
            ForEach(suggestions, id: \.1) { icon, text in
                Button {
                    prompt = text
                    promptFocused = true
                } label: {
                    Label(text, systemImage: icon)
                        .font(.subheadline)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.glass)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var working: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel("Working", color: Theme.spectrum[2])
            Text("Building your site and writing your posts. This can take a minute.")
                .font(.callout)
                .foregroundStyle(.secondary)
            ThinkingBeam()
        }
        .glowCard()
        .transition(.opacity)
    }

    /* ---------------- actions ---------------- */

    private var isPreparingVoice: Bool {
        if case .preparing = voice.state { return true }
        return false
    }

    private var canSend: Bool {
        model.isConfigured && !model.isRunning && !voice.isListening
            && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func toggleVoice() async {
        if !voice.isListening { promptBeforeVoice = prompt.trimmingCharacters(in: .whitespacesAndNewlines) }
        promptFocused = false
        await voice.toggle()
    }

    private func send() async {
        promptFocused = false
        await model.runAssistant(prompt: prompt, allowWebSearch: allowWebSearch)
    }

    /* ---------------- notices ---------------- */

    private var setupNotice: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel("Setup", color: .orange)
            Text("Connect to your server")
                .font(.headline)
            Text("Add your server address and access token in Settings. The assistant runs there, so your AI key and account passwords never live on this device.")
                .font(.callout)
                .foregroundStyle(.secondary)
            Button("Open Settings", systemImage: "gearshape", action: openSettings)
                .buttonStyle(.glass)
        }
        .glowCard()
    }

    private var consentNotice: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel("Your OK")
            Text("Allow the assistant to use AI")
                .font(.headline)
            Text("What you type or say goes to your server, which asks Claude (Anthropic) to write the site and posts. Nothing is published until you approve it.")
                .font(.callout)
                .foregroundStyle(.secondary)
            Button("Allow AI", systemImage: "checkmark") { Task { await model.setAIConsent(true) } }
                .buttonStyle(.glassProminent)
        }
        .glowCard()
    }
}

/// What the assistant said, the posts it wrote, and what's waiting for approval.
private struct RunResultView: View {
    let run: AgentRunResponse
    var openReview: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            if !run.text.isEmpty {
                HStack(alignment: .top, spacing: 14) {
                    IconTile(systemImage: run.needsAnswer ? "questionmark" : "sparkles", size: 34)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(run.needsAnswer ? "A question for you" : "Assistant")
                            .font(.subheadline.weight(.semibold))
                        Text(run.text)
                            .textSelection(.enabled)
                        if run.needsAnswer {
                            Text("Answer above and tap Create again.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .glowCard()
            }

            if run.tainted {
                Label("This used content from the web. Check everything carefully before approving.", systemImage: "exclamationmark.shield.fill")
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .glowCard(padding: 14)
            }

            let waiting = run.proposals.filter(\.isPending)
            if !waiting.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    SectionLabel("Waiting for your approval")
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(waiting) { p in
                            HStack(spacing: 12) {
                                IconTile(systemImage: p.isSite ? "globe" : "text.bubble.fill", size: 30)
                                Text(p.summary).font(.subheadline)
                            }
                        }
                        Button(action: openReview) {
                            Label("Review and publish", systemImage: "checkmark.seal.fill")
                                .font(.body.weight(.semibold))
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.glassProminent)
                        .controlSize(.large)
                    }
                    .glowCard()
                }
            }

            let sharable = run.drafts.filter(\.isForSharing)
            if !sharable.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    SectionLabel("Posts to share")
                    ForEach(sharable) { DraftCard(draft: $0) }
                }
            }

            let blocked = run.proposals.filter { $0.status == "blocked" }
            if !blocked.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    SectionLabel("Couldn't be proposed", color: .red)
                    ForEach(blocked) { p in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(p.summary).font(.headline)
                            CheckList(checks: p.checks)
                        }
                        .glowCard()
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
