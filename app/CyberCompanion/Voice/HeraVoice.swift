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
        stop()
        let spoken = Self.spokenText(from: text)
        guard !spoken.isEmpty else { onFinished?(); return }
        generation += 1
        let current = generation
        self.onFinished = onFinished
        phase = .preparing
        speakTask = Task { await run(spoken, generation: current) }
    }

    func stop() {
        generation += 1
        onFinished = nil
        speakTask?.cancel()
        speakTask = nil
        if systemVoice.isSpeaking { systemVoice.stopSpeaking(at: .immediate) }
        tearDownAudio()
        phase = .idle
    }

    /* ---------------- choosing a voice ---------------- */

    private func run(_ text: String, generation current: Int) async {
        if let directory = Self.modelDirectory {
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

    /// Streams the reply into the speaker. Returns false if no audio came out at all, which is
    /// how a model that failed to load shows up (every chunk fails).
    private func speakWithKokoro(_ text: String, from directory: URL, generation current: Int) async throws -> Bool {
        let engine = try await loadingTask(directory).value
        // Turning text into phonemes takes a moment; keep it off the main thread.
        let stream = try await Task.detached(priority: .userInitiated) {
            try engine.speak(text, voice: Self.voiceName)
        }.value

        var player: AVAudioPlayerNode?
        pendingBuffers = 0
        synthesisFinished = false
        for await event in stream {
            guard current == generation else { return true }  // stopped: nothing more to do
            switch event {
            case .audio(let buffer):
                if player == nil {
                    player = try startAudio()
                    phase = .speaking
                }
                pendingBuffers += 1
                player?.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                    Task { @MainActor in self?.bufferPlayed(generation: current) }
                }
            case .chunkFailed(let error):
                Self.log.error("Part of Hera's reply couldn't be spoken: \(error.localizedDescription, privacy: .public)")
            }
        }
        guard current == generation else { return true }
        guard player != nil else { return false }
        synthesisFinished = true
        finishIfDone()
        return true
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
        guard synthesisFinished, pendingBuffers <= 0 else { return }
        finish()
    }

    /* ---------------- the system voice, as a last resort ---------------- */

    private func speakWithSystemVoice(_ text: String, generation current: Int) {
        try? activateSession()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Self.bestSystemVoice()
        let delegate = SystemVoiceDelegate { [weak self] in
            guard let self, current == self.generation else { return }
            self.finish()
        }
        systemVoiceDelegate = delegate
        systemVoice.delegate = delegate
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
