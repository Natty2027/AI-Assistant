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

    @Test func repliesAreCleanedUpBeforeSpeaking() {
        #expect(HeraVoice.spokenText(from: "**Done!** See [your site](https://x.netlify.app).") == "Done! See your site.")
        #expect(HeraVoice.spokenText(from: "Live at https://x.netlify.app now") == "Live at the link now")
        #expect(HeraVoice.spokenText(from: "# Title\n\n`code`  here") == "Title code here")
        #expect(HeraVoice.spokenText(from: "  ") == "")
    }
}
