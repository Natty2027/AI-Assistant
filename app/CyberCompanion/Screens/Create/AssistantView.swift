import PhotosUI
import SwiftUI

/// Type a request ("make a poster for my pottery class and write posts announcing it"), or tap
/// the orb and talk with Hera: a spoken back-and-forth that goes on until the person is done.
struct AssistantView: View {
    var openSettings: () -> Void
    var openReview: () -> Void

    @Environment(AppModel.self) private var model
    @Environment(ConversationRequests.self) private var conversations
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var prompt = ""
    /// Posts, schedule or launch: one at a time, never two in the same run.
    @State private var mode: CreateMode = .posts
    @State private var allowWebSearch = false
    /// A photo for the posts (Instagram needs one). Posts only.
    @State private var photoItem: PhotosPickerItem?
    @State private var photo: PostPhoto?
    @State private var isLoadingPhoto = false
    @State private var photoProblem: String?
    /// "Snap it": the camera is open, then the photo it took is worked out in a sheet.
    @State private var showCamera = false
    @State private var captured: Data?
    @State private var snap: Snap?
    /// A quick reply to a received text, made on this device, as a text message to send.
    @State private var quickReply: TextDraft?
    @State private var voice = VoiceInput()
    /// The spoken conversation (Talk). Made on first use, since it needs the mic and Hera's voice.
    @State private var talk: TalkSession?
    @FocusState private var promptFocused: Bool
    @AppStorage(HeraVoice.speakRepliesKey) private var speakReplies = true
    /// The "How Hera works" card shows until it's dismissed once.
    @AppStorage("seenHowHeraWorks") private var seenHowHeraWorks = false
    /// Set when the upgrade card is closed, so it goes at once (it stays closed for the month).
    @State private var nudgeDismissed = false

    private let suggestions: [(CreateMode, String, String)] = [
        (.posts, "photo.artframe", "Make a poster and posts for Saturday's open house, 10 AM to 2 PM"),
        (.launch, "sparkles", "Launch my pottery workshop on the 20th at 6 PM: $40, 8 spots"),
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
                if UpgradeNudge.shouldShow(model.pro.status) && !nudgeDismissed {
                    upgradeNudge
                }
                VoiceOrb(isListening: voice.isListening, isBusy: isPreparingVoice || talk?.phase == .thinking,
                         isHeraSpeaking: model.speech.isSpeaking, isInConversation: isTalking, level: voice.level,
                         action: orbTapped)
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
                if let quickReply {
                    TextDraftCard(draft: quickReply)
                        .id(quickReply.id)
                        .transition(.opacity)
                }
                if let talk, talk.isActive || !talk.turns.isEmpty {
                    TalkView(session: talk, liveWords: voice.transcript, openReview: openReview)
                        .transition(.opacity)
                }
                // While talking, the conversation is the screen; the box comes back when it ends.
                if !isTalking {
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
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 24)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
            .animation(.spring(duration: 0.45), value: model.isRunning)
            .animation(.spring(duration: 0.45), value: model.lastRun)
            .animation(.spring(duration: 0.45), value: isTalking)
        }
        .scrollDismissesKeyboard(.interactively)
        // End and Interrupt stay in reach however long the conversation gets.
        .safeAreaInset(edge: .bottom) {
            if let talk, talk.isActive {
                TalkControls(session: talk)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        // Each new turn scrolls into view, like Messages.
        .onChange(of: talk?.turns.last?.id) { _, id in
            guard let id else { return }
            withAnimation(reduceMotion ? nil : .spring(duration: 0.5)) { proxy.scrollTo(id, anchor: .bottom) }
        }
        .onChange(of: model.isRunning) { wasRunning, isRunning in
            // Results appear when a run finishes, usually below the fold: bring them into view.
            guard wasRunning, !isRunning, let run = model.lastRun else { return }
            withAnimation(reduceMotion ? nil : .spring(duration: 0.6)) { proxy.scrollTo("results", anchor: .top) }
            if speakReplies { model.speech.speak(run.text) }
        }
        }
        .auroraBackground()
        // "Hey Siri, talk to Hera" (TalkToHeraIntent) lands here: Hera says hello and listens.
        .onChange(of: conversations.isPending, initial: true) { _, pending in
            if pending, conversations.take() { startTalk(greet: true) }
        }
        .onChange(of: allowWebSearch) { _, allowed in talk?.allowsWebSearch = allowed }
        // "Siri, hi Hera, what's on my day?" (WhatsOnMyDayIntent) lands here.
        .onChange(of: conversations.isBriefingPending, initial: true) { _, pending in
            if pending, conversations.takeBriefing() { Task { await briefMe() } }
        }
        // "Ask Hera to make something" (CreateWithHeraIntent) lands here, and waits for a run
        // that's already going to finish.
        .onChange(of: conversations.pendingCreation, initial: true) { sendRequestedCreation() }
        .onChange(of: model.isRunning) { sendRequestedCreation() }
        // The first load on a device compiles the voice model; start it now, not at the first reply.
        .task { if speakReplies { model.speech.prepare() } }
        // In the background the system pauses Hera's audio mid-sentence; stop cleanly instead, and
        // end a conversation, since the mic can't keep listening there.
        .onChange(of: scenePhase) { _, phase in
            if phase == .background {
                talk?.end(sayingGoodbye: false)
                model.speech.stop()
            }
            // Back in the app, the widget is freshened by CyberCompanionApp, not again here.
        }
        .sensoryFeedback(.start, trigger: voice.isListening) { _, listening in listening }
        .sensoryFeedback(.success, trigger: model.lastRun)
        // A new text (or none): the quick reply was for the old one.
        .onChange(of: model.receivedText) { quickReply = nil }
        #if os(iOS)
        // The sheet opens once the camera has gone, since one can't present over the other.
        .fullScreenCover(isPresented: $showCamera, onDismiss: {
            if let captured { snap = Snap(jpeg: captured) }
            captured = nil
        }) {
            CameraPicker { captured = $0 }
                .ignoresSafeArea()
        }
        #endif
        .sheet(item: $snap) { snap in
            SnapSheet(snap: snap) { action in Task { await handle(action) } }
        }
    }

    /* ---------------- header ---------------- */

    private var hero: some View {
        VStack(spacing: 8) {
            Text("What should we create?")
                .font(Theme.heading())
                .foregroundStyle(Theme.spectrumGradient)
                .multilineTextAlignment(.center)
            Text("Posters, posts, emails and your schedule. Talk or type; nothing goes out until you approve it.")
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
            case .idle where talk?.phase == .thinking:
                Text("Hera is thinking…")
            case .idle where talk?.phase == .speaking:
                Text("Tap the orb to interrupt and speak")
            case .idle where model.speech.isSpeaking:
                Button("Hera is speaking · Stop", systemImage: "stop.fill", action: stopHera)
                    .buttonStyle(.glass)
                    .controlSize(.small)
            case .idle:
                Text("Tap and talk with Hera")
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
                .help("Add a photo to your posters and posts. Instagram posts need one.")
                .accessibilityLabel(title)
            }

            #if os(iOS)
            if CameraPicker.isAvailable {
                Button { showCamera = true } label: {
                    Label("Snap it", systemImage: "camera.viewfinder")
                        .composerButtonLabel()
                }
                .labelStyle(compact ? AnyLabelStyle(.iconOnly) : AnyLabelStyle(.titleAndIcon))
                .buttonStyle(.glass)
                .disabled(model.isRunning)
                .help("Point the camera at a business card, flyer or product and Hera works out what to do.")
                .accessibilityLabel("Snap it")
            }
            #endif

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
            VStack(alignment: .leading, spacing: 6) {
                Text("Hera will add this photo to your posters and posts.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                // The same look the camera gets, for a photo from the library (and on the Mac).
                Button("What's this?", systemImage: "text.viewfinder") { snap = Snap(jpeg: photo.jpeg) }
                    .buttonStyle(.glass)
                    .controlSize(.small)
                    .lineLimit(1)
                    .disabled(model.isRunning)
            }
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
        case .posts: "What should we promote? A poster, posts, a flyer…"
        case .schedule: "Tell Hera what to plan, move or remind you about…"
        case .launch: "What are you launching? The date, place, price and how to sign up…"
        case .talk: "Tap the orb and talk with Hera…"
        }
    }

    private var workingMessage: String {
        switch mode {
        case .posts: "Designing your posters and posts. This can take a minute."
        case .schedule: "Looking at your schedule. This can take a minute."
        case .launch: "Putting your launch together: posts, a poster, calendar and email. This can take a few minutes."
        case .talk: "Hera is thinking…"
        }
    }

    /// A spoken conversation is going.
    private var isTalking: Bool { talk?.isActive ?? false }

    private var isPreparingVoice: Bool {
        if case .preparing = voice.state { return true }
        return false
    }

    private var canSend: Bool {
        model.isConfigured && !model.isRunning && !voice.isListening
            && (!prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.receivedText != nil)
    }

    /// Ends what Hera is saying and, if she was in a conversation, the conversation too, so she
    /// doesn't carry on listening.
    private func stopHera() {
        talk?.end(sayingGoodbye: false)
        model.speech.stop()
    }

    /// The orb starts a conversation. During one, it interrupts Hera while she speaks (and listens
    /// at once), and otherwise ends it.
    private func orbTapped() {
        if let talk, talk.isActive {
            talk.tapOrb()
        } else if model.speech.isSpeaking {
            stopHera()
        } else {
            startTalk(greet: false)
        }
    }

    /// Clears the last result and the box, ready for the next request, and scrolls back up.
    private func startOver(scrollingWith proxy: ScrollViewProxy) {
        model.speech.stop()
        withAnimation(.spring(duration: 0.45)) {
            model.clearLastRun()
            prompt = ""
            photoItem = nil
            photo = nil
            photoProblem = nil
            talk?.clear()
            quickReply = nil
        }
        proxy.scrollTo("top", anchor: .top)
    }

    private func dismissHowHeraWorks() {
        withAnimation { seenHowHeraWorks = true }
    }

    private func send() async {
        promptFocused = false
        // A typed request starts its own task; the conversation's cards go with it.
        talk?.clear()
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
        }
    }

    /// A request from Siri or Shortcuts: a new task in its mode, sent as it is.
    private func sendRequestedCreation() {
        guard !model.isRunning, let creation = conversations.takeCreation() else { return }
        model.speech.stop()
        if model.lastRun != nil { model.clearLastRun() }
        mode = creation.mode
        // An earlier photo belongs to an earlier task.
        photoItem = nil
        photo = nil
        Task {
            // A conversation that was going ends: this request is its own task.
            talk?.end(sayingGoodbye: false)
            await voice.stop()
            prompt = creation.request
            await send()
        }
    }

    /* ---------------- "Snap it" ---------------- */

    /// What the person chose in "Here's what I see". A snap starts a new Studio task.
    private func handle(_ action: SnapAction) async {
        if case .receive(let text) = action {
            model.receive(text: text)
            return
        }
        model.speech.stop()
        if model.lastRun != nil { model.clearLastRun() }
        mode = .posts
        photoProblem = nil
        var photoData: Data?
        switch action {
        case .run(_, let jpeg), .prefill(_, let jpeg): photoData = jpeg
        case .receive: break
        }
        // The snap's photo, or none: a business card shouldn't go out on a follow-up email's posts.
        photoItem = nil
        photo = nil
        if let photoData {
            // Sized and shaped for Instagram, like a photo from the library.
            let jpeg = await Task.detached(priority: .userInitiated) { PostPhoto.prepare(from: photoData) }.value
            photo = jpeg.flatMap(PostPhoto.init(jpeg:))
        }
        switch action {
        case .run(let request, _):
            prompt = request
            await send()
        case .prefill(let request, _):
            prompt = request
            promptFocused = true
        case .receive:
            break
        }
    }

    /* ---------------- Hera Pro ---------------- */

    /// Three quarters of the free month used: a gentle offer, closable for the rest of the month.
    @ViewBuilder
    private var upgradeNudge: some View {
        if let status = model.pro.status {
            HStack(alignment: .top, spacing: 12) {
                IconTile(systemImage: "sparkles", size: 30)
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(status.remaining) free \(status.remaining == 1 ? "request" : "requests") left this month")
                        .font(.subheadline.weight(.semibold))
                    Text("Hera Pro gives you many more, and removes \u{201C}Made with Hera\u{201D} from posters.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button("See Hera Pro") { model.pro.showPlans = true }
                        .buttonStyle(.glassProminent)
                        .controlSize(.small)
                        .padding(.top, 4)
                }
                Spacer(minLength: 0)
                Button("Close", systemImage: "xmark") {
                    UpgradeNudge.dismiss()
                    withAnimation { nudgeDismissed = true }
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
            .glowCard()
            .transition(.opacity)
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
                    withAnimation {
                        model.receivedText = nil
                        quickReply = nil
                    }
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
            QuickReplies(text: text) { reply in
                withAnimation { quickReply = TextDraft(id: UUID().uuidString, to: [], body: reply) }
            }
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
        talk?.end(sayingGoodbye: false)
        model.speech.stop()
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

    /* ---------------- Talk ---------------- */

    /// Starts a spoken conversation: from the orb Hera listens straight away; from Siri ("Talk to
    /// Hera") she says hello first. Nothing is published: anything she makes waits for approval.
    private func startTalk(greet: Bool) {
        model.speech.stop()
        guard model.isConfigured else { return }  // the sign-in screen is showing instead
        if model.aiConsent == false {
            model.speech.speak("Hi, I'm Hera. First, tap Allow AI on this screen, then talk to me again.")
            return
        }
        promptFocused = false
        let session = talkSession()
        session.allowsWebSearch = allowWebSearch
        model.startTalk()
        withAnimation { session.start(greet: greet) }
    }

    /// The Settings switch "Hera speaks her replies", read for every reply.
    private static var speaksReplies: Bool { UserDefaults.standard.object(forKey: HeraVoice.speakRepliesKey) as? Bool ?? true }

    /// The conversation, wired to this screen's mic and Hera's voice.
    private func talkSession() -> TalkSession {
        if let talk { return talk }
        let voice = voice
        let model = model
        let session = TalkSession(hooks: .init(
            listen: {
                let heard = await voice.listenUntilSilence()
                // The mic is off or failed: the status under the orb says why.
                if case .unavailable = voice.state { return nil }
                return heard
            },
            stopListening: { await voice.stop() },
            speak: { text, done in
                // With Hera's voice off in Settings, the reply is shown and she listens straight away.
                guard Self.speaksReplies else {
                    done()
                    return
                }
                model.speech.speak(text, then: done)
            },
            beginReply: { done in model.speech.beginReply(silently: !Self.speaksReplies, then: done) },
            continueReply: { sentence in model.speech.enqueue(sentence) },
            endReply: { model.speech.endReply() },
            stopSpeaking: { model.speech.stop() },
            send: { said, allowWebSearch, onText in await model.talk(said, allowWebSearch: allowWebSearch, onText: onText) }
        ))
        talk = session
        return session
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
            Text("What you type or say is sent to Claude, by Anthropic, to make your posters and posts, and with Schedule, your upcoming events and reminders too. Nothing is published or changed until you approve it.")
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
