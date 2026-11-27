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
    private var configurationObserver: (any NSObjectProtocol)?
    /// Buffers of sound the mic has delivered since it started, to tell a mic that started with
    /// no sound coming in from one that's just hearing a quiet room.
    private var buffersHeard = 0
    /// Set when the mic stopped delivering sound partway (the route or format changed).
    private var micChanged = false
    /// stop() was asked for while the mic was still starting: it stops as soon as it's started.
    private var stopRequested = false
    /// stop() is settling the last words; a new start waits for it.
    private var isFinishing = false
    /// The recognizer's language model is installed (checked once, not every turn).
    private var assetsReady = false

    func toggle() async {
        if isListening { await stop() } else { await start() }
    }

    func start() async {
        // A stop that's still settling the last words (the orb tapped twice quickly) finishes first.
        for _ in 0..<60 where isFinishing { try? await Task.sleep(for: .milliseconds(50)) }
        guard state == .idle || isUnavailable else {
            TalkLog.note("mic: start skipped, state \(state)")
            return
        }
        finalizedText = ""
        volatileText = ""
        stopRequested = false
        micChanged = false
        buffersHeard = 0
        lastStartProblem = nil
        // Preparing from here, so a stop during the permission prompt is remembered.
        state = .preparing("Getting voice recognition ready…")

        guard await AVAudioApplication.requestRecordPermission() else {
            TalkLog.note("mic: permission denied")
            state = .unavailable(Self.micOffMessage)
            return
        }

        do {
            let module = try await makeTranscriber()
            try await startListening(with: module)
            state = .listening
            TalkLog.note("mic: listening")
            if stopRequested { await stop() }
        } catch let error as VoiceError {
            await tearDown()
            TalkLog.note("mic: couldn't start: \(error.message)")
            state = .unavailable(error.message)
            if error.canRetry { lastStartProblem = error.message }
        } catch {
            await tearDown()
            TalkLog.note("mic: couldn't start: \(error.localizedDescription)")
            state = .unavailable("Voice recognition couldn't start: \(error.localizedDescription)")
        }
    }

    /// Why the last start failed in a way worth trying again (the mic had no sound yet). Read
    /// by a hands-free listen; the composer's mic shows nothing for it and can simply be tapped again.
    private var lastStartProblem: String?

    static let micOffMessage = "Microphone access is off for Hera. To talk with her, open the Settings app, tap Apps, then Hera, and turn on Microphone."

    /// Stops listening and waits for the recognizer to settle the last words.
    func stop() async {
        guard isListening else {
            // Still starting: it stops as soon as it has started.
            if case .preparing = state, !isFinishing { stopRequested = true }
            return
        }
        isFinishing = true
        defer { isFinishing = false }
        state = .preparing("Finishing…")
        stopAudio()
        // The converter holds back a few milliseconds of audio between buffers; without this the
        // last word is often lost.
        pipe?.flush()
        pipe = nil
        inputContinuation?.finish()
        inputContinuation = nil
        // Settling the last words normally takes a fraction of a second. If the recognizer never
        // finishes, the conversation mustn't wait forever: after 3 seconds it's cancelled, and
        // the words it had so far (volatile ones too) are kept.
        let watchdog = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled, let self else { return }
            TalkLog.note("mic: recognizer slow to finish, cancelling it")
            await self.analyzer?.cancelAndFinishNow()
            self.resultsTask?.cancel()
        }
        do { try await analyzer?.finalizeAndFinishThroughEndOfInput() } catch {
            TalkLog.note("mic: finishing recognition failed: \(error.localizedDescription)")
        }
        await resultsTask?.value
        watchdog.cancel()
        finalizedText += volatileText
        volatileText = ""
        resultsTask = nil
        analyzer = nil
        state = .idle
    }

    /// Hands-free listening for the spoken conversation: starts the mic, then stops on its own
    /// once the person has said something and gone quiet (see ListenTimer for how long), after
    /// 8 seconds if they never start, or after 30 seconds of talking. Tapping the orb ends it
    /// early. Returns what was heard, or why nothing could be.
    func listenUntilSilence() async -> Heard {
        await start()
        // A passing problem first: the conversation tries again rather than ending.
        if let problem = lastStartProblem { return .glitch(problem) }
        if case .unavailable(let message) = state { return .unavailable(message) }
        guard isListening else {
            return stopRequested ? .nothing : .glitch("The microphone didn't start.")
        }
        let began = ContinuousClock.now
        var timer = ListenTimer()
        var end = "stopped"
        while isListening, !stopRequested {
            try? await Task.sleep(for: .milliseconds(100))
            let elapsed = ContinuousClock.now - began
            if micChanged {
                end = "the mic changed"
                break
            }
            // Started, but no sound at all is coming in: the mic is held by something else or
            // the route is still switching. Better to start it again than to wait out the silence.
            if buffersHeard == 0, elapsed > .seconds(2) {
                end = "no sound from the mic"
                break
            }
            if let stop = timer.update(at: elapsed, finalized: finalizedText, volatile: volatileText, level: level) {
                end = stop.description
                break
            }
        }
        let buffers = buffersHeard
        let changed = micChanged
        await stop()
        let heard = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        let summary = "mic: listen ended (\(end)) after \(buffers) buffers, heard"
        if heard.isEmpty { TalkLog.note("\(summary) nothing") } else { TalkLog.note(summary, said: heard) }
        if !heard.isEmpty { return .words(heard, firstWordsAfter: timer.firstWordsAt) }
        if changed { return .glitch("The microphone changed partway, for example headphones connecting.") }
        if buffers == 0 { return .glitch("The microphone didn't send any sound.") }
        return .nothing
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

    private struct VoiceError: Error {
        let message: String
        /// A passing problem with the mic (no input yet, the route switching): worth another try.
        var canRetry = false
    }

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

        // The model is downloaded once and shared with other apps; checked once per app run.
        if !assetsReady {
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber.module]) {
                state = .preparing("Downloading the voice model (one time only)…")
                TalkLog.note("mic: downloading the recognition model")
                try await request.downloadAndInstall()
            }
            assetsReady = true
        }
        return transcriber
    }

    /// The main recognizer's settings, shared with the end-to-end recognition test.
    nonisolated static func speechTranscriber(locale: Locale) -> SpeechTranscriber {
        SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
    }

    #if os(iOS)
    /// playAndRecord, as in Apple's live-transcription sample. The record category rejects
    /// duckOthers with OSStatus -50 ("unsupported option for the category"), which is what stopped
    /// the mic from starting in builds 2 and 3. Shared with a test that runs on iOS. Used for the
    /// composer's mic; a conversation sets the session up once for all its turns (TalkAudio).
    nonisolated static func activateSessionForListening() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.duckOthers, .defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true, options: .notifyOthersOnDeactivation)
    }
    #endif

    private func startListening(with transcriber: Transcriber) async throws {
        let module = transcriber.module
        guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]) else {
            throw VoiceError(message: "The voice model isn't installed yet. Check your internet connection and try again.")
        }

        #if os(iOS)
        if TalkAudio.isHeld {
            TalkAudio.reassert()
        } else {
            try await step("Couldn't set up the microphone") { try await AudioSessionQueue.run { try Self.activateSessionForListening() } }
        }
        #endif

        let analyzer = SpeechAnalyzer(modules: [module])
        let (inputs, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
        self.analyzer = analyzer
        self.inputContinuation = continuation

        resultsTask = Task { [weak self] in
            await self?.collectResults(from: transcriber)
        }

        // The mic starts before the recognizer has loaded, so the first words aren't lost while
        // it does: its sound waits in the stream until the recognizer reads it.
        let engine = AVAudioEngine()
        let format = engine.inputNode.outputFormat(forBus: 0)
        #if os(iOS)
        TalkLog.note("mic: input \(Int(format.sampleRate)) Hz, \(format.channelCount) ch, route \(TalkAudio.routeDescription)")
        #endif
        // No input yet (the route is still switching, or another app holds the mic). Installing a
        // tap with this format would crash, so this is reported and tried again instead.
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw VoiceError(message: "The microphone isn't ready yet.", canRetry: true)
        }
        let pipe = AudioPipe(inputFormat: format, analyzerFormat: analyzerFormat, continuation: continuation) { [weak self] level in
            Task { @MainActor in
                self?.level = level
                self?.buffersHeard += 1
            }
        }
        pipe.install(on: engine.inputNode)
        engine.prepare()
        do {
            try engine.start()
        } catch {
            engine.inputNode.removeTap(onBus: 0)
            throw VoiceError(message: "Couldn't start the microphone: \(error.localizedDescription)", canRetry: true)
        }
        self.engine = engine
        self.pipe = pipe
        // Headphones connecting or Bluetooth switching stops the engine on its own; the listen
        // ends with what it heard rather than waiting on a mic that's gone quiet.
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                TalkLog.note("mic: engine configuration changed")
                self?.micChanged = true
            }
        }
        TalkLog.note("mic: engine started")

        // Load the model now rather than on the first audio, so the opening words aren't delayed.
        try await step("Couldn't load voice recognition") {
            try await analyzer.prepareToAnalyze(in: analyzerFormat)
            try await analyzer.start(inputSequence: inputs)
        }
    }

    /// Names the setup step that failed, so a message from a tester says where to look.
    private func step<T>(_ what: String, _ work: () throws -> T) throws -> T {
        do { return try work() } catch { throw VoiceError(message: "\(what): \(error.localizedDescription)") }
    }

    private func step<T>(_ what: String, _ work: () async throws -> T) async throws -> T {
        do { return try await work() } catch { throw VoiceError(message: "\(what): \(error.localizedDescription)") }
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
            TalkLog.note("mic: recognition stopped with an error: \(error.localizedDescription)")
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
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
        configurationObserver = nil
        if engine != nil { TalkLog.note("mic: engine stopped") }
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        #if os(iOS)
        // In a conversation the session stays as it is for the next turn (TalkAudio releases it).
        if !TalkAudio.isHeld {
            AudioSessionQueue.later { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        }
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

/// How long a pause means the person has finished speaking. Short once the recognizer has
/// settled every word and the sentence sounds finished; longer while words are still being
/// worked out or the last word leaves the thought hanging ("and", "um", a trailing comma), so a
/// pause to think isn't taken as the end.
enum EndOfSpeech {
    static let settled: Duration = .milliseconds(800)
    static let unsettled: Duration = .milliseconds(1400)

    /// Words after which people usually carry on.
    private static let carryOn: Set<String> = [
        "and", "but", "or", "so", "um", "uh", "er", "erm", "hmm", "because", "cause",
        "the", "a", "an", "to", "with", "if",
    ]

    static func quietNeeded(finalized: String, volatile: String) -> Duration {
        // Words still being recognized: more may be on the way.
        guard volatile.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return unsettled }
        let said = finalized.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let last = said.last else { return unsettled }
        if last == "," || last == "-" || last == "\u{2014}" || last == "\u{2026}" { return unsettled }
        if let lastWord = words(said).last, carryOn.contains(lastWord) { return unsettled }
        return settled
    }

    /// Lower-case words without punctuation, to tell new words from the same ones settled.
    static func words(_ text: String) -> [String] {
        text.lowercased()
            .split { !($0.isLetter || $0.isNumber || $0 == "'") }
            .map(String.init)
    }
}

/// When a hands-free listen ends, from what's been recognized and how loud it is, apart from
/// the mic so it can be tested. It ends once words have been heard and the person has gone quiet
/// (EndOfSpeech says how long); after 8 seconds if no words come; and after 30 seconds of
/// talking whatever happens, so a noisy room can't keep it open forever.
///
/// Loudness alone only counts as still talking for a moment after the last new word (the
/// recognizer runs a little behind the voice), and only when it's well above the room's own
/// noise. Before build 27 any sound over a fixed level kept the turn open, so a fan, a TV or a
/// car could stop it from ever ending.
struct ListenTimer {
    enum End: Equatable, CustomStringConvertible {
        /// They said something and went quiet.
        case finished
        /// No words came.
        case nothingSaid
        /// They've been talking for the longest a turn can be.
        case longest

        var description: String {
            switch self {
            case .finished: "silence"
            case .nothingSaid: "nothing said"
            case .longest: "longest turn"
            }
        }
    }

    static let waitForWords: Duration = .seconds(8)
    /// A voice without words yet (the recognizer behind) can stretch the wait this much.
    static let waitWhileLoud: Duration = .seconds(12)
    static let longest: Duration = .seconds(30)
    /// How long loudness keeps the turn open after the last new word.
    static let loudnessGrace: Duration = .milliseconds(1500)

    private var lastWords: [String] = []
    /// When the first words came, since listening began.
    private(set) var firstWordsAt: Duration?
    private var lastNewWordsAt: Duration = .zero
    private var lastSoundAt: Duration = .zero
    private var lastLoudAt: Duration?
    /// The quietest the room has been, 0...1, rising slowly in case it gets noisier.
    private(set) var noiseFloor: Double?

    /// Loud enough to be a voice: clearly above the room's noise.
    func isLoud(_ level: Double) -> Bool { level > max(0.3, (noiseFloor ?? 0) + 0.25) }

    /// Called about ten times a second with the time since listening began. Returns why to stop, or nil.
    mutating func update(at now: Duration, finalized: String, volatile: String, level: Double) -> End? {
        if let floor = noiseFloor {
            noiseFloor = level < floor ? level : floor + (level - floor) * 0.01
        } else {
            noiseFloor = level
        }
        let words = EndOfSpeech.words(finalized + volatile)
        if words != lastWords {
            lastWords = words
            if !words.isEmpty {
                if firstWordsAt == nil { firstWordsAt = now }
                lastNewWordsAt = now
                lastSoundAt = now
            }
        }
        let loud = isLoud(level)
        if loud { lastLoudAt = now }
        guard let first = firstWordsAt else {
            if now > Self.waitWhileLoud { return .nothingSaid }
            let stillLoud = lastLoudAt.map { now - $0 < .seconds(1) } ?? false
            return now > Self.waitForWords && !stillLoud ? .nothingSaid : nil
        }
        if loud, now - lastNewWordsAt < Self.loudnessGrace { lastSoundAt = now }
        if now - first > Self.longest { return .longest }
        if now - lastSoundAt > EndOfSpeech.quietNeeded(finalized: finalized, volatile: volatile) { return .finished }
        return nil
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
