import AVFoundation
import Foundation
import KokoroCoreML
import Observation

/// Hera's spoken voice: Kokoro-82M with its "af_heart" voice, run entirely on this device with
/// Core ML. Nothing is sent anywhere to speak, and it works offline.
///
/// The model ships inside the app in HeraVoice.bundle (about 80 MB; see NOTICE.txt there). It's
/// loaded the first time Hera speaks, not at launch, and kept for later replies.
@MainActor
@Observable
final class HeraVoice {
    nonisolated static let voiceName = "af_heart"
    /// UserDefaults key for the Settings switch "Hera speaks her replies" (on by default).
    nonisolated static let speakRepliesKey = "speakReplies"

    private(set) var isSpeaking = false

    /// The bundled model folder, or nil if it's missing from this build.
    nonisolated static var modelDirectory: URL? {
        guard let url = Bundle.main.url(forResource: "HeraVoice", withExtension: "bundle"),
              KokoroEngine.isDownloaded(at: url) else { return nil }
        return url
    }

    nonisolated static var isAvailable: Bool { modelDirectory != nil }

    private var engine: KokoroEngine?
    private var audio: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var speakTask: Task<Void, Never>?

    /// Bumped on every speak/stop so callbacks from an earlier reply are ignored.
    private var generation = 0
    /// Buffers scheduled but not yet heard, and whether synthesis has produced its last one.
    private var pendingBuffers = 0
    private var synthesisFinished = false

    /// Speaks `text`, interrupting anything Hera was already saying.
    func speak(_ text: String) {
        stop()
        let spoken = Self.spokenText(from: text)
        guard !spoken.isEmpty, let directory = Self.modelDirectory else { return }
        generation += 1
        let current = generation
        isSpeaking = true
        speakTask = Task { await run(spoken, from: directory, generation: current) }
    }

    func stop() {
        generation += 1
        speakTask?.cancel()
        speakTask = nil
        tearDownAudio()
        isSpeaking = false
    }

    /* ---------------- synthesis and playback ---------------- */

    private func run(_ text: String, from directory: URL, generation current: Int) async {
        do {
            let engine = try await loadedEngine(from: directory)
            // Turning text into phonemes takes a moment; keep it off the main thread.
            let stream = try await Task.detached(priority: .userInitiated) {
                try engine.speak(text, voice: Self.voiceName)
            }.value
            guard current == generation, let player = try startAudio() else { return }

            pendingBuffers = 0
            synthesisFinished = false
            for await event in stream {
                guard current == generation else { return }
                guard case .audio(let buffer) = event else { continue }  // a failed chunk is skipped
                pendingBuffers += 1
                player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                    Task { @MainActor in self?.bufferPlayed(generation: current) }
                }
            }
            guard current == generation else { return }
            synthesisFinished = true
            finishIfDone()
        } catch {
            // Speech is a convenience: the reply is always on screen, so a failure just ends it.
            if current == generation { stop() }
        }
    }

    private func loadedEngine(from directory: URL) async throws -> KokoroEngine {
        if let engine { return engine }
        // The iOS Simulator's GPU path produces garbage audio, so it runs on the CPU there.
        #if targetEnvironment(simulator)
        let forceCPU = true
        #else
        let forceCPU = false
        #endif
        let loaded = try await Task.detached(priority: .userInitiated) {
            try KokoroEngine(modelDirectory: directory, forceCPU: forceCPU)
        }.value
        engine = loaded
        return loaded
    }

    private func startAudio() throws -> AVAudioPlayerNode? {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try session.setActive(true)
        #endif
        let audio = AVAudioEngine()
        let player = AVAudioPlayerNode()
        audio.attach(player)
        audio.connect(player, to: audio.mainMixerNode, format: KokoroEngine.audioFormat)
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
        tearDownAudio()
        isSpeaking = false
    }

    private func tearDownAudio() {
        player?.stop()
        audio?.stop()
        player = nil
        audio = nil
        pendingBuffers = 0
        synthesisFinished = false
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
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
