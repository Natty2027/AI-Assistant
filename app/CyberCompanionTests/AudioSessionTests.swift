import AVFoundation
import Testing
@testable import CyberCompanion

/// The microphone's audio-session setup, on iOS itself. Builds 2 and 3 asked for an option the
/// record category doesn't allow, and iOS refused with OSStatus -50 before the mic could start.
/// The Mac has no audio session, so this needs an iOS run. Note the simulator is more lenient than
/// a real iPhone (it accepted the broken setting too), so this proves the setting works rather than
/// reproducing the old failure.
#if os(iOS)
@MainActor
struct AudioSessionTests {
    @Test func theMicrophoneSessionIsAcceptedAndTheMicStarts() throws {
        try VoiceInput.activateSessionForListening()
        let session = AVAudioSession.sharedInstance()
        #expect(session.category == .playAndRecord)

        let engine = AVAudioEngine()
        let format = engine.inputNode.outputFormat(forBus: 0)
        #expect(format.sampleRate > 0, "no microphone input after the session started")
        engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: format) { _, _ in }
        engine.prepare()
        try engine.start()
        #expect(engine.isRunning)
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        try session.setActive(false, options: .notifyOthersOnDeactivation)
    }

}
#endif
