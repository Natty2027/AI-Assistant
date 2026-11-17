import PhotosUI
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
    @State private var mode: CreateMode = .posts
    @State private var allowWebSearch = false
    /// A photo for the posts (Instagram needs one). Posts only.
    @State private var photoItem: PhotosPickerItem?
    @State private var photo: PostPhoto?
    @State private var isLoadingPhoto = false
    @State private var photoProblem: String?
    @State private var voice = VoiceInput()
    /// What was typed before the mic started, so dictation is added to it rather than replacing it.
    @State private var promptBeforeVoice = ""
    @FocusState private var promptFocused: Bool
    @AppStorage(HeraVoice.speakRepliesKey) private var speakReplies = true
    /// The "How Hera works" card shows until it's dismissed once.
    @AppStorage("seenHowHeraWorks") private var seenHowHeraWorks = false

    /// Where the spoken "Talk to Hera" conversation is.
    private enum Conversation { case none, choosing, describing }
    @State private var conversation: Conversation = .none

    private let suggestions: [(CreateMode, String, String)] = [
        (.posts, "photo.artframe", "Make a poster and posts for Saturday's open house, 10 AM to 2 PM"),
        (.launch, "sparkles", "Launch my pottery workshop on the 20th at 6 PM: $40, 8 spots"),
        (.site, "globe", "Make a one-page website for my business"),
        (.posts, "calendar.badge.plus", "Announce my next event on social media"),
        (.posts, "sparkles", "Write a week of posts about what I do"),
        (.schedule, "calendar", "What's on my schedule tomorrow? Add a gym session in a free hour"),
        (.posts, "envelope", "Write an email to a customer confirming their Saturday booking"),
        (.posts, "tag", "Sell this on eBay for $150. It ships from my ZIP code, 95819"),
    ]

    var body: some View {
        ScrollViewReader { proxy in
        ScrollView {
            VStack(spacing: 28) {
                hero
                    .id("top")
                notices
                VoiceOrb(isListening: voice.isListening, isBusy: isPreparingVoice,
                         isHeraSpeaking: model.speech.isSpeaking, level: voice.level) {
                    if model.speech.isSpeaking { stopHera() } else { Task { await toggleVoice() } }
                }
                // While Hera is reading a reply out, the orb stays usable as her Stop button.
                .disabled(model.isRunning && !model.speech.isSpeaking)
                voiceStatus
                if let briefing = model.briefing {
                    briefingCard(briefing)
                        .transition(.opacity)
                }
                if let text = model.receivedText {
                    receivedTextCard(text)
                        .transition(.opacity)
                }
                composer
                if model.receivedText == nil && model.lastRun == nil && !model.isRunning {
                    pasteATextRow
                }
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
                    RunResultView(run: run, openReview: openReview, startOver: { startOver(scrollingWith: proxy) })
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
        // "Siri, hi Hera, what's on my day?" (WhatsOnMyDayIntent) lands here.
        .onChange(of: conversations.isBriefingPending, initial: true) { _, pending in
            if pending, conversations.takeBriefing() { Task { await briefMe() } }
        }
        // "Hi Hera" said into the orb: a greeting starts the conversation, "what's on my day" gets
        // the briefing, and a greeting in front of a request is dropped.
        .onChange(of: voice.isListening) { wasListening, isListening in
            guard wasListening, !isListening, conversation == .none, promptBeforeVoice.isEmpty else { return }
            switch HeraGreeting.interpret(prompt) {
            case .conversation:
                prompt = ""
                startConversation()
            case .briefing:
                prompt = ""
                Task { await briefMe() }
            case .request(let request):
                prompt = request
            }
        }
        // The first load on a device compiles the voice model; start it now, not at the first reply.
        .task { if speakReplies { model.speech.prepare() } }
        // In the background the system pauses Hera's audio mid-sentence; stop cleanly instead.
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { model.speech.stop() }
            // Back in the app: the calendar may have changed elsewhere, so freshen the widget.
            if phase == .active { Task { await model.refreshWidget() } }
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
            Text("Posters, posts, emails and your schedule. Speak or type; nothing goes out until you approve it.")
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
            case .idle where model.speech.isSpeaking:
                Button("Hera is speaking · Stop", systemImage: "stop.fill", action: stopHera)
                    .buttonStyle(.glass)
                    .controlSize(.small)
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
                ForEach(CreateMode.displayOrder) { m in
                    Label(m.title, systemImage: m.systemImage).tag(m)
                }
            }
            .pickerStyle(.segmented)
            // The Mac shows a picker's label beside it; the modes speak for themselves.
            .labelsHidden()
            .frame(maxWidth: .infinity)
            .disabled(model.isRunning)

            TextField(placeholder,
                      text: $prompt, axis: .vertical)
                .lineLimit(3...10)
                .font(.body)
                .focused($promptFocused)
                .textFieldStyle(.plain)
                .disabled(voice.isListening)

            if mode.takesPhoto, let photo {
                attachedPhoto(photo)
            }
            if mode.takesPhoto, let photoProblem {
                Label(photoProblem, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }

            // Every button in the row is the same height and stays on one line. When the row is
            // too narrow (a small phone, a narrow Mac window, large text), Photo and Web search
            // become icon-only rather than wrapping.
            ViewThatFits(in: .horizontal) {
                composerActions(compact: false)
                composerActions(compact: true)
            }
        }
        .padding(16)
        .glassEffect(.regular, in: shape)
        .overlay { SpectrumEdge(cornerRadius: 28, isActive: model.isRunning || voice.isListening) }
        .onChange(of: photoItem) { _, item in
            Task { await loadPhoto(item) }
        }
    }

    /// Photo, Web search and Create. `compact` shows Photo and Web search as icons only.
    private func composerActions(compact: Bool) -> some View {
        HStack(spacing: 10) {
            if mode.takesPhoto {
                // The label closure runs off the main actor, so it gets plain values.
                let loading = isLoadingPhoto
                let title = photo == nil ? "Photo" : "Change"
                PhotosPicker(selection: $photoItem, matching: .images, photoLibrary: .shared()) {
                    ZStack {
                        // Kept in the layout while loading, so the button doesn't change size.
                        Label(title, systemImage: "photo").opacity(loading ? 0 : 1)
                        if loading { ProgressView().controlSize(.small) }
                    }
                    .composerButtonLabel()
                }
                .labelStyle(compact ? AnyLabelStyle(.iconOnly) : AnyLabelStyle(.titleAndIcon))
                .buttonStyle(.glass)
                .disabled(model.isRunning || isLoadingPhoto)
                .help(mode == .site ? "Add a photo to put on your website." : "Add a photo to your posts. Instagram posts need one.")
                .accessibilityLabel(title)
            }

            Toggle(isOn: $allowWebSearch) {
                Label("Web search", systemImage: "globe")
                    .composerButtonLabel()
            }
            .labelStyle(compact ? AnyLabelStyle(.iconOnly) : AnyLabelStyle(.titleAndIcon))
            .toggleStyle(.button)
            .buttonStyle(.glass)
            .help("Lets Hera look things up. Anything it reads from the web is flagged before you approve.")

            Spacer(minLength: 0)

            Button {
                Task { await send() }
            } label: {
                Label(model.isContinuing(mode) ? "Send" : "Create", systemImage: "arrow.up")
                    .composerButtonLabel()
                    .padding(.horizontal, 6)
            }
            .buttonStyle(.glassProminent)
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(!canSend)
        }
        .controlSize(.regular)
    }

    private func attachedPhoto(_ photo: PostPhoto) -> some View {
        HStack(spacing: 12) {
            Image(decorative: photo.preview, scale: 1)
                .resizable()
                .scaledToFill()
                .frame(width: 64, height: 64)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            Text(mode == .site ? "Hera will put this photo on your website." : "Hera will add this photo to your posts.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer()
            Button("Remove photo", systemImage: "xmark.circle.fill") {
                photoItem = nil
                self.photo = nil
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
    }

    /// Reads the chosen photo and prepares it (JPEG, sized and shaped for Instagram) off the main thread.
    private func loadPhoto(_ item: PhotosPickerItem?) async {
        photoProblem = nil
        guard let item else { return }
        isLoadingPhoto = true
        defer { isLoadingPhoto = false }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else { throw CocoaError(.fileReadCorruptFile) }
            let jpeg = await Task.detached(priority: .userInitiated) { PostPhoto.prepare(from: data) }.value
            guard let jpeg, let prepared = PostPhoto(jpeg: jpeg) else { throw CocoaError(.fileReadCorruptFile) }
            photo = prepared
        } catch {
            photo = nil
            photoItem = nil
            photoProblem = "That photo couldn't be used. Try a different one."
        }
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
                    // Drawn here rather than by a button style: a Mac button keeps its title on one
                    // line and centres it, which cut these off and broke their left edge.
                    Label(text, systemImage: icon)
                        .labelStyle(.alignedIcon)
                        .font(.subheadline)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, minHeight: 22, alignment: .leading)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .contentShape(.rect(cornerRadius: 18))
                        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 18))
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var working: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel("Working", color: Theme.spectrum[2])
            Text(workingMessage)
                .font(.callout)
                .foregroundStyle(.secondary)
            ThinkingBeam()
        }
        .glowCard()
        .transition(.opacity)
    }

    /* ---------------- actions ---------------- */

    private var placeholder: String {
        if model.receivedText != nil { return "How should Hera reply? For example: say yes, 7 works for me" }
        if model.isContinuing(mode) { return "Reply to Hera, or ask for a change…" }
        return switch mode {
        case .site: "Describe the website you'd like. Add a photo to put it on the site…"
        case .posts: "What should we promote? A poster, posts, a flyer…"
        case .schedule: "Tell Hera what to plan, move or remind you about…"
        case .launch: "What are you launching? The date, place, price and how to sign up…"
        }
    }

    private var workingMessage: String {
        switch mode {
        case .site: "Building your website, page by page. This can take several minutes; you can leave the app and come back."
        case .posts: "Designing your posters and posts. This can take a minute."
        case .schedule: "Looking at your schedule. This can take a minute."
        case .launch: "Putting your launch together: website, posts, calendar and email. This can take a few minutes."
        }
    }

    private var isPreparingVoice: Bool {
        if case .preparing = voice.state { return true }
        return false
    }

    private var canSend: Bool {
        model.isConfigured && !model.isRunning && !voice.isListening
            && (!prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.receivedText != nil)
    }

    /// Ends what Hera is saying and, if she was in the middle of "Talk to Hera", the conversation
    /// too, so she doesn't carry on to the next question.
    private func stopHera() {
        model.speech.stop()
        conversation = .none
    }

    private func toggleVoice() async {
        if !voice.isListening { promptBeforeVoice = prompt.trimmingCharacters(in: .whitespacesAndNewlines) }
        promptFocused = false
        model.speech.stop()  // Hera stops talking as soon as the person starts
        await voice.toggle()
    }

    /// Clears the last result and the box, ready for the next request, and scrolls back up.
    private func startOver(scrollingWith proxy: ScrollViewProxy) {
        model.speech.stop()
        withAnimation(.spring(duration: 0.45)) {
            model.clearLastRun()
            prompt = ""
            promptBeforeVoice = ""
            photoItem = nil
            photo = nil
            photoProblem = nil
            conversation = .none
        }
        proxy.scrollTo("top", anchor: .top)
    }

    private func dismissHowHeraWorks() {
        withAnimation { seenHowHeraWorks = true }
    }

    private func send() async {
        promptFocused = false
        conversation = .none
        model.speech.stop()
        let continuing = model.isContinuing(mode)
        // A shared text with nothing typed: Hera helps reply to it.
        if prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, model.receivedText != nil {
            prompt = "Help me reply to this text."
        }
        await model.runAssistant(prompt: prompt, mode: mode, allowWebSearch: allowWebSearch,
                                 photo: mode.takesPhoto ? photo?.jpeg : nil)
        // In a conversation the box is for the next reply, so it starts empty again.
        if continuing || model.isContinuing(mode) {
            prompt = ""
            promptBeforeVoice = ""
        }
    }

    /* ---------------- texts the person received ---------------- */

    /// "Got a text?": paste one in and Hera reads it aloud. PasteButton reads the clipboard only
    /// when tapped, so there's no "allow paste" prompt.
    private var pasteATextRow: some View {
        HStack(spacing: 12) {
            PasteButton(payloadType: String.self) { strings in
                let text = strings.joined(separator: "\n")
                Task { @MainActor in model.receive(text: text) }
            }
            .buttonBorderShape(.capsule)
            .labelStyle(.titleAndIcon)
            .disabled(model.isRunning)
            Text("Got a text? Copy it in Messages, then paste it here. Hera reads it to you and helps you reply.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func receivedTextCard(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                SectionLabel("Text you received")
                Spacer()
                Button("Close", systemImage: "xmark") {
                    model.speech.stop()
                    withAnimation { model.receivedText = nil }
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
            Text(text)
                .font(.callout)
                .textSelection(.enabled)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.background.secondary, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            HStack(spacing: 10) {
                Button("Help me reply", systemImage: "arrowshape.turn.up.left.fill") {
                    Task { await send() }
                }
                .buttonStyle(.glassProminent)
                .disabled(!canSend)
                Button("Read it again", systemImage: "speaker.wave.2.fill") {
                    model.speech.speak("Here's the text: \(text)")
                }
                .buttonStyle(.glass)
            }
            .controlSize(.small)
            .lineLimit(1)
            Text("Type how you'd like to answer above, or just tap Help me reply.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .glowCard()
    }

    /* ---------------- "What's on my day?" ---------------- */

    private func briefMe() async {
        model.speech.stop()
        conversation = .none
        guard model.isConfigured else { return }
        guard let text = await model.briefMe() else { return }
        model.speech.speak(text)
    }

    private func briefingCard(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                SectionLabel("Your day")
                Spacer()
                Button("Close", systemImage: "xmark") {
                    model.speech.stop()
                    withAnimation { model.briefing = nil }
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
            Text(text)
                .textSelection(.enabled)
            if model.pendingCount > 0 {
                Button("Open Review", systemImage: "checkmark.seal", action: openReview)
                    .buttonStyle(.glass)
                    .controlSize(.small)
            }
        }
        .glowCard()
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
            ? "Hi, I'm Hera. Would you like a website, some posts, help with your schedule, or a full launch with all of it?"
            : "Let's do one at a time. A website, posts, your schedule, or a full launch?"
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
            model.speech.speak("No problem. Choose Website, Posts or Schedule, then tell me what you'd like.")
        }
    }

    private func askWhatAbout() {
        conversation = .describing
        prompt = ""
        promptBeforeVoice = ""
        let question = switch mode {
        case .site: "Great. What should the website be about?"
        case .posts: "Great. What would you like to post about?"
        case .schedule: "Great. What do you need done on your schedule?"
        case .launch: "Great. What are you launching? Tell me the date, the place, the price and how people sign up."
        }
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

    /// What needs doing before the first request (sign in, allow AI), then the first-run guide.
    @ViewBuilder
    private var notices: some View {
        if !model.isConfigured {
            setupNotice
        } else if model.aiConsent == false {
            consentNotice
        }
        if !seenHowHeraWorks {
            HowHeraWorksCard { dismissHowHeraWorks() }
                .transition(.opacity)
        }
    }

    private var setupNotice: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel("Setup", color: .orange)
            Text("Hera isn't connected yet")
                .font(.headline)
            Text("Sign in from Settings to get started.")
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
            Text("Allow Hera to use AI")
                .font(.headline)
            Text("What you type or say is sent to Claude, by Anthropic, to write your website and posts, and with Schedule, your upcoming events and reminders too. Nothing is published or changed until you approve it.")
                .font(.callout)
                .foregroundStyle(.secondary)
            Button("Allow AI", systemImage: "checkmark") { Task { await model.setAIConsent(true) } }
                .buttonStyle(.glassProminent)
        }
        .glowCard()
    }
}

#Preview {
    AssistantView(openSettings: {}, openReview: {})
        .environment(AppModel())
        .environment(ConversationRequests())
}

/// One look for the request box's buttons: the same text size and height, on one line.
private extension View {
    nonisolated func composerButtonLabel() -> some View {
        font(.subheadline.weight(.semibold))
            .lineLimit(1)
            .fixedSize()
            .frame(minHeight: 22)
    }
}

/// Lets one control switch between two label styles.
private struct AnyLabelStyle: LabelStyle {
    private let make: (Configuration) -> AnyView
    init<S: LabelStyle>(_ style: S) { make = { configuration in AnyView(Label(configuration).labelStyle(style)) } }
    func makeBody(configuration: Configuration) -> some View { make(configuration) }
}
