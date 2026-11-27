import AVFoundation
import Foundation
import KokoroCoreML
import Observation
import os
import Synchronization

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
    /// One delegate for every utterance; it says which one finished.
    private var systemVoiceDelegate: SystemVoiceDelegate?

    /// Bumped on every speak/stop so callbacks from an earlier reply are ignored.
    private var generation = 0
    /// Buffers scheduled but not yet heard, and whether synthesis has produced its last one.
    private var pendingBuffers = 0
    private var synthesisFinished = false
    /// System-voice utterances handed over and not yet finished.
    private var systemPending = PendingUtterances()

    /// The reply being spoken, a piece at a time (see beginReply): what's still to say, whether
    /// more may come, and the speaking task waiting for it.
    private var queue: [String] = []
    private var queueOpen = false
    private var silent = false
    private var moreQueued: CheckedContinuation<Void, Never>?
    /// Her own voice failed during this reply, so the rest of it goes to the system voice
    /// rather than trying (and waiting on) her voice again for every sentence.
    private var usingSystemVoice = false
    /// Bumped whenever the player is replaced, so a buffer from an old one (after the sound
    /// setup changed) isn't counted against the new one.
    private var audioEpoch = 0
    private var configurationObserver: (any NSObjectProtocol)?
    /// How long a piece waits for her voice to load before the system voice says it instead.
    /// The first load on a device compiles the model and can take much longer than this; it
    /// carries on loading for the next reply.
    private static let loadWait: Duration = .seconds(6)
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
        // The sound first: if it isn't free yet (Siri handing over), waiting here is better than
        // taking the failure for a broken voice model.
        await ensureSession(generation: current)
        guard current == generation else { return }
        if !usingSystemVoice, let directory = Self.modelDirectory {
            // Her own voice as configured, then once more on the CPU only.
            for attempt in 1...2 {
                do {
                    switch try await speakWithKokoro(text, from: directory, generation: current) {
                    case .spoke:
                        problem = nil
                        return
                    case .stillLoading:
                        // Said by the system voice this time; her voice is used once it has loaded.
                        TalkLog.note("voice: model still loading, system voice says this piece")
                        guard current == generation else { return }
                        usingSystemVoice = true  // the rest of this reply too, in one voice
                        speakWithSystemVoice(text, generation: current)
                        return
                    case .failed:
                        Self.log.error("Hera's voice produced no audio (attempt \(attempt), CPU only: \(self.cpuOnly))")
                        TalkLog.note("voice: no audio from her voice (try \(attempt), cpu \(self.cpuOnly))")
                    }
                } catch let error as AudioOutputError {
                    // The speaker, not the model: her voice is fine, so don't reload it on the CPU.
                    TalkLog.note("voice: speaker couldn't start: \(error.underlying.localizedDescription)")
                    guard current == generation else { return }
                    speakWithSystemVoice(text, generation: current)
                    return
                } catch {
                    Self.log.error("Hera's voice failed (attempt \(attempt)): \(error.localizedDescription, privacy: .public)")
                    TalkLog.note("voice: her voice failed (try \(attempt)): \(error.localizedDescription)")
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

    /// How one piece went with her own voice.
    private enum KokoroOutcome { case spoke, stillLoading, failed }

    /// The speaker couldn't start; her voice model itself is fine.
    private struct AudioOutputError: Error { let underlying: any Error }

    /// Her voice model, or nil if it's still loading after `limit` (it carries on loading).
    private func loadedEngine(_ directory: URL, within limit: Duration) async throws -> KokoroEngine? {
        try await Deadline.value(of: loadingTask(directory), within: limit)
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
    /// It failed if no audio came out and parts of it failed, which is how a model that failed
    /// to load shows up (every chunk fails). A piece with nothing to say out loud (an emoji, a
    /// dash) makes no audio and no failures: that's fine, not a broken voice.
    private func speakWithKokoro(_ text: String, from directory: URL, generation current: Int) async throws -> KokoroOutcome {
        guard let engine = try await loadedEngine(directory, within: Self.loadWait) else { return .stillLoading }
        guard current == generation else { return .spoke }
        // Turning text into phonemes takes a moment; keep it off the main thread.
        let stream = try await Task.detached(priority: .userInitiated) {
            try engine.speak(text, voice: Self.voiceName)
        }.value

        var madeAudio = false
        var failures = 0
        for await event in stream {
            guard current == generation else { return .spoke }  // stopped: nothing more to do
            switch event {
            case .audio(let buffer):
                // One player for the whole reply: each piece's audio is queued after the last.
                let player: AVAudioPlayerNode
                do { player = try self.player ?? startAudio() } catch { throw AudioOutputError(underlying: error) }
                phase = .speaking
                madeAudio = true
                pendingBuffers += 1
                let epoch = audioEpoch
                // Called once the sound has been played out, not just handed to the hardware.
                player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                    Task { @MainActor in self?.bufferPlayed(generation: current, epoch: epoch) }
                }
            case .chunkFailed(let error):
                failures += 1
                Self.log.error("Part of Hera's reply couldn't be spoken: \(error.localizedDescription, privacy: .public)")
            }
        }
        if current != generation || madeAudio { return .spoke }
        return failures > 0 ? .failed : .spoke
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
        // A route or format change (headphones in or out, Bluetooth switching) stops the engine,
        // and the buffers still queued are never played, so their callbacks never come.
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: audio, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.audioConfigurationChanged() }
        }
        TalkLog.note("voice: playback engine started")
        return player
    }

    /// The engine stopped itself: what was queued on it won't be heard. The rest of the reply
    /// plays on a new one; if nothing more is coming, she's done.
    private func audioConfigurationChanged() {
        TalkLog.note("voice: playback engine configuration changed; replacing it")
        releasePlayer()
        finishIfDone()
    }

    private func releasePlayer() {
        audioEpoch += 1
        pendingBuffers = 0
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
        configurationObserver = nil
        player?.stop()
        audio?.stop()
        player = nil
        audio = nil
    }

    private func bufferPlayed(generation current: Int, epoch: Int) {
        guard current == generation, epoch == audioEpoch else { return }
        pendingBuffers -= 1
        finishIfDone()
    }

    private func finishIfDone() {
        guard synthesisFinished, pendingBuffers <= 0, systemPending.isEmpty else { return }
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
        TalkLog.note("voice: system voice speaking")
        try? activateSession()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Self.bestSystemVoice()
        // The synthesizer queues utterances itself, so later pieces follow without a gap.
        if systemVoiceDelegate == nil {
            let delegate = SystemVoiceDelegate { [weak self] finished in
                // Only utterances this reply is still waiting for: a late callback from one that
                // was stopped earlier mustn't finish this reply before it's been said.
                guard let self, self.systemPending.finish(finished) else { return }
                self.finishIfDone()
            }
            systemVoiceDelegate = delegate
            systemVoice.delegate = delegate
        }
        systemPending.add(ObjectIdentifier(utterance))
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
        // In a conversation the session is already set up for both speaking and listening
        // (TalkAudio); changing it here would reroute the sound every turn.
        if TalkAudio.isHeld {
            TalkAudio.reassert()
            return
        }
        // Already set up for this reply (ensureSession, off the main thread).
        if sessionActive { return }
        #if os(iOS)
        try Self.setUpSessionForSpeaking()
        #endif
        sessionActive = true
    }

    #if os(iOS)
    nonisolated private static func setUpSessionForSpeaking() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try session.setActive(true)
    }
    #endif

    /// Activates the session, waiting a little and trying again if it's busy (Siri still
    /// finishing as Hera opens). Errors are left for the speaker to report. Gives up as soon as
    /// she's stopped, so a stale retry can't change the session after a conversation has set it
    /// up; and the queued setup itself is skipped if a conversation holds the session by then.
    private func ensureSession(generation current: Int) async {
        for wait in [Duration.zero] + TalkAudio.retryWaits.prefix(3) {
            if wait > .zero { try? await Task.sleep(for: wait) }
            guard current == generation else { return }
            do {
                if TalkAudio.isHeld || sessionActive {
                    try activateSession()
                } else {
                    #if os(iOS)
                    let setUp = try await AudioSessionQueue.run { () throws -> Bool in
                        if TalkAudio.heldForQueue.load(ordering: .sequentiallyConsistent) { return false }
                        try Self.setUpSessionForSpeaking()
                        return true
                    }
                    #else
                    let setUp = true
                    #endif
                    guard current == generation else {
                        // Stopped while it was being set up: let it go again, unless Talk has it.
                        if setUp { Self.releaseSessionUnlessHeld() }
                        return
                    }
                    if setUp { sessionActive = true }
                }
                return
            } catch {
                TalkLog.note("voice: sound not available yet: \(error.localizedDescription)")
            }
        }
    }

    /// Lets the session go, on the session queue, unless a conversation holds it by the time
    /// that runs.
    private static func releaseSessionUnlessHeld() {
        #if os(iOS)
        AudioSessionQueue.later {
            guard !TalkAudio.heldForQueue.load(ordering: .sequentiallyConsistent) else { return }
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        #endif
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
        releasePlayer()
        systemPending.clear()
        synthesisFinished = false
        // Only release a session Hera activated: it's shared with voice input, and stop() is
        // also called when she isn't speaking (e.g. just before the mic starts).
        #if os(iOS)
        if sessionActive { Self.releaseSessionUnlessHeld() }
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
    private let finished: @MainActor @Sendable (ObjectIdentifier) -> Void

    init(finished: @escaping @MainActor @Sendable (ObjectIdentifier) -> Void) {
        self.finished = finished
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor in finished(id) }
    }

    /// Cancelled by the system (an interruption) rather than by Hera stopping it, which HeraVoice
    /// ignores by then: either way, it's over, so the conversation isn't left waiting.
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor in finished(id) }
    }
}

/// The system-voice utterances a reply is still waiting to hear finish. Only those count: a
/// callback for one from an earlier reply (stopped, then finished or cancelled late) is ignored.
struct PendingUtterances: Equatable {
    private var owed: Set<ObjectIdentifier> = []

    var isEmpty: Bool { owed.isEmpty }

    mutating func add(_ utterance: ObjectIdentifier) { owed.insert(utterance) }

    /// True if this reply was waiting for it; it's then no longer owed.
    mutating func finish(_ utterance: ObjectIdentifier) -> Bool { owed.remove(utterance) != nil }

    mutating func clear() { owed.removeAll() }
}

/// Waits for a task's value, but only so long: whichever comes first, the value or the time
/// limit, decides, and the task carries on either way. (A task group would wait for the slower
/// one too, since waiting on another task's value can't be cancelled.)
enum Deadline {
    /// The task's value, or nil if it isn't ready within `limit`. Its error, if it fails first.
    static func value<T: Sendable>(of task: Task<T, any Error>, within limit: Duration) async throws -> T? {
        let once = ResumeOnce<T?>()
        return try await withCheckedThrowingContinuation { continuation in
            once.set(continuation)
            let sleeper = Task {
                try? await Task.sleep(for: limit)
                once.resume(with: .success(nil))
            }
            Task {
                let result = await task.result
                sleeper.cancel()
                once.resume(with: result.map { $0 })
            }
        }
    }
}

/// A continuation resumed by whichever caller gets there first; later ones are ignored.
private final class ResumeOnce<T: Sendable>: Sendable {
    private let state = Mutex<CheckedContinuation<T, any Error>?>(nil)

    func set(_ continuation: CheckedContinuation<T, any Error>) {
        state.withLock { $0 = continuation }
    }

    func resume(with result: Result<T, any Error>) {
        let continuation = state.withLock { held -> CheckedContinuation<T, any Error>? in
            defer { held = nil }
            return held
        }
        continuation?.resume(with: result)
    }
}
