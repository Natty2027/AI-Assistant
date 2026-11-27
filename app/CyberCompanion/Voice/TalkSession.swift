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

/// One thing said in the conversation. Hera's turns can carry what she made (`run`), shown as the
/// usual cards so the person can approve it while the conversation goes on.
struct TalkTurn: Identifiable, Equatable {
    enum Speaker: Equatable { case person, hera }

    let id = UUID()
    let speaker: Speaker
    let text: String
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

/// Runs the conversation: when to listen, speak, send and stop. The mic, Hera's voice and the
/// server are passed in, so tests drive it with stand-ins.
@MainActor
@Observable
final class TalkSession {
    struct Hooks {
        /// Listens until the person goes quiet. nil when the mic can't listen at all.
        var listen: @MainActor () async -> String?
        var stopListening: @MainActor () async -> Void
        /// Speaks, then calls back once finished on its own (not when stopped). Calls back at
        /// once when Hera's voice is off in Settings: the reply is shown instead.
        var speak: @MainActor (String, @escaping @MainActor () -> Void) -> Void
        var stopSpeaking: @MainActor () -> Void
        /// Sends what was said; the flag allows web search for this turn.
        var send: @MainActor (String, Bool) async -> TalkReply
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
    var isActive: Bool { phase != .off }
    /// The composer's Web search switch, read for every turn.
    var allowsWebSearch = false

    private let hooks: Hooks
    private var flow = TalkFlow()
    /// Bumped whenever a conversation starts or ends, so an answer or a listen that finishes
    /// after that is ignored.
    private var generation = 0

    init(hooks: Hooks) {
        self.hooks = hooks
    }

    /// Starts a new conversation. `greet` has Hera say hello first (from Siri); otherwise she
    /// listens at once, because the person tapped the orb to speak.
    func start(greet: Bool) {
        guard !isActive else { return }
        generation += 1
        flow = TalkFlow()
        turns = []
        if greet { say(TalkFlow.greeting) } else { listen() }
    }

    /// The orb: while Hera speaks it interrupts her and listens straight away; otherwise it ends
    /// the conversation.
    func tapOrb() {
        switch phase {
        case .off: start(greet: false)
        case .speaking:
            hooks.stopSpeaking()
            listen()
        case .listening, .thinking: end(sayingGoodbye: false)
        }
    }

    /// Stops listening and speaking. The conversation stays on screen until a new one starts.
    func end(sayingGoodbye: Bool) {
        guard isActive else { return }
        generation += 1
        phase = .off
        hooks.stopSpeaking()
        Task {
            await hooks.stopListening()
            if sayingGoodbye { sayGoodbye() }
        }
    }

    /// Clears the conversation from the screen.
    func clear() {
        end(sayingGoodbye: false)
        turns = []
    }

    /* ---------------- the steps ---------------- */

    private func listen() {
        let current = generation
        phase = .listening
        Task {
            let heard = await hooks.listen()
            guard current == generation, phase == .listening else { return }
            guard let heard else {
                // The mic is off or failed; the screen says why.
                end(sayingGoodbye: false)
                return
            }
            handle(heard)
        }
    }

    private func handle(_ heard: String) {
        switch flow.heard(heard) {
        case .listenAgain:
            listen()
        case .goodbye:
            if !heard.isEmpty { turns.append(TalkTurn(speaker: .person, text: heard)) }
            generation += 1
            phase = .off
            sayGoodbye()
        case .send(let words):
            turns.append(TalkTurn(speaker: .person, text: words))
            send(words)
        }
    }

    private func send(_ words: String) {
        let current = generation
        phase = .thinking
        Task {
            let reply = await hooks.send(words, allowsWebSearch)
            guard current == generation else { return }
            switch reply {
            case .answer(let run):
                let text = run.text.isEmpty ? "Done. It's on your screen." : run.text
                turns.append(TalkTurn(speaker: .hera, text: text, run: run))
                say(text)
            case .problem(let message):
                turns.append(TalkTurn(speaker: .hera, text: message))
                say(message)
            case .stop(let message):
                turns.append(TalkTurn(speaker: .hera, text: message))
                generation += 1
                phase = .off
                hooks.speak(message) {}
            }
        }
    }

    /// Hera speaks, then listens for the answer.
    private func say(_ text: String) {
        let current = generation
        phase = .speaking
        hooks.speak(text) { [weak self] in
            guard let self, current == generation, phase == .speaking else { return }
            listen()
        }
    }

    private func sayGoodbye() {
        turns.append(TalkTurn(speaker: .hera, text: TalkFlow.goodbye))
        hooks.speak(TalkFlow.goodbye) {}
    }
}
