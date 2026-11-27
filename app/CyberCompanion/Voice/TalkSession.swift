import Foundation
import Observation

/// Talk: a spoken back-and-forth with Hera, like a digital assistant. Hera listens until the person
/// goes quiet, sends what they said to the server (the "talk" mode, one conversation id for every
/// turn), shows and speaks the reply, then listens again. It ends when they say goodbye, tap the
/// orb or Stop, or say nothing twice in a row. Anything Hera drafts on the way waits for approval
/// as always; she never sends or changes anything herself.

/// The rules of the conversation, apart from the mic and the speaker so they can be tested.
struct TalkFlow: Equatable {
    /// What to do with what was just heard.
    enum Next: Equatable {
        /// Send it to Hera.
        case send(String)
        /// Nothing was said: listen once more.
        case listenAgain
        /// The person is done, or said nothing twice: say goodbye and stop.
        case goodbye
    }

    static let greeting = "Hi, what can I do for you?"
    static let goodbye = "Okay, talk soon."
    /// Quiet listens in a row that end the conversation.
    static let quietLimit = 2

    private(set) var quietInARow = 0

    mutating func heard(_ said: String) -> Next {
        let words = said.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else {
            quietInARow += 1
            return quietInARow >= Self.quietLimit ? .goodbye : .listenAgain
        }
        quietInARow = 0
        return Self.isGoodbye(words) ? .goodbye : .send(words)
    }

    /// Ways of saying "that's all": the whole thing said must be made of these and polite
    /// fillers, so "stop" ends the conversation but "stop my 9 o'clock reminder" doesn't.
    private static let closers: [[String]] = [
        "bye", "bye bye", "goodbye", "good bye", "bye for now", "see you", "see you later", "see ya", "talk later",
        "talk to you later", "that's all", "that is all", "that's it", "that is it", "that'll be all", "that will be all",
        "that's everything", "stop", "stop listening", "stop talking", "i'm done", "we're done", "done", "nothing else",
        "no thanks", "no thank you", "never mind", "nevermind", "good night", "goodnight", "i'm all set", "all set",
        "end", "end the conversation", "end conversation",
    ].map(words)

    private static let fillers: [[String]] = [
        "ok", "okay", "alright", "all right", "thanks", "thank you", "thanks so much", "thank you so much", "hera",
        "great", "cool", "perfect", "good", "so", "well", "then", "for now", "for today", "and", "oh", "that's great",
    ].map(words)

    /// Lower-case words and numbers without punctuation. Apostrophes go too, since recognition writes both
    /// "that's" and "thats".
    private static func words(_ text: String) -> [String] {
        let letters = text.lowercased()
            .replacingOccurrences(of: "'", with: "")
            .replacingOccurrences(of: "\u{2019}", with: "")
            .unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : " " }
        return String(letters).split(separator: " ").map(String.init)
    }

    private static let scheduleWords = ["calendar", "schedule", "my day", "today", "tomorrow", "this week", "next week",
                                        "remind", "reminder", "meeting", "appointment", "event", "free time", "busy"]

    /// How soon after the mic opens the first words must come to possibly be Hera's own voice.
    /// Her echo is the speaker still ringing out as the mic opens; a person answering takes
    /// longer to start, so words that come later are always theirs.
    static let echoWindow: Duration = .milliseconds(1200)

    /// What was heard, without Hera's own last words at the start of it. Her voice can still be
    /// coming out of the speaker for a moment as the mic opens (and an iPhone's speaker is right
    /// next to its mic), so the recognizer can hear the end of what she said. Only when the first
    /// words came within `echoWindow` of the mic opening: leading words (three or more) that
    /// repeat the end of her last sentence are dropped, and if that's everything, nothing was
    /// said. Later, or when it isn't known when they came, it's all theirs: people often answer
    /// with her own words ("send it to Sarah" after "Should I send it to Sarah?").
    static func removingEcho(of spoken: String, from heard: String, firstWordsAfter: Duration?) -> String {
        guard let firstWordsAfter, firstWordsAfter <= echoWindow else { return heard }
        let said = words(heard)
        let hers = Array(words(spoken).suffix(30))
        guard said.count >= 3, !hers.isEmpty else { return heard }
        // The longest start of what was heard that is also the end of what she said.
        var echoed = 0
        for length in stride(from: min(said.count, hers.count), through: 3, by: -1)
        where Array(said.prefix(length)) == Array(hers.suffix(length)) {
            echoed = length
            break
        }
        guard echoed > 0 else { return heard }
        if echoed == said.count { return "" }
        // Keep the rest as it was heard, punctuation and all: skip as many words as were echoed.
        var remaining = Substring(heard)
        for _ in 0..<echoed {
            remaining = remaining.drop { !($0.isLetter || $0.isNumber) }
            remaining = remaining.drop { $0.isLetter || $0.isNumber || $0 == "'" || $0 == "\u{2019}" }
        }
        return remaining.drop { !($0.isLetter || $0.isNumber) }.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// True when what was said is about their calendar or reminders, so it's worth asking for
    /// calendar access (once) to answer it.
    static func mentionsSchedule(_ said: String) -> Bool {
        let lower = said.lowercased()
        if case .briefing = HeraGreeting.interpret(said) { return true }
        return scheduleWords.contains { lower.contains($0) }
    }

    /// True when the person is ending the conversation: "bye", "that's all", "stop", "thanks
    /// Hera, that's it".
    static func isGoodbye(_ said: String) -> Bool {
        let spoken = words(said)
        guard !spoken.isEmpty, spoken.count <= 10 else { return false }
        // Longest phrases first, so "that's it" isn't read as "that's" and then a stray "it".
        let phrases = (closers.map { ($0, true) } + fillers.map { ($0, false) }).sorted { $0.0.count > $1.0.count }
        var at = 0
        var closed = false
        while at < spoken.count {
            guard let match = phrases.first(where: { Array(spoken[at...].prefix($0.0.count)) == $0.0 }) else {
                return false
            }
            closed = closed || match.1
            at += match.0.count
        }
        return closed
    }
}

/// Hera's answer as it arrives, cut into whole sentences for her to say one at a time, so she can
/// start speaking before the answer is finished. A sentence is handed over only once it's
/// complete (its end and the space after it have arrived); the unfinished tail is held until
/// more comes or the answer is done. Apart from the voice, so it can be tested.
struct SpokenSentences: Equatable {
    /// How much of the answer has been handed over to be said.
    private(set) var handedOver = ""
    /// The answer so far stopped growing from what was handed over (the server tried a step
    /// again). Nothing more is taken from the partial answer; the finished one decides.
    private(set) var diverged = false

    /// The sentences completed since the last call, from the answer so far.
    mutating func take(_ soFar: String) -> [String] {
        guard !diverged else { return [] }
        guard soFar.hasPrefix(handedOver) else {
            diverged = true
            return []
        }
        let rest = soFar.dropFirst(handedOver.count)
        guard let end = Self.lastSentenceEnd(in: rest) else { return [] }
        let complete = rest[..<end]
        handedOver += complete
        return Self.sentences(in: complete)
    }

    /// What's left to say once the whole answer is in. If the answer isn't a continuation of what
    /// was already said (a step was tried again, or it stopped with a message), nothing more is
    /// said: the screen shows the answer in full.
    mutating func finish(_ answer: String) -> [String] {
        guard answer.hasPrefix(handedOver) else { return [] }
        let rest = answer.dropFirst(handedOver.count)
        handedOver = answer
        return Self.sentences(in: rest)
    }

    /// Words that end with a full stop without ending the sentence.
    private static let abbreviations: Set<String> = ["mr", "mrs", "ms", "dr", "st", "vs", "jr", "sr", "e.g", "i.e"]
    private static let enders: Set<Character> = [".", "!", "?", "\u{2026}"]
    private static let closers: Set<Character> = ["\"", "'", "\u{201D}", "\u{2019}", ")", "]"]

    /// Where each complete sentence in `text` ends: just after its closing punctuation (and any
    /// quote or bracket), once the space after it has arrived. A line break ends one too. "3.5",
    /// "Dr. Lee" and a full stop still waiting for what follows don't count.
    static func sentenceEnds(in text: Substring) -> [Substring.Index] {
        var ends: [Substring.Index] = []
        var i = text.startIndex
        while i < text.endIndex {
            let c = text[i]
            if c.isNewline {
                ends.append(text.index(after: i))
            } else if enders.contains(c) {
                var after = text.index(after: i)
                while after < text.endIndex, enders.contains(text[after]) || closers.contains(text[after]) {
                    after = text.index(after: after)
                }
                if after < text.endIndex, text[after].isWhitespace, !isAbbreviation(endingAt: i, in: text) {
                    ends.append(after)
                }
                i = after
                continue
            }
            i = text.index(after: i)
        }
        return ends
    }

    private static func lastSentenceEnd(in text: Substring) -> Substring.Index? { sentenceEnds(in: text).last }

    /// True when the word ending at `dot` is one like "Dr" or "e.g".
    private static func isAbbreviation(endingAt dot: Substring.Index, in text: Substring) -> Bool {
        guard text[dot] == "." else { return false }
        var start = dot
        while start > text.startIndex, !text[text.index(before: start)].isWhitespace { start = text.index(before: start) }
        let word = text[start..<dot].lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "\"'(\u{201C}\u{2018}"))
        return abbreviations.contains(word)
    }

    /// `text` cut into sentences, trimmed, with empty ones left out. The tail after the last
    /// complete sentence is the last one.
    static func sentences(in text: Substring) -> [String] {
        var out: [String] = []
        var from = text.startIndex
        for end in sentenceEnds(in: text) {
            out.append(String(text[from..<end]))
            from = end
        }
        out.append(String(text[from...]))
        return out.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }
}

/// One thing said in the conversation. Hera's turns can carry what she made (`run`), shown as the
/// usual cards so the person can approve it while the conversation goes on.
struct TalkTurn: Identifiable, Equatable {
    enum Speaker: Equatable { case person, hera }

    let id = UUID()
    let speaker: Speaker
    /// Hera's grows as she writes it.
    var text: String
    var run: AgentRunResponse?
}

/// How one spoken turn went on the server.
enum TalkReply: Equatable {
    /// Hera answered; the conversation carries on.
    case answer(AgentRunResponse)
    /// Something went wrong this time (offline, a timeout): say so and keep listening.
    case problem(String)
    /// The conversation can't go on (not signed in, AI not allowed, the month's requests used
    /// up): say so and stop.
    case stop(String)
}

/// What one hands-free listen came back with.
enum Heard: Equatable {
    /// What the person said, and how long after the mic opened the first words came (nil when
    /// that isn't known, e.g. they only came as the recognizer finished).
    case words(String, firstWordsAfter: Duration? = nil)
    /// The mic worked and they said nothing.
    case nothing
    /// The mic had a passing problem (no sound came in, headphones connecting): worth another
    /// try, and not counted as the person being quiet.
    case glitch(String)
    /// The mic can't listen at all (access is off, no recognition for the language): the
    /// conversation ends, saying why.
    case unavailable(String)
}

/// Runs the conversation: when to listen, speak, send and stop. The mic, Hera's voice and the
/// server are passed in, so tests drive it with stand-ins.
@MainActor
@Observable
final class TalkSession {
    struct Hooks {
        /// Listens until the person goes quiet.
        var listen: @MainActor () async -> Heard
        var stopListening: @MainActor () async -> Void
        /// Speaks, then calls back once finished on its own (not when stopped). Calls back at
        /// once when Hera's voice is off in Settings: the reply is shown instead.
        var speak: @MainActor (String, @escaping @MainActor () -> Void) -> Void
        /// An answer said a sentence at a time as it arrives: begun, added to, then ended. Calls
        /// back once the last sentence has been heard after the end (not when stopped), or at
        /// the end when Hera's voice is off.
        var beginReply: @MainActor (@escaping @MainActor () -> Void) -> Void
        var continueReply: @MainActor (String) -> Void
        var endReply: @MainActor () -> Void
        var stopSpeaking: @MainActor () -> Void
        /// Sends what was said; the flag allows web search for this turn. The answer so far is
        /// passed to the closure as Hera writes it (by servers that send it).
        var send: @MainActor (String, Bool, @escaping @MainActor (String) -> Void) async -> TalkReply
        /// Sets the sound up for the whole conversation, once, before anything is said or heard.
        /// Returns why it couldn't be, or nil when it's ready.
        var prepareAudio: @MainActor () async -> String? = { nil }
        /// Hands the sound back once the conversation is over.
        var releaseAudio: @MainActor () -> Void = {}
    }

    /// The pauses and limits of a conversation. Tests run with no pauses.
    struct Timing {
        /// After Hera's last sound is played, before the mic opens: the speaker can still be
        /// ringing out (longer over Bluetooth), and the mic would hear her.
        var echoTail: Duration = .milliseconds(350)
        /// Before listening again after the mic had a passing problem.
        var retryPause: Duration = .milliseconds(500)
        /// The longest Hera can take to say something before the conversation stops waiting for
        /// her to finish: a fixed allowance plus a little for each character, comfortably slower
        /// than she speaks. Her voice should always say when it's done; this is in case it doesn't.
        var speechBase: Duration = .seconds(15)
        var speechPerCharacter: Duration = .milliseconds(120)

        func speechAllowance(characters: Int) -> Duration {
            speechBase + speechPerCharacter * characters
        }

        static let immediate = Timing(echoTail: .zero, retryPause: .zero)
    }

    enum Phase: Equatable {
        case off
        case speaking
        case listening
        /// Waiting for Hera's answer.
        case thinking
    }

    private(set) var phase: Phase = .off
    private(set) var turns: [TalkTurn] = []
    /// Why the last turn didn't go as it should, in a line for under the orb. Cleared when the
    /// next turn goes through.
    private(set) var problem: String?
    var isActive: Bool { phase != .off }
    /// The composer's Web search switch, read for every turn.
    var allowsWebSearch = false

    private let hooks: Hooks
    private let timing: Timing
    private var flow = TalkFlow()
    /// Bumped whenever a conversation starts or ends, so an answer or a listen that finishes
    /// after that is ignored.
    private var generation = 0
    /// Bumped for every listen, so only the latest one's result is used.
    private var listenCount = 0
    /// Bumped whenever Hera starts saying something, is talked over, or is heard out, so a late
    /// or repeated "finished" callback (or the watchdog) acts only once, for the right speech.
    private var speechCount = 0
    /// The mic's passing problems in a row; two end the conversation.
    private var glitchesInARow = 0
    /// What Hera said last, to recognize her own voice coming back through the mic.
    private var lastSpoken = ""
    /// Something has been said or listened for since start; the sound setup doesn't start it again.
    private var begun = false
    private var watchdog: Task<Void, Never>?

    /// The answer coming in while Hera writes it.
    private struct LiveReply {
        let id: Int
        var sentences = SpokenSentences()
        /// The turn showing it on screen, once there's something to show.
        var turn: UUID?
        /// She has started saying it (beginReply).
        var speaking = false
        /// The person tapped the orb to talk over her: the rest of it isn't said.
        var silenced = false
        /// Everything handed to her voice so far.
        var said = ""
    }
    private var live: LiveReply?
    private var replyCount = 0
    /// The answer being waited for. The next one waits for it: the server works on one at a time.
    private var replyTask: Task<Void, Never>?

    init(hooks: Hooks, timing: Timing = Timing()) {
        self.hooks = hooks
        self.timing = timing
    }

    /// Starts a new conversation. `greet` has Hera say hello first (from Siri); otherwise she
    /// listens at once, because the person tapped the orb to speak.
    func start(greet: Bool) {
        guard !isActive else { return }
        generation += 1
        let current = generation
        flow = TalkFlow()
        turns = []
        problem = nil
        glitchesInARow = 0
        lastSpoken = ""
        begun = false
        phase = greet ? .speaking : .listening
        TalkLog.note("talk: start (\(greet ? "greeting first" : "listening first"))")
        Task {
            let failure = await hooks.prepareAudio()
            guard current == generation else {
                // Ended while the sound was being set up: hand it back, unless another
                // conversation has started and is using it.
                if !isActive { hooks.releaseAudio() }
                return
            }
            if let failure {
                stop(because: failure)
                return
            }
            guard !begun else { return }  // the orb was tapped meanwhile
            if greet { say(TalkFlow.greeting) } else { listen() }
        }
    }

    /// The orb: while Hera speaks it interrupts her and listens straight away; otherwise it ends
    /// the conversation.
    func tapOrb() {
        switch phase {
        case .off: start(greet: false)
        case .speaking:
            TalkLog.note("talk: talked over Hera")
            speechCount += 1
            hooks.stopSpeaking()
            live?.silenced = true
            listen()
        case .listening, .thinking: end(sayingGoodbye: false)
        }
    }

    /// Stops listening and speaking. The conversation stays on screen until a new one starts.
    func end(sayingGoodbye: Bool) {
        guard isActive else { return }
        TalkLog.note("talk: ended\(sayingGoodbye ? " with goodbye" : "")")
        generation += 1
        phase = .off
        watchdog?.cancel()
        hooks.stopSpeaking()
        Task {
            await hooks.stopListening()
            // Unless a new conversation started meanwhile and is using the sound.
            if !isActive { hooks.releaseAudio() }
            if sayingGoodbye { sayGoodbye() }
        }
    }

    /// Something else took the sound (a call, Siri), or it couldn't be had: the conversation
    /// ends, and the screen says why.
    func stop(because reason: String) {
        guard isActive else { return }
        TalkLog.note("talk: stopped: \(reason)")
        problem = reason
        end(sayingGoodbye: false)
    }

    /// Clears the conversation from the screen.
    func clear() {
        end(sayingGoodbye: false)
        turns = []
        problem = nil
    }

    /* ---------------- the steps ---------------- */

    private func listen() {
        begun = true
        let current = generation
        listenCount += 1
        let id = listenCount
        phase = .listening
        TalkLog.note("talk: listening")
        Task {
            let heard = await hooks.listen()
            guard current == generation, phase == .listening, id == listenCount else {
                TalkLog.note("talk: a listen finished after the conversation moved on; ignored")
                return
            }
            handle(heard)
        }
    }

    private func handle(_ heard: Heard) {
        let said: String
        switch heard {
        case .unavailable(let reason):
            // The mic is off or can't recognize this language: nothing more can be heard.
            stop(because: reason)
            return
        case .glitch(let reason):
            glitchesInARow += 1
            TalkLog.note("talk: mic problem \(glitchesInARow) in a row: \(reason)")
            guard glitchesInARow < 2 else {
                stop(because: "\(reason) Tap the orb to try again.")
                return
            }
            let current = generation
            Task {
                if timing.retryPause > .zero { try? await Task.sleep(for: timing.retryPause) }
                guard current == generation, phase == .listening else { return }
                listen()
            }
            return
        case .nothing:
            glitchesInARow = 0
            said = ""
        case .words(let words, let firstWordsAfter):
            glitchesInARow = 0
            said = TalkFlow.removingEcho(of: lastSpoken, from: words, firstWordsAfter: firstWordsAfter)
            if said.isEmpty { TalkLog.note("talk: only heard Hera's own voice; treated as quiet") }
        }
        switch flow.heard(said) {
        case .listenAgain:
            TalkLog.note("talk: nothing heard (\(flow.quietInARow) in a row); listening again")
            listen()
        case .goodbye:
            TalkLog.note("talk: goodbye")
            let words = said.trimmingCharacters(in: .whitespacesAndNewlines)
            if !words.isEmpty { turns.append(TalkTurn(speaker: .person, text: words)) }
            finishConversation()
            sayGoodbye()
        case .send(let words):
            problem = nil
            turns.append(TalkTurn(speaker: .person, text: words))
            send(words)
        }
    }

    /// The conversation is over by its own rules (goodbye, a stop from the server): the mic has
    /// already stopped, so the sound is handed back at once.
    private func finishConversation() {
        generation += 1
        phase = .off
        watchdog?.cancel()
        hooks.releaseAudio()
    }

    private func send(_ words: String) {
        let current = generation
        phase = .thinking
        let previous = replyTask
        replyTask = Task {
            // An answer she was talked over may still be finishing on the server.
            await previous?.value
            guard current == generation else { return }
            replyCount += 1
            let id = replyCount
            live = LiveReply(id: id)
            TalkLog.note("talk: sending", said: words)
            let reply = await hooks.send(words, allowsWebSearch) { soFar in
                self.arrived(soFar, reply: id, generation: current)
            }
            switch reply {
            case .answer(let run): TalkLog.note("talk: answer \(run.text.count) chars, \(run.drafts.count) drafts, \(run.proposals.count) proposals")
            case .problem(let message): TalkLog.note("talk: problem: \(message)")
            case .stop(let message): TalkLog.note("talk: stop: \(message)")
            }
            guard current == generation, let done = live, done.id == id else { return }
            live = nil
            finish(reply, done, generation: current)
        }
    }

    /// More of the answer: shown as it grows, and each sentence said as soon as it's complete.
    private func arrived(_ soFar: String, reply id: Int, generation current: Int) {
        guard current == generation, var reply = live, reply.id == id, !soFar.isEmpty else { return }
        if let turn = reply.turn, let at = turns.firstIndex(where: { $0.id == turn }) {
            turns[at].text = soFar
        } else {
            let turn = TalkTurn(speaker: .hera, text: soFar)
            reply.turn = turn.id
            turns.append(turn)
        }
        if !reply.silenced {
            let ready = reply.sentences.take(soFar)
            if !ready.isEmpty, !reply.speaking {
                reply.speaking = true
                beginSpeaking(generation: current)
            }
            ready.forEach(hooks.continueReply)
            reply.said = ([reply.said] + ready).filter { !$0.isEmpty }.joined(separator: " ")
            // So talking over her now is checked against what she's actually been saying.
            if !ready.isEmpty { lastSpoken = reply.said }
        }
        live = reply
    }

    /// The whole answer is in: the turn shows all of it with what she made, and she says what
    /// she hasn't said yet (all of it, from a server that doesn't send it as it's written).
    private func finish(_ reply: TalkReply, _ done: LiveReply, generation current: Int) {
        var done = done
        let text: String
        var run: AgentRunResponse?
        var stops = false
        switch reply {
        case .answer(let answer):
            let answerText = answer.text.trimmingCharacters(in: .whitespacesAndNewlines)
            // Only drafts or proposals, no words: she still says something, so the person knows.
            text = answerText.isEmpty ? "Done. It's on your screen." : answer.text
            run = answer
        case .problem(let message):
            text = message
            problem = message
        case .stop(let message):
            text = message
            problem = message
            stops = true
        }
        if run != nil, let turn = done.turn, let at = turns.firstIndex(where: { $0.id == turn }) {
            turns[at].text = text
            turns[at].run = run
        } else {
            turns.append(TalkTurn(speaker: .hera, text: text, run: run))
        }
        // Talked over: the person is already speaking, so nothing more is said.
        guard !done.silenced else { return }
        // The conversation can't go on: she says why, and doesn't listen after. Anything she was
        // still saying stops first, so the sound is handed back with nothing playing.
        if stops {
            if done.speaking { hooks.stopSpeaking() }
            finishConversation()
            hooks.speak(text) {}
            return
        }
        if done.speaking {
            // A problem partway is said after what she already said.
            let rest = run != nil ? done.sentences.finish(text) : [text]
            rest.forEach(hooks.continueReply)
            lastSpoken = ([done.said] + rest).joined(separator: " ")
            hooks.endReply()
            // Only now is it known how much she has to say.
            armWatchdog(speech: speechCount, characters: lastSpoken.count, generation: current)
        } else {
            say(text)
        }
    }

    /// She starts saying an answer that's still arriving; once all of it has been heard, she listens.
    private func beginSpeaking(generation current: Int) {
        begun = true
        speechCount += 1
        let id = speechCount
        phase = .speaking
        TalkLog.note("talk: speaking the answer as it arrives")
        hooks.beginReply { [weak self] in
            self?.heardHerOut(speech: id, generation: current)
        }
    }

    /// Hera speaks, then listens for the answer.
    private func say(_ text: String) {
        begun = true
        let current = generation
        speechCount += 1
        let id = speechCount
        phase = .speaking
        lastSpoken = text
        TalkLog.note("talk: speaking \(text.count) chars")
        hooks.speak(text) { [weak self] in
            self?.heardHerOut(speech: id, generation: current)
        }
        armWatchdog(speech: id, characters: text.count, generation: current)
    }

    /// She finished saying something (or the watchdog gave up waiting): after a moment for the
    /// speaker to fall silent, the mic opens.
    private func heardHerOut(speech id: Int, generation current: Int) {
        guard current == generation, phase == .speaking, id == speechCount else { return }
        speechCount += 1
        let next = speechCount
        watchdog?.cancel()
        TalkLog.note("talk: Hera finished speaking")
        guard timing.echoTail > .zero else {
            listen()
            return
        }
        Task {
            try? await Task.sleep(for: timing.echoTail)
            // Talked over or ended during the pause: that already moved on.
            guard current == generation, phase == .speaking, next == speechCount else { return }
            listen()
        }
    }

    /// In case Hera's voice never says it's done (it failed partway, the sound was taken away),
    /// the conversation doesn't wait forever: after a generous time it stops her and listens.
    private func armWatchdog(speech id: Int, characters: Int, generation current: Int) {
        watchdog?.cancel()
        guard id == speechCount, phase == .speaking else { return }
        let allowance = timing.speechAllowance(characters: characters)
        watchdog = Task {
            try? await Task.sleep(for: allowance)
            guard !Task.isCancelled, current == generation, phase == .speaking, id == speechCount else { return }
            TalkLog.note("talk: Hera's voice never said it was done after \(allowance); listening anyway")
            hooks.stopSpeaking()
            heardHerOut(speech: id, generation: current)
        }
    }

    private func sayGoodbye() {
        turns.append(TalkTurn(speaker: .hera, text: TalkFlow.goodbye))
        hooks.speak(TalkFlow.goodbye) {}
    }
}
