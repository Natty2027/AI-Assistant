import SwiftUI

/// Type or speak a request: "make a website for my pottery class and write posts announcing it".
struct AssistantView: View {
    var openSettings: () -> Void
    var openReview: () -> Void

    @Environment(AppModel.self) private var model
    @Environment(ConversationRequests.self) private var conversations
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var prompt = ""
    /// Website or posts: one at a time, never both in the same run.
    @State private var mode: CreateMode = .site
    @State private var allowWebSearch = false
    @State private var voice = VoiceInput()
    /// What was typed before the mic started, so dictation is added to it rather than replacing it.
    @State private var promptBeforeVoice = ""
    @FocusState private var promptFocused: Bool
    @AppStorage(HeraVoice.speakRepliesKey) private var speakReplies = true

    /// Where the spoken "Talk to Hera" conversation is.
    private enum Conversation { case none, choosing, describing }
    @State private var conversation: Conversation = .none

    private let suggestions: [(CreateMode, String, String)] = [
        (.site, "globe", "Make a one-page website for my business"),
        (.posts, "calendar.badge.plus", "Announce my next event on social media"),
        (.posts, "sparkles", "Write a week of posts about what I do"),
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
            guard wasRunning, !isRunning, let run = model.lastRun else { return }
            withAnimation(reduceMotion ? nil : .spring(duration: 0.6)) { proxy.scrollTo("results", anchor: .top) }
            if speakReplies { model.speech.speak(run.text) }
        }
        }
        .auroraBackground()
        .onChange(of: voice.transcript) { _, spoken in
            // The answer to "website or posts?" isn't part of the request.
            guard conversation != .choosing else { return }
            prompt = [promptBeforeVoice, spoken].filter { !$0.isEmpty }.joined(separator: " ")
        }
        // "Hey Siri, talk to Hera" (TalkToHeraIntent) lands here.
        .onChange(of: conversations.isPending, initial: true) { _, pending in
            if pending, conversations.take() { startConversation() }
        }
        // The first load on a device compiles the voice model; start it now, not at the first reply.
        .task { if speakReplies { model.speech.prepare() } }
        // In the background the system pauses Hera's audio mid-sentence; stop cleanly instead.
        .onChange(of: scenePhase) { _, phase in if phase == .background { model.speech.stop() } }
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
            Picker("Create", selection: $mode) {
                ForEach(CreateMode.allCases) { m in
                    Label(m.title, systemImage: m.systemImage).tag(m)
                }
            }
            .pickerStyle(.segmented)
            .disabled(model.isRunning)

            TextField(mode == .site ? "Describe the website you'd like…" : "Describe the posts you'd like…",
                      text: $prompt, axis: .vertical)
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
            ForEach(suggestions, id: \.2) { suggestionMode, icon, text in
                Button {
                    mode = suggestionMode
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
            Text(mode == .site ? "Building your website. This can take a minute." : "Writing your posts. This can take a minute.")
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
        model.speech.stop()  // Hera stops talking as soon as the person starts
        await voice.toggle()
    }

    private func send() async {
        promptFocused = false
        conversation = .none
        model.speech.stop()
        await model.runAssistant(prompt: prompt, mode: mode, allowWebSearch: allowWebSearch)
    }

    /* ---------------- "Talk to Hera" ---------------- */

    /// Hera asks website or posts, listens, then asks what it's about and starts on it. Each step
    /// waits for her to finish speaking before the mic opens. Nothing is published: the run ends
    /// in proposals the person approves, as always.
    private func startConversation() {
        model.speech.stop()
        guard model.isConfigured else { return }  // the sign-in screen is showing instead
        if model.aiConsent == false {
            model.speech.speak("Hi, I'm Hera. First, tap Allow AI on this screen, then call me again.")
            return
        }
        askWebsiteOrPosts(firstTime: true)
    }

    private func askWebsiteOrPosts(firstTime: Bool) {
        conversation = .choosing
        let question = firstTime
            ? "Hi, I'm Hera. Would you like to create a website, or write some posts?"
            : "Let's do one at a time. A website, or posts?"
        model.speech.speak(question) {
            Task { await hearWebsiteOrPosts(firstTime: firstTime) }
        }
    }

    private func hearWebsiteOrPosts(firstTime: Bool) async {
        let reply = await voice.listenUntilSilence()
        guard conversation == .choosing else { return }
        if let chosen = ConversationReply.mode(from: reply) {
            mode = chosen
            askWhatAbout()
        } else if firstTime && !reply.isEmpty {
            askWebsiteOrPosts(firstTime: false)
        } else {
            conversation = .none
            model.speech.speak("No problem. Choose Website or Posts, then tell me what you'd like.")
        }
    }

    private func askWhatAbout() {
        conversation = .describing
        prompt = ""
        promptBeforeVoice = ""
        let question = mode == .site ? "Great. What should the website be about?" : "Great. What would you like to post about?"
        model.speech.speak(question) {
            Task { await hearRequest() }
        }
    }

    private func hearRequest() async {
        let said = await voice.listenUntilSilence()
        guard conversation == .describing else { return }
        conversation = .none
        guard !said.isEmpty else {
            model.speech.speak("I didn't catch that. Tap the orb when you're ready.")
            return
        }
        prompt = said
        await send()
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

    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            if !run.text.isEmpty {
                HStack(alignment: .top, spacing: 14) {
                    IconTile(systemImage: run.needsAnswer ? "questionmark" : "sparkles", size: 34)
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(run.needsAnswer ? "A question for you" : "Assistant")
                                .font(.subheadline.weight(.semibold))
                            Spacer()
                            if HeraVoice.isAvailable { listenButton }
                        }
                        Text(run.text)
                            .textSelection(.enabled)
                        if model.speech.phase == .preparing {
                            Label("Getting Hera's voice ready…", systemImage: "waveform")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if let problem = model.speech.problem {
                            Text(problem)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
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

    /// Replays the reply in Hera's voice, or stops her mid-sentence.
    private var listenButton: some View {
        let speaking = model.speech.isSpeaking
        return Button {
            if speaking { model.speech.stop() } else { model.speech.speak(run.text) }
        } label: {
            Label(speaking ? "Stop" : "Listen", systemImage: speaking ? "stop.fill" : "speaker.wave.2.fill")
                .font(.footnote.weight(.semibold))
                .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(.glass)
        .controlSize(.small)
    }
}

#Preview {
    AssistantView(openSettings: {}, openReview: {})
        .environment(AppModel())
        .environment(ConversationRequests())
}
