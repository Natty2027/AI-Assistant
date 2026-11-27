import AVFoundation
import Foundation
import KokoroCoreML
import Observation
import os

/// Hera's spoken voice: Kokoro-82M with its "af_heart" voice, run entirely on this device with
/// Core ML. Nothing is sent anywhere to speak, and it works offline.
///
/// The model ships inside the app in HeraVoice.bundle (about 80 MB; see NOTICE.txt there). Call
/// `prepare()` early: the first load on a device compiles the model, which can take a while.
///
/// Hera should never go silent, so speaking falls back in two steps: if her own voice produces no
/// audio (the model failed to load), it's reloaded on the CPU only, which skips the GPU and Neural
/// Engine compilation that can fail; if that still produces nothing, the system's best voice
/// speaks instead and `problem` says why.
@MainActor
@Observable
final class HeraVoice {
    nonisolated static let voiceName = "af_heart"
    /// UserDefaults key for the Settings switch "Hera speaks her replies" (on by default).
    nonisolated static let speakRepliesKey = "speakReplies"

    enum Phase: Equatable {
        case idle
        /// Loading the model or making the first audio.
        case preparing
        case speaking
    }

    private(set) var phase: Phase = .idle
    var isSpeaking: Bool { phase != .idle }
    /// Whether any audio is actually playing right now, her own voice or the system's.
    var isMakingSound: Bool { (player?.isPlaying ?? false) || systemVoice.isSpeaking }
    /// Why Hera last couldn't use her own voice, for the screen. Cleared when it works again.
    private(set) var problem: String?

    /// The bundled model folder, or nil if it's missing from this build.
    nonisolated static var modelDirectory: URL? {
        guard let url = Bundle.main.url(forResource: "HeraVoice", withExtension: "bundle"),
              KokoroEngine.isDownloaded(at: url) else { return nil }
        return url
    }

    nonisolated static var isAvailable: Bool { modelDirectory != nil }

    private static let log = Logger(subsystem: "com.natty2027.hera", category: "voice")

    private var loading: Task<KokoroEngine, any Error>?
    /// The iOS Simulator's GPU path produces garbage audio, so it starts on the CPU there.
    private var cpuOnly: Bool
    private var audio: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var sessionActive = false
    private var speakTask: Task<Void, Never>?
    private let systemVoice = AVSpeechSynthesizer()
    private var systemVoiceDelegate: SystemVoiceDelegate?

    /// Bumped on every speak/stop so callbacks from an earlier reply are ignored.
    private var generation = 0
    /// Buffers scheduled but not yet heard, and whether synthesis has produced its last one.
    private var pendingBuffers = 0
    private var synthesisFinished = false
    /// System-voice utterances handed over and not yet finished.
    private var systemPending = 0

    /// The reply being spoken, a piece at a time (see beginReply): what's still to say, whether
    /// more may come, and the speaking task waiting for it.
    private var queue: [String] = []
    private var queueOpen = false
    private var silent = false
    private var moreQueued: CheckedContinuation<Void, Never>?
    /// Her own voice failed during this reply, so the rest of it goes to the system voice
    /// rather than trying (and waiting on) her voice again for every sentence.
    private var usingSystemVoice = false
    /// Run when Hera finishes speaking on her own (not when she's stopped).
    private var onFinished: (@MainActor () -> Void)?

    init() {
        #if targetEnvironment(simulator)
        cpuOnly = true
        #else
        cpuOnly = false
        #endif
    }

    /// Starts loading the model in the background so the first reply isn't kept waiting.
    /// Cheap to call repeatedly.
    func prepare() {
        guard let directory = Self.modelDirectory else { return }
        _ = loadingTask(directory)
    }

    /// Speaks `text`, interrupting anything Hera was already saying. `onFinished` runs once she
    /// has finished speaking, unless she's stopped first.
    func speak(_ text: String, then onFinished: (@MainActor () -> Void)? = nil) {
        beginReply(then: onFinished)
        enqueue(text)
        endReply()
    }

    /// Starts a reply that arrives a piece at a time (Talk, as Hera writes it), interrupting
    /// anything she was already saying. Each `enqueue` is said straight after the one before,
    /// with no gap or restart; `onFinished` runs once the last piece has been heard after
    /// `endReply`, unless she's stopped first. `silently` (her voice is off in Settings) says
    /// nothing and finishes as soon as the reply ends.
    func beginReply(silently: Bool = false, then onFinished: (@MainActor () -> Void)? = nil) {
        stop()
        generation += 1
        self.onFinished = onFinished
        silent = silently
        queueOpen = true
    }

    /// More of the reply begun with beginReply. Markdown and links are cleaned up per piece.
    func enqueue(_ text: String) {
        guard queueOpen, !silent else { return }
        let spoken = Self.spokenText(from: text)
        guard !spoken.isEmpty else { return }
        queue.append(spoken)
        if speakTask == nil {
            phase = .preparing
            let current = generation
            speakTask = Task { await runQueue(generation: current) }
        } else {
            wakeQueue()
        }
    }

    /// Nothing more is coming: she finishes what's queued, then `onFinished` runs.
    func endReply() {
        guard queueOpen else { return }
        queueOpen = false
        if speakTask == nil { finish() } else { wakeQueue() }
    }

    func stop() {
        generation += 1
        onFinished = nil
        queue = []
        queueOpen = false
        silent = false
        usingSystemVoice = false
        // A speaking task waiting for more sees the new generation and ends.
        wakeQueue()
        speakTask?.cancel()
        speakTask = nil
        // Unconditionally: an utterance can be queued without isSpeaking being true yet.
        systemVoice.stopSpeaking(at: .immediate)
        tearDownAudio()
        phase = .idle
    }

    /* ---------------- the queue ---------------- */

    /// Says each queued piece in turn, waiting when the queue is empty but the reply isn't over.
    /// A piece is made into audio as soon as the one before it is, while that one still plays.
    private func runQueue(generation current: Int) async {
        while current == generation {
            if queue.isEmpty {
                if !queueOpen { break }
                await withCheckedContinuation { moreQueued = $0 }
                continue
            }
            await say(queue.removeFirst(), generation: current)
        }
        guard current == generation else { return }
        synthesisFinished = true
        finishIfDone()
    }

    private func wakeQueue() {
        let waiting = moreQueued
        moreQueued = nil
        waiting?.resume()
    }

    /* ---------------- choosing a voice ---------------- */

    private func say(_ text: String, generation current: Int) async {
        if !usingSystemVoice, let directory = Self.modelDirectory {
            // Her own voice as configured, then once more on the CPU only.
            for attempt in 1...2 {
                do {
                    if try await speakWithKokoro(text, from: directory, generation: current) {
                        problem = nil
                        return
                    }
                    Self.log.error("Hera's voice produced no audio (attempt \(attempt), CPU only: \(self.cpuOnly))")
                } catch {
                    Self.log.error("Hera's voice failed (attempt \(attempt)): \(error.localizedDescription, privacy: .public)")
                }
                guard current == generation else { return }
                if cpuOnly { break }
                cpuOnly = true
                loading = nil
            }
            guard current == generation else { return }
            usingSystemVoice = true
        }
        guard current == generation else { return }
        problem = "Hera's own voice couldn't start on this device, so the system voice is speaking for her."
        speakWithSystemVoice(text, generation: current)
    }

    private func loadingTask(_ directory: URL) -> Task<KokoroEngine, any Error> {
        if let loading { return loading }
        let cpu = cpuOnly
        // Returns quickly; the models load and compile on the engine's own thread.
        let task = Task.detached(priority: .userInitiated) {
            try KokoroEngine(modelDirectory: directory, forceCPU: cpu)
        }
        loading = task
        return task
    }

    /* ---------------- Hera's own voice (Kokoro) ---------------- */

    /// Streams one piece of the reply into the speaker, after whatever is already playing.
    /// Returns false if no audio came out at all, which is how a model that failed to load shows
    /// up (every chunk fails).
    private func speakWithKokoro(_ text: String, from directory: URL, generation current: Int) async throws -> Bool {
        let engine = try await loadingTask(directory).value
        // Turning text into phonemes takes a moment; keep it off the main thread.
        let stream = try await Task.detached(priority: .userInitiated) {
            try engine.speak(text, voice: Self.voiceName)
        }.value

        var madeAudio = false
        for await event in stream {
            guard current == generation else { return true }  // stopped: nothing more to do
            switch event {
            case .audio(let buffer):
                // One player for the whole reply: each piece's audio is queued after the last.
                let player = try self.player ?? startAudio()
                phase = .speaking
                madeAudio = true
                pendingBuffers += 1
                player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                    Task { @MainActor in self?.bufferPlayed(generation: current) }
                }
            case .chunkFailed(let error):
                Self.log.error("Part of Hera's reply couldn't be spoken: \(error.localizedDescription, privacy: .public)")
            }
        }
        return current != generation || madeAudio
    }

    private func startAudio() throws -> AVAudioPlayerNode {
        try activateSession()
        let audio = AVAudioEngine()
        let player = AVAudioPlayerNode()
        audio.attach(player)
        audio.connect(player, to: audio.mainMixerNode, format: KokoroEngine.audioFormat)
        audio.prepare()
        try audio.start()
        player.play()
        self.audio = audio
        self.player = player
        return player
    }

    private func bufferPlayed(generation current: Int) {
        guard current == generation else { return }
        pendingBuffers -= 1
        finishIfDone()
    }

    private func finishIfDone() {
        guard synthesisFinished, pendingBuffers <= 0, systemPending <= 0 else { return }
        finish()
    }

    /* ---------------- recorded clips ---------------- */

    /// Records `text` in Hera's voice to a sound file the system can play with a notification:
    /// 16-bit PCM in a CAF file, cut to under 30 seconds (longer sounds are replaced by the
    /// default one). Throws if her voice isn't available on this device.
    func record(_ text: String, to url: URL) async throws {
        guard let directory = Self.modelDirectory else { throw KokoroError.modelsNotAvailable(URL(filePath: "/")) }
        let engine = try await loadingTask(directory).value
        let spoken = Self.spokenText(from: text)
        try await Task.detached(priority: .utility) {
            let samples = try engine.synthesize(text: spoken, voice: Self.voiceName).samples
            let clip = Array(samples.prefix(KokoroEngine.sampleRate * 28))
            guard let buffer = KokoroEngine.makePCMBuffer(from: clip, format: KokoroEngine.audioFormat) else {
                throw CocoaError(.fileWriteUnknown)
            }
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: KokoroEngine.sampleRate,
                AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
            ]
            // Written beside the final name and moved into place, so a half-written file is never played.
            let partial = url.deletingLastPathComponent().appending(path: "." + url.lastPathComponent)
            do {
                let file = try AVAudioFile(forWriting: partial, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
                try file.write(from: buffer)
            }
            try? FileManager.default.removeItem(at: url)
            try FileManager.default.moveItem(at: partial, to: url)
        }.value
    }

    /* ---------------- the system voice, as a last resort ---------------- */

    private func speakWithSystemVoice(_ text: String, generation current: Int) {
        try? activateSession()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Self.bestSystemVoice()
        // The synthesizer queues utterances itself, so later pieces follow without a gap.
        let delegate = SystemVoiceDelegate { [weak self] in
            guard let self, current == self.generation else { return }
            self.systemPending -= 1
            self.finishIfDone()
        }
        systemVoiceDelegate = delegate
        systemVoice.delegate = delegate
        systemPending += 1
        phase = .speaking
        systemVoice.speak(utterance)
    }

    /// The most natural installed voice for the person's language: premium, then enhanced, and
    /// female where there's a choice, to stay close to Hera's own voice.
    nonisolated static func bestSystemVoice() -> AVSpeechSynthesisVoice? {
        let language = Locale.current.language.languageCode?.identifier ?? "en"
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix(language) }
        func rank(_ v: AVSpeechSynthesisVoice) -> Int {
            (v.quality == .premium ? 20 : v.quality == .enhanced ? 10 : 0) + (v.gender == .female ? 5 : 0)
        }
        return voices.max { rank($0) < rank($1) } ?? AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
    }

    /* ---------------- audio session ---------------- */

    private func activateSession() throws {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try session.setActive(true)
        #endif
        sessionActive = true
    }

    /// Ends playback and hands the session back.
    private func finish() {
        tearDownAudio()
        phase = .idle
        let next = onFinished
        onFinished = nil
        next?()
    }

    private func tearDownAudio() {
        pendingBuffers = 0
        systemPending = 0
        synthesisFinished = false
        player?.stop()
        audio?.stop()
        player = nil
        audio = nil
        // Only release a session Hera activated: it's shared with voice input, and stop() is
        // also called when she isn't speaking (e.g. just before the mic starts).
        #if os(iOS)
        if sessionActive { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        #endif
        sessionActive = false
    }

    /* ---------------- what gets said ---------------- */

    /// The reply as it should sound: Markdown symbols dropped and web addresses replaced, so Hera
    /// doesn't read out asterisks or spell a URL letter by letter.
    nonisolated static func spokenText(from text: String) -> String {
        var spoken = text
        // [label](https://…) → label
        spoken = spoken.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]+\)"#, with: "$1", options: .regularExpression)
        spoken = spoken.replacingOccurrences(of: #"https?://\S+"#, with: "the link", options: .regularExpression)
        spoken = spoken.replacingOccurrences(of: #"[*_`#>]+"#, with: "", options: .regularExpression)
        spoken = spoken.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        return spoken.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Tells HeraVoice when the system voice has finished. AVSpeechSynthesizer calls its delegate
/// off the main actor, so this hops back before touching HeraVoice.
private final class SystemVoiceDelegate: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    private let finished: @MainActor @Sendable () -> Void

    init(finished: @escaping @MainActor @Sendable () -> Void) {
        self.finished = finished
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in finished() }
    }
}
