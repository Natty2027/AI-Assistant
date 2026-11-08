import Foundation
import KokoroCoreML
import Testing
@testable import CyberCompanion

struct VoiceTests {
    @Test func theVoiceShipsInsideTheApp() throws {
        let directory = try #require(HeraVoice.modelDirectory, "HeraVoice.bundle is missing from the app")
        let voices = try FileManager.default.contentsOfDirectory(atPath: directory.appending(path: "voices").path)
        #expect(voices == ["\(HeraVoice.voiceName).bin"])
    }

    /// End to end: the bundled files load and af_heart produces real audio.
    @Test(.timeLimit(.minutes(2))) func heraCanSpeak() throws {
        let directory = try #require(HeraVoice.modelDirectory)
        let engine = try KokoroEngine(modelDirectory: directory, forceCPU: true)
        let result = try engine.synthesize(text: "Hi, I'm Hera. Your site is ready.", voice: HeraVoice.voiceName)

        #expect(result.duration > 1)
        let allFinite = result.samples.allSatisfy(\.isFinite)
        let peak = result.samples.map(abs).max() ?? 0
        #expect(allFinite)
        #expect(peak > 0.01, "the audio is silent")
    }

    /// The whole spoken path, not just synthesis: Hera's own voice plays through the speaker,
    /// finishes, and says so (the "call Hera" conversation waits on that before listening).
    @Test(.timeLimit(.minutes(2))) @MainActor func heraSpeaksAloudAndFinishes() async {
        let voice = HeraVoice()
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            voice.speak("Hi, I'm Hera.") { done.resume() }
        }
        #expect(voice.phase == .idle)
        #expect(voice.problem == nil, "her own voice was used, not the system fallback")
    }

    /// "Talk to Hera" asks "website or posts?": one at a time, so both or neither means ask again.
    @Test func spokenAnswersPickWebsiteOrPosts() {
        #expect(ConversationReply.mode(from: "Let's make a website") == .site)
        #expect(ConversationReply.mode(from: "a landing page for my bakery") == .site)
        #expect(ConversationReply.mode(from: "Posts please") == .posts)
        #expect(ConversationReply.mode(from: "I want to announce my class on Instagram") == .posts)
        #expect(ConversationReply.mode(from: "both a website and some posts") == nil)
        #expect(ConversationReply.mode(from: "um, not sure") == nil)
        #expect(ConversationReply.mode(from: "") == nil)
    }

    @Test func repliesAreCleanedUpBeforeSpeaking() {
        #expect(HeraVoice.spokenText(from: "**Done!** See [your site](https://x.netlify.app).") == "Done! See your site.")
        #expect(HeraVoice.spokenText(from: "Live at https://x.netlify.app now") == "Live at the link now")
        #expect(HeraVoice.spokenText(from: "# Title\n\n`code`  here") == "Title code here")
        #expect(HeraVoice.spokenText(from: "  ") == "")
    }
}
