import Foundation
import Testing
@testable import CyberCompanion

/// Talk: the spoken back-and-forth with Hera. The rules (when it ends) and the loop itself, driven
/// by a stand-in mic, voice and server. The real mic and speech recognition need a device.
struct TalkFlowTests {
    @Test(arguments: [
        "bye", "Bye!", "Goodbye.", "Bye bye Hera", "That's all", "thats it", "Thanks Hera, that's it.",
        "OK, that's all for now, thanks!", "Stop", "Stop listening", "No thanks", "I'm done", "Thank you, goodbye",
        "Okay bye", "That\u{2019}s everything", "Never mind", "good night Hera", "All set, thanks",
    ])
    func goodbyesEndTheConversation(said: String) {
        #expect(TalkFlow.isGoodbye(said))
    }

    @Test(arguments: [
        "", "Thanks", "Thank you Hera", "Stop my 9 o'clock reminder", "Write a text to Sam saying bye",
        "Is that all I have today?", "What's the weather like?", "No", "Hi Hera", "Done with the poster? Make it blue",
        "Okay make the email shorter",
    ])
    func everythingElseIsSentToHera(said: String) {
        #expect(!TalkFlow.isGoodbye(said))
    }

    @Test func silenceTwiceInARowSaysGoodbye() {
        var flow = TalkFlow()
        #expect(flow.heard("") == .listenAgain)
        #expect(flow.heard("  ") == .goodbye)
    }

    @Test func speakingResetsTheQuietCount() {
        var flow = TalkFlow()
        #expect(flow.heard("") == .listenAgain)
        #expect(flow.heard(" What's on today? ") == .send("What's on today?"))
        #expect(flow.heard("") == .listenAgain, "one quiet listen after speaking doesn't end it")
        #expect(flow.heard("Thanks Hera, that's it") == .goodbye)
    }

    @Test func questionsAboutTheDayAskForTheCalendar() {
        #expect(TalkFlow.mentionsSchedule("Hi Hera, what's on my day?"))
        #expect(TalkFlow.mentionsSchedule("Remind me to call Mom at 5"))
        #expect(TalkFlow.mentionsSchedule("Am I free tomorrow afternoon?"))
        #expect(!TalkFlow.mentionsSchedule("Write a post about my bakery"))
        #expect(!TalkFlow.mentionsSchedule("Who won the game last night?"))
    }
}

/// A stand-in for the mic, Hera's voice and the server, answering from a script.
@MainActor
private final class StandIn {
    /// What the person "says", one per listen. Empty when they say nothing; nil when the mic fails.
    var heard: [String?] = []
    var replies: [TalkReply] = []
    /// For each reply in turn, the answer so far as a streaming server would send it. A reply
    /// without one arrives all at once, like an older server.
    var streams: [[String]] = []
    private(set) var sent: [(String, Bool)] = []
    /// Each answer said a sentence at a time: the sentences, in order. Ended once endReply runs.
    private(set) var replySentences: [[String]] = []
    private(set) var repliesEnded = 0
    private var replyDone: (@MainActor () -> Void)?
    /// When set, the server holds each answer (after streaming it) until released.
    var holdReplies = false
    private var replyGate: CheckedContinuation<Void, Never>?

    var isHoldingReply: Bool { replyGate != nil }

    private func answer(_ said: String, _ web: Bool, _ onText: @escaping @MainActor (String) -> Void) async -> TalkReply {
        sent.append((said, web))
        for soFar in streams.isEmpty ? [] : streams.removeFirst() {
            onText(soFar)
            await Task.yield()
        }
        if holdReplies { await waitForRelease() }
        return replies.isEmpty ? .problem("No reply") : replies.removeFirst()
    }

    private func waitForRelease() async {
        await withCheckedContinuation { (gate: CheckedContinuation<Void, Never>) in replyGate = gate }
    }

    func releaseReply() {
        replyGate?.resume()
        replyGate = nil
    }
    private(set) var spoken: [String] = []
    private(set) var stoppedSpeaking = 0
    /// When true, speaking doesn't finish on its own, so the test can interrupt it.
    var holdSpeech = false
    private var held: (@MainActor () -> Void)?
    /// When set, a listen waits here until released.
    var holdListening = false
    private var listening: CheckedContinuation<String?, Never>?

    func finishSpeaking() {
        let done = held
        held = nil
        done?()
    }

    func releaseListening(_ said: String?) {
        listening?.resume(returning: said)
        listening = nil
    }

    var isWaitingToListen: Bool { listening != nil }

    // Held strongly: the session's last steps can run after a test returns, and must find this.
    lazy var session: TalkSession = TalkSession(hooks: TalkSession.Hooks(
        listen: { [self] in
            if holdListening { return await withCheckedContinuation { (waiting: CheckedContinuation<String?, Never>) in listening = waiting } }
            return heard.isEmpty ? "" : heard.removeFirst()
        },
        stopListening: { [self] in releaseListening("") },
        speak: { [self] text, done in
            spoken.append(text)
            if holdSpeech { held = done } else { done() }
        },
        beginReply: { [self] done in
            replySentences.append([])
            replyDone = done
        },
        continueReply: { [self] sentence in replySentences[replySentences.count - 1].append(sentence) },
        endReply: { [self] in
            repliesEnded += 1
            let done = replyDone
            replyDone = nil
            if holdSpeech { held = done } else { done?() }
        },
        stopSpeaking: { [self] in
            stoppedSpeaking += 1
            held = nil
            replyDone = nil
        },
        send: { [self] said, web, onText in await answer(said, web, onText) }
    ))
}

private func answer(_ text: String) throws -> TalkReply {
    let json = #"{"status":"done","text":"\#(text)","tainted":false,"proposals":[],"drafts":[],"conversationId":"c1"}"#
    return .answer(try JSONDecoder().decode(AgentRunResponse.self, from: Data(json.utf8)))
}

/// Lets the session's tasks run until `condition` holds (or a second passes).
@MainActor
private func settle(_ condition: () -> Bool) async {
    for _ in 0..<1000 where !condition() {
        try? await Task.sleep(for: .milliseconds(1))
    }
}

@MainActor
struct TalkSessionTests {
    @Test func aConversationGoesBackAndForthUntilGoodbye() async throws {
        let world = StandIn()
        world.heard = ["What's the weather like?", "And tomorrow?", "Thanks Hera, that's it"]
        world.replies = [try answer("Sunny and 70 today."), try answer("Rain tomorrow, so bring an umbrella.")]
        world.session.allowsWebSearch = true
        world.session.start(greet: true)
        await settle { !world.session.isActive }

        #expect(world.sent.map { $0.0 } == ["What's the weather like?", "And tomorrow?"], "every turn goes to Hera in order")
        #expect(world.sent.allSatisfy { $0.1 }, "web search follows the switch")
        #expect(world.spoken == [TalkFlow.greeting, "Sunny and 70 today.", "Rain tomorrow, so bring an umbrella.", TalkFlow.goodbye])
        #expect(world.session.turns.map(\.speaker) == [.person, .hera, .person, .hera, .person, .hera])
        #expect(world.session.turns.last?.text == TalkFlow.goodbye)
        #expect(world.session.turns[1].run?.text == "Sunny and 70 today.", "Hera's turn carries what she made, for its cards")
    }

    @Test func fromTheOrbHeraListensFirst() async throws {
        let world = StandIn()
        world.heard = ["Write a text to Sam", "bye"]
        world.replies = [try answer("Done. It's on your screen.")]
        world.session.start(greet: false)
        await settle { !world.session.isActive }
        #expect(world.spoken.first == "Done. It's on your screen.", "no greeting: the person tapped to speak")
        #expect(world.sent.map { $0.0 } == ["Write a text to Sam"])
    }

    @Test func silenceTwiceEndsWithAGoodbye() async {
        let world = StandIn()
        world.session.start(greet: false)
        await settle { !world.session.isActive }
        #expect(world.sent.isEmpty)
        #expect(world.spoken == [TalkFlow.goodbye])
    }

    @Test func aProblemIsSaidAndTheConversationCarriesOn() async throws {
        let world = StandIn()
        world.heard = ["What's new?", "Try again", "bye"]
        world.replies = [.problem("I can't reach Hera right now."), try answer("All good now.")]
        world.session.start(greet: false)
        await settle { !world.session.isActive }
        #expect(world.spoken == ["I can't reach Hera right now.", "All good now.", TalkFlow.goodbye])
    }

    @Test func aStopEndsTheConversationAfterSayingWhy() async {
        let world = StandIn()
        world.heard = ["Make a poster", "this is never heard"]
        world.replies = [.stop("First, tap Allow AI.")]
        world.session.start(greet: false)
        await settle { !world.session.isActive }
        #expect(world.spoken == ["First, tap Allow AI."])
        #expect(world.heard == ["this is never heard"], "Hera stopped listening")
    }

    @Test func aMicThatCantListenEndsQuietly() async {
        let world = StandIn()
        world.heard = [nil]
        world.session.start(greet: false)
        await settle { !world.session.isActive }
        #expect(world.spoken.isEmpty)
        #expect(world.session.turns.isEmpty)
    }

    @Test func tappingTheOrbWhileHeraSpeaksInterruptsHerAndListens() async throws {
        let world = StandIn()
        world.holdSpeech = true
        world.session.start(greet: true)
        #expect(world.session.phase == .speaking)
        world.holdListening = true
        world.session.tapOrb()
        #expect(world.stoppedSpeaking == 1)
        #expect(world.session.phase == .listening)
        await settle { world.isWaitingToListen }
        // Then the orb again while listening ends the conversation, without a goodbye.
        world.session.tapOrb()
        #expect(!world.session.isActive)
        await settle { !world.isWaitingToListen }
        #expect(world.spoken == [TalkFlow.greeting])
    }

    @Test func anAnswerThatArrivesAfterEndIsIgnored() async throws {
        let world = StandIn()
        world.holdListening = true
        world.session.start(greet: false)
        await settle { world.isWaitingToListen }
        world.session.end(sayingGoodbye: false)
        await settle { !world.isWaitingToListen }
        #expect(world.sent.isEmpty, "what the mic heard as it stopped isn't sent")
        #expect(world.session.phase == .off)
    }

    @Test func aStreamedAnswerIsSaidSentenceBySentenceAndShownAsItGrows() async throws {
        let world = StandIn()
        world.heard = ["What's the weather?", "bye"]
        let full = "It's sunny and 70 today. Rain comes tomorrow, so bring an umbrella. Anything else?"
        world.streams = [["It's sunny", "It's sunny and 70 today. Ra", "It's sunny and 70 today. Rain comes tomorrow, so bring an umbrella.", full]]
        world.replies = [try answer(full)]
        world.session.start(greet: false)
        await settle { !world.session.isActive }

        #expect(world.replySentences == [["It's sunny and 70 today.", "Rain comes tomorrow, so bring an umbrella.", "Anything else?"]],
                "each sentence once, in order, the last one when the answer is done")
        #expect(world.repliesEnded == 1)
        #expect(world.spoken == [TalkFlow.goodbye], "nothing said twice through the all-at-once path")
        #expect(world.session.turns.map(\.speaker) == [.person, .hera, .person, .hera], "one turn for the streamed answer")
        #expect(world.session.turns[1].text == full)
        #expect(world.session.turns[1].run?.text == full, "the finished turn carries what she made")
    }

    @Test func heraListensAgainOnlyAfterTheLastSentenceIsHeard() async throws {
        let world = StandIn()
        world.holdSpeech = true
        world.heard = ["Hi", "bye"]
        world.streams = [["Hello there. How", "Hello there. How are you?"]]
        world.replies = [try answer("Hello there. How are you?")]
        world.session.start(greet: false)
        await settle { world.repliesEnded == 1 }
        #expect(world.session.phase == .speaking, "still speaking: the last sentence hasn't been heard")
        #expect(world.heard == ["bye"], "not listening yet")
        world.holdSpeech = false
        world.finishSpeaking()
        await settle { !world.session.isActive }
        #expect(world.heard.isEmpty, "then she listened")
    }

    @Test func talkingOverAStreamingAnswerStopsTheRestOfIt() async throws {
        let world = StandIn()
        world.holdSpeech = true
        world.holdListening = true
        world.heard = []
        world.session.start(greet: false)
        await settle { world.isWaitingToListen }
        world.streams = [["One. Two. Three"]]
        world.replies = [try answer("One. Two. Three. Four.")]
        world.holdReplies = true
        world.releaseListening("Count to four")
        await settle { world.isHoldingReply }
        #expect(world.session.phase == .speaking)
        world.session.tapOrb()
        #expect(world.stoppedSpeaking == 1)
        #expect(world.session.phase == .listening)
        world.releaseReply()
        await settle { world.session.turns.last?.run != nil }
        #expect(world.replySentences == [["One.", "Two."]], "nothing more is said once she's talked over")
        #expect(world.repliesEnded == 0)
        #expect(world.session.turns.last?.text == "One. Two. Three. Four.", "the screen still shows all of it")
        world.session.end(sayingGoodbye: false)
    }

    @Test func aProblemPartwayIsSaidAfterWhatWasAlreadySaid() async throws {
        let world = StandIn()
        world.heard = ["Write an email", "bye"]
        world.streams = [["Sure, writing it now. It"]]
        world.replies = [.problem("That didn't go through. Please say it again.")]
        world.session.start(greet: false)
        await settle { !world.session.isActive }
        #expect(world.replySentences == [["Sure, writing it now.", "That didn't go through. Please say it again."]])
    }

    @Test func clearRemovesTheConversation() async throws {
        let world = StandIn()
        world.heard = ["Hi", "bye"]
        world.replies = [try answer("Hi! What can I do for you?")]
        world.session.start(greet: false)
        await settle { !world.session.isActive }
        #expect(!world.session.turns.isEmpty)
        world.session.clear()
        #expect(world.session.turns.isEmpty)
    }
}

/// Cutting Hera's answer into sentences as it arrives, so she can start speaking early.
struct SpokenSentencesTests {
    @Test func onlyCompleteSentencesAreHandedOverAndTheTailWaits() {
        var spoken = SpokenSentences()
        #expect(spoken.take("Sure") == [])
        #expect(spoken.take("Sure.") == [], "a full stop alone could still be 3.5 or e.g.")
        #expect(spoken.take("Sure. I'll") == ["Sure."])
        #expect(spoken.take("Sure. I'll write it! Is Fri") == ["I'll write it!"])
        #expect(spoken.take("Sure. I'll write it! Is Friday at 9.30 okay? ") == ["Is Friday at 9.30 okay?"])
        #expect(spoken.finish("Sure. I'll write it! Is Friday at 9.30 okay? Or later") == ["Or later"])
    }

    @Test func severalSentencesAtOnceComeOutSeparately() {
        var spoken = SpokenSentences()
        #expect(spoken.take("One. Two? Three! Four") == ["One.", "Two?", "Three!"])
        #expect(spoken.finish("One. Two? Three! Four") == ["Four"])
    }

    @Test func lineBreaksEndASentence() {
        var spoken = SpokenSentences()
        #expect(spoken.take("I'll write that email.\nIt's on your") == ["I'll write that email."])
        #expect(spoken.take("Done\nNext") == [], "a different answer than the one already said")
    }

    @Test func abbreviationsAndNumbersDontEndASentence() {
        #expect(SpokenSentences.sentences(in: "Dr. Lee sees you at 3.15 tomorrow. Bring e.g. your card.")
                == ["Dr. Lee sees you at 3.15 tomorrow.", "Bring e.g. your card."])
        #expect(SpokenSentences.sentences(in: "He said \"Go.\" Then he left. Wow...  really?! Yes")
                == ["He said \"Go.\"", "Then he left.", "Wow...", "really?!", "Yes"])
    }

    @Test func anAnswerThatChangedIsntSaidAgain() {
        var spoken = SpokenSentences()
        #expect(spoken.take("Lost words. That") == ["Lost words."])
        // The server tried the step again: what comes now doesn't continue what was said.
        #expect(spoken.take("Here you go. Enjoy") == [])
        #expect(spoken.diverged)
        #expect(spoken.take("Lost words. That's all.") == [], "once changed, only the finished answer decides")
        #expect(spoken.finish("Here you go. Enjoy.") == [], "not a continuation: the screen shows it instead")
    }

    @Test func theWholeAnswerAtTheEndIsSaidInFullWhenNothingCameBefore() {
        var spoken = SpokenSentences()
        #expect(spoken.finish("All done. It's on your screen.") == ["All done.", "It's on your screen."])
    }
}

/// When a pause means the person has finished speaking.
struct EndOfSpeechTests {
    @Test func aSettledFinishedSentenceEndsSooner() {
        #expect(EndOfSpeech.quietNeeded(finalized: "What's on my day tomorrow?", volatile: "") == EndOfSpeech.settled)
        #expect(EndOfSpeech.quietNeeded(finalized: "Write a post about the sale", volatile: "") == EndOfSpeech.settled)
        #expect(EndOfSpeech.settled == .milliseconds(800))
    }

    @Test func wordsStillBeingRecognizedWaitLonger() {
        #expect(EndOfSpeech.quietNeeded(finalized: "Write a post", volatile: " about the") == EndOfSpeech.unsettled)
        #expect(EndOfSpeech.quietNeeded(finalized: "", volatile: "Hello") == EndOfSpeech.unsettled)
        #expect(EndOfSpeech.quietNeeded(finalized: "", volatile: "") == EndOfSpeech.unsettled)
        #expect(EndOfSpeech.unsettled == .milliseconds(1400))
    }

    @Test(arguments: ["Remind me to call Sam and", "Write a text but", "Um", "So", "Make a poster, um", "Book it for Friday,",
                      "Email the team about the"])
    func unfinishedThoughtsWaitLonger(said: String) {
        #expect(EndOfSpeech.quietNeeded(finalized: said, volatile: "") == EndOfSpeech.unsettled)
    }

    @Test func wordsIgnorePunctuationAndCapitals() {
        #expect(EndOfSpeech.words("Hello, Hera.") == EndOfSpeech.words("hello hera"))
        #expect(EndOfSpeech.words("What's up?") == ["what's", "up"])
    }
}
