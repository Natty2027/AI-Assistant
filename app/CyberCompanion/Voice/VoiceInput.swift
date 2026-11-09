import AVFoundation
import Foundation
import Observation
import Speech

/// Turns speech into prompt text with Apple's on-device recognition (SpeechAnalyzer). Audio never
/// leaves the device: the model runs locally, and only the finished text is ever sent anywhere,
/// when the person chooses to send their prompt.
@MainActor
@Observable
final class VoiceInput {
    enum State: Equatable {
        case idle
        case preparing(String)
        case listening
        case unavailable(String)
    }

    private(set) var state: State = .idle
    /// Text the recognizer has settled on.
    private(set) var finalizedText = ""
    /// The recognizer's current best guess for the words still being spoken; it may change.
    private(set) var volatileText = ""
    /// How loud the speaker is right now, 0 (silence) to 1, for the orb to react to.
    private(set) var level: Double = 0

    var transcript: String { finalizedText + volatileText }
    var isListening: Bool { state == .listening }

    private var engine: AVAudioEngine?
    private var pipe: AudioPipe?
    private var analyzer: SpeechAnalyzer?
    private var inputContinuation: AsyncStream<AnalyzerInput>.Continuation?
    private var resultsTask: Task<Void, Never>?

    func toggle() async {
        if isListening { await stop() } else { await start() }
    }

    func start() async {
        guard state == .idle || isUnavailable else { return }
        finalizedText = ""
        volatileText = ""

        guard await AVAudioApplication.requestRecordPermission() else {
            state = .unavailable("Microphone access is off. Turn it on in Settings to speak your request.")
            return
        }

        do {
            state = .preparing("Getting voice recognition ready…")
            let module = try await makeTranscriber()
            try await startListening(with: module)
            state = .listening
        } catch let error as VoiceError {
            await tearDown()
            state = .unavailable(error.message)
        } catch {
            await tearDown()
            state = .unavailable("Voice recognition couldn't start: \(error.localizedDescription)")
        }
    }

    /// Stops listening and waits for the recognizer to settle the last words.
    func stop() async {
        guard isListening else { return }
        state = .preparing("Finishing…")
        stopAudio()
        // The converter holds back a few milliseconds of audio between buffers; without this the
        // last word is often lost.
        pipe?.flush()
        pipe = nil
        inputContinuation?.finish()
        inputContinuation = nil
        try? await analyzer?.finalizeAndFinishThroughEndOfInput()
        await resultsTask?.value
        finalizedText += volatileText
        volatileText = ""
        resultsTask = nil
        analyzer = nil
        state = .idle
    }

    /// Hands-free listening for the spoken conversation: starts the mic, then stops on its own
    /// once the person has said something and gone quiet for about a second and a half (or after
    /// 8 seconds if they never start). Tapping the orb ends it early. Returns what was heard.
    func listenUntilSilence() async -> String {
        await start()
        guard isListening else { return "" }
        let began = ContinuousClock.now
        var lastSound = began
        var lastTranscript = transcript
        while isListening {
            try? await Task.sleep(for: .milliseconds(200))
            let now = ContinuousClock.now
            // New words or a voice-level signal both count as still talking.
            if level > 0.3 || transcript != lastTranscript { lastSound = now }
            lastTranscript = transcript
            let heardWords = !transcript.trimmingCharacters(in: .whitespaces).isEmpty
            if heardWords && now - lastSound > .milliseconds(1500) { break }
            if !heardWords && now - began > .seconds(8) { break }
        }
        await stop()
        return transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var isUnavailable: Bool {
        if case .unavailable = state { return true }
        return false
    }

    /* ---------------- setup ---------------- */

    private enum Transcriber {
        case speech(SpeechTranscriber)
        case dictation(DictationTranscriber)

        var module: any SpeechModule {
            switch self {
            case .speech(let t): t
            case .dictation(let t): t
            }
        }
    }

    private struct VoiceError: Error { let message: String }

    /// SpeechTranscriber is the newer, more accurate model; older devices only have the dictation
    /// model, which Apple recommends as the fallback.
    ///
    /// Both are set up for accuracy over speed. The "progressive" SpeechTranscriber preset adds
    /// fastResults, which Apple documents as "faster but also less accurate", so only volatile
    /// results are kept (the live preview while speaking). Short dictation finalizes early and
    /// less accurately; long dictation is what Apple's live-audio sample uses.
    private func makeTranscriber() async throws -> Transcriber {
        let transcriber: Transcriber
        if let locale = await SpeechTranscriber.supportedLocale(equivalentTo: .current) {
            transcriber = .speech(Self.speechTranscriber(locale: locale))
        } else if let locale = await DictationTranscriber.supportedLocale(equivalentTo: .current) {
            transcriber = .dictation(DictationTranscriber(locale: locale, preset: .progressiveLongDictation))
        } else {
            throw VoiceError(message: "Voice recognition isn't available for your language on this device yet. You can still type your request.")
        }

        // The model is downloaded once and shared with other apps; this returns at once if it's there.
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber.module]) {
            state = .preparing("Downloading the voice model (one time only)…")
            try await request.downloadAndInstall()
        }
        return transcriber
    }

    /// The main recognizer's settings, shared with the end-to-end recognition test.
    nonisolated static func speechTranscriber(locale: Locale) -> SpeechTranscriber {
        SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
    }

    private func startListening(with transcriber: Transcriber) async throws {
        let module = transcriber.module
        guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]) else {
            throw VoiceError(message: "The voice model isn't installed yet. Check your internet connection and try again.")
        }

        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .spokenAudio, options: [.duckOthers])
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        #endif

        let analyzer = SpeechAnalyzer(modules: [module])
        let (inputs, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
        self.analyzer = analyzer
        self.inputContinuation = continuation

        resultsTask = Task { [weak self] in
            await self?.collectResults(from: transcriber)
        }
        // Load the model now rather than on the first audio, so the opening words aren't delayed.
        try await analyzer.prepareToAnalyze(in: analyzerFormat)
        try await analyzer.start(inputSequence: inputs)

        let engine = AVAudioEngine()
        let pipe = AudioPipe(inputFormat: engine.inputNode.outputFormat(forBus: 0), analyzerFormat: analyzerFormat, continuation: continuation) { [weak self] level in
            Task { @MainActor in self?.level = level }
        }
        pipe.install(on: engine.inputNode)
        engine.prepare()
        try engine.start()
        self.engine = engine
        self.pipe = pipe
    }

    private func collectResults(from transcriber: Transcriber) async {
        do {
            switch transcriber {
            case .speech(let t):
                for try await result in t.results { apply(String(result.text.characters), isFinal: result.isFinal) }
            case .dictation(let t):
                for try await result in t.results { apply(String(result.text.characters), isFinal: result.isFinal) }
            }
        } catch {
            // The stream ends with an error if recognition fails partway; keep what was heard.
        }
    }

    private func apply(_ text: String, isFinal: Bool) {
        if isFinal {
            finalizedText += text
            volatileText = ""
        } else {
            volatileText = text
        }
    }

    private func stopAudio() {
        level = 0
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }

    private func tearDown() async {
        stopAudio()
        pipe = nil
        inputContinuation?.finish()
        inputContinuation = nil
        await analyzer?.cancelAndFinishNow()
        analyzer = nil
        resultsTask?.cancel()
        resultsTask = nil
    }
}

/// Converts microphone buffers to the format the analyzer needs and feeds them in. It lives
/// outside the main actor because the audio engine calls the tap on its own real-time thread.
/// Tests feed it synthesized speech directly, to check recognition end to end.
final class AudioPipe: @unchecked Sendable {
    private let converter: AVAudioConverter?
    private let inputFormat: AVAudioFormat
    private let analyzerFormat: AVAudioFormat
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private let onLevel: @Sendable (Double) -> Void

    init(inputFormat: AVAudioFormat, analyzerFormat: AVAudioFormat, continuation: AsyncStream<AnalyzerInput>.Continuation,
         onLevel: @escaping @Sendable (Double) -> Void) {
        self.onLevel = onLevel
        self.inputFormat = inputFormat
        self.analyzerFormat = analyzerFormat
        self.continuation = continuation
        // The analyzer doesn't resample on its own, so convert unless the formats already match.
        let converter = inputFormat == analyzerFormat ? nil : AVAudioConverter(from: inputFormat, to: analyzerFormat)
        // As in Apple's speech sample: no priming, so converted audio isn't shifted against the
        // original at the start of each recording.
        converter?.primeMethod = .none
        self.converter = converter
    }

    func install(on node: AVAudioInputNode) {
        node.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [self] buffer, _ in
            feed(buffer)
        }
    }

    /// One buffer of audio in the input format: measured for the orb, converted, sent on.
    func feed(_ buffer: AVAudioPCMBuffer) {
        onLevel(Self.level(of: buffer))
        if let converted = convert(buffer) {
            continuation.yield(AnalyzerInput(buffer: converted))
        }
    }

    /// Sends on whatever audio the converter is still holding (resampling keeps a little back
    /// between buffers). Call once, after the tap is removed and the engine has stopped.
    func flush() {
        guard let converter else { return }
        // A resampler holds back far less than this; 100 ms of room is plenty.
        let capacity = AVAudioFrameCount(analyzerFormat.sampleRate / 10)
        guard capacity > 0, let output = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity) else { return }
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, inputStatus in
            inputStatus.pointee = .endOfStream
            return nil
        }
        if status != .error, output.frameLength > 0 {
            continuation.yield(AnalyzerInput(buffer: output))
        }
    }

    /// Loudness of one buffer, mapped from about -50 dB (quiet room) to 0 dB onto 0...1.
    private static func level(of buffer: AVAudioPCMBuffer) -> Double {
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        let count = Int(buffer.frameLength)
        var sum: Float = 0
        for i in 0..<count { sum += samples[i] * samples[i] }
        let rms = (sum / Float(count)).squareRoot()
        let decibels = 20 * log10(max(rms, 1e-6))
        return Double(min(max((decibels + 50) / 50, 0), 1))
    }

    private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let converter else { return buffer }
        let ratio = analyzerFormat.sampleRate / inputFormat.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up))
        guard capacity > 0, let output = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity) else { return nil }

        var consumed = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, inputStatus in
            if consumed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, output.frameLength > 0 else { return nil }
        return output
    }
}
