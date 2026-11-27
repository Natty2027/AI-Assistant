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
    private(set) var sent: [(String, Bool)] = []
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
    lazy var session = TalkSession(hooks: .init(
        listen: { [self] in
            if holdListening { return await withCheckedContinuation { (waiting: CheckedContinuation<String?, Never>) in listening = waiting } }
            return heard.isEmpty ? "" : heard.removeFirst()
        },
        stopListening: { [self] in releaseListening("") },
        speak: { [self] text, done in
            spoken.append(text)
            if holdSpeech { held = done } else { done() }
        },
        stopSpeaking: { [self] in
            stoppedSpeaking += 1
            held = nil
        },
        send: { [self] said, web in
            sent.append((said, web))
            return replies.isEmpty ? .problem("No reply") : replies.removeFirst()
        }
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
