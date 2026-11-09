import AVFoundation
import Speech
import Testing
@testable import CyberCompanion

/// Voice recognition end to end, minus the microphone: a sentence spoken by the system voice goes
/// through the app's own converter (AudioPipe) and recognizer settings, and must come back as
/// text. Apple's speech models don't run in the iOS Simulator, so this runs on the Mac.
#if os(macOS)
@MainActor
struct RecognitionTests {
    @Test(.timeLimit(.minutes(5))) func spokenWordsBecomeText() async throws {
        let locale = try #require(await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en_US")))
        let transcriber = VoiceInput.speechTranscriber(locale: locale)
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
        let analyzerFormat = try #require(await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]))

        let speech = try await Self.synthesize("Make a website for my bakery on Main Street.")
        let inputFormat = try #require(speech.first?.format)

        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let (inputs, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
        let results = Task {
            var text = ""
            for try await result in transcriber.results where result.isFinal {
                text += String(result.text.characters)
            }
            return text
        }
        try await analyzer.prepareToAnalyze(in: analyzerFormat)
        try await analyzer.start(inputSequence: inputs)

        let pipe = AudioPipe(inputFormat: inputFormat, analyzerFormat: analyzerFormat, continuation: continuation) { _ in }
        for buffer in speech { pipe.feed(buffer) }
        pipe.flush()
        continuation.finish()
        try await analyzer.finalizeAndFinishThroughEndOfInput()

        let heard = try await results.value.lowercased()
        #expect(heard.contains("website"), "heard: \(heard)")
        #expect(heard.contains("bakery"), "heard: \(heard)")
    }

    /// The system voice saying `text`, as PCM buffers in whatever format it produces.
    private static func synthesize(_ text: String) async throws -> [AVAudioPCMBuffer] {
        let synthesizer = AVSpeechSynthesizer()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        let collected = await withCheckedContinuation { (done: CheckedContinuation<CollectedBuffers, Never>) in
            let collected = CollectedBuffers()
            synthesizer.write(utterance) { buffer in
                // An empty buffer marks the end; the synthesizer can send more than one.
                guard let pcm = buffer as? AVAudioPCMBuffer, pcm.frameLength > 0 else {
                    guard !collected.finished else { return }
                    collected.finished = true
                    withExtendedLifetime(synthesizer) { done.resume(returning: collected) }
                    return
                }
                collected.buffers.append(pcm)
            }
        }
        return collected.buffers
    }
}

/// Buffers gathered on the synthesizer's callback thread, handed over once it's finished.
private final class CollectedBuffers: @unchecked Sendable {
    var buffers: [AVAudioPCMBuffer] = []
    var finished = false
}
#endif
