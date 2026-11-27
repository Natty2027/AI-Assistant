import AVFoundation
import Foundation
import Synchronization

/// The sound setup for a whole spoken conversation (Talk). It's set once when the conversation
/// starts and released when it ends, so the turns don't change it: Hera's voice and the mic both
/// use it as it is.
///
/// Before build 27, each turn switched the shared audio session between playback (Hera
/// speaking) and play-and-record (listening) and deactivated it in between. On an iPhone that
/// reroutes the sound every turn; with AirPods or a car it also switches the Bluetooth profile,
/// which takes a second or two and can leave the mic starting with no sound at all. One
/// play-and-record setup for the whole conversation avoids all of that.
/// Where the audio session is switched on and off. Those calls block until the system has
/// rerouted the sound, which can take a noticeable moment on an iPhone, so they don't run on the
/// main thread (where they'd freeze the screen). One queue, so they also happen in the order
/// they were asked for: the mic's setup can never be undone by Hera's voice letting go late.
enum AudioSessionQueue {
    private static let queue = DispatchQueue(label: "com.natty2027.hera.audio-session", qos: .userInitiated)

    /// Runs `work` on the queue and waits for it.
    static func run<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { continuation.resume(with: Result { try work() }) }
        }
    }

    /// Runs `work` on the queue without waiting (letting the sound go).
    static func later(_ work: @escaping @Sendable () -> Void) {
        queue.async(execute: work)
    }
}

@MainActor
enum TalkAudio {
    /// A conversation holds the session: HeraVoice and VoiceInput leave its setup alone and
    /// don't release it after each turn.
    private(set) static var isHeld = false
    /// Told when something else takes the sound over (a call, Siri, an alarm), with a reason to
    /// show. Set by the screen running the conversation.
    static var onInterruption: (@MainActor (String) -> Void)?

    private static var observers: [any NSObjectProtocol] = []
    /// A begin still trying to get the sound; a second begin waits for it rather than starting
    /// its own (and adding a second set of observers).
    private static var beginning: Task<String?, Never>?

    /// The same as isHeld, readable from the audio-session queue: work queued there earlier (Hera
    /// letting the sound go, or setting it up for speaking) checks it just before running, so it
    /// can't undo the conversation's setup. Set before the conversation's own setup is queued.
    nonisolated static let heldForQueue = Atomic<Bool>(false)

    #if os(iOS)
    /// Play and record for the whole conversation, Hera through the loud speaker (not the
    /// earpiece), Bluetooth headsets and car kits allowed. Other audio is lowered while it lasts.
    nonisolated static let category = AVAudioSession.Category.playAndRecord
    nonisolated static let mode = AVAudioSession.Mode.spokenAudio
    nonisolated static let options: AVAudioSession.CategoryOptions = [.duckOthers, .defaultToSpeaker, .allowBluetoothHFP, .allowBluetoothA2DP]
    #endif

    /// Waits between tries to get the sound. Siri ("Hey Siri, talk to Hera") can still be holding
    /// it for a moment as Hera opens, so the first try often fails then.
    nonisolated static let retryWaits: [Duration] = [.milliseconds(250), .milliseconds(500), .milliseconds(750), .seconds(1), .milliseconds(1250)]

    /// Sets the conversation's sound up. Returns nil once it's ready, or why it couldn't be.
    static func begin() async -> String? {
        if isHeld { return nil }
        if let beginning { return await beginning.value }
        let task = Task { await setUp() }
        beginning = task
        let result = await task.value
        beginning = nil
        return result
    }

    private static func setUp() async -> String? {
        #if os(iOS)
        heldForQueue.store(true, ordering: .sequentiallyConsistent)
        for attempt in 0...retryWaits.count {
            do {
                try await AudioSessionQueue.run {
                    let session = AVAudioSession.sharedInstance()
                    try session.setCategory(category, mode: mode, options: options)
                    try session.setActive(true)
                }
                isHeld = true
                observe()
                TalkLog.note("audio: session ready (playAndRecord, try \(attempt + 1)) route \(routeDescription)")
                return nil
            } catch {
                TalkLog.note("audio: session not ready (try \(attempt + 1)): \(error.localizedDescription)")
                guard attempt < retryWaits.count else { break }
                try? await Task.sleep(for: retryWaits[attempt])
            }
        }
        heldForQueue.store(false, ordering: .sequentiallyConsistent)
        return "Hera couldn't use the microphone and speaker. If a call or another app is using them, finish there and try again."
        #else
        isHeld = true
        TalkLog.note("audio: ready (Mac)")
        return nil
        #endif
    }

    /// Releases the sound once the conversation is over, so other apps' audio comes back up.
    static func end() {
        guard isHeld else { return }
        isHeld = false
        heldForQueue.store(false, ordering: .sequentiallyConsistent)
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        #if os(iOS)
        AudioSessionQueue.later {
            do {
                try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                TalkLog.note("audio: session released")
            } catch {
                // Still playing or recording (the goodbye): the voice releases it when it's done.
                TalkLog.note("audio: session not released yet: \(error.localizedDescription)")
            }
        }
        #else
        TalkLog.note("audio: released (Mac)")
        #endif
    }

    /// Keeps the held session active, in case the system deactivated it. Cheap when it's active.
    static func reassert() {
        #if os(iOS)
        guard isHeld else { return }
        AudioSessionQueue.later {
            do { try AVAudioSession.sharedInstance().setActive(true) } catch {
                TalkLog.note("audio: couldn't reactivate: \(error.localizedDescription)")
            }
        }
        #endif
    }

    #if os(iOS)
    static var routeDescription: String {
        let route = AVAudioSession.sharedInstance().currentRoute
        let inputs = route.inputs.map(\.portType.rawValue).joined(separator: ",")
        let outputs = route.outputs.map(\.portType.rawValue).joined(separator: ",")
        return "in[\(inputs)] out[\(outputs)]"
    }

    private static func observe() {
        let center = NotificationCenter.default
        // Never two sets at once.
        observers.forEach(center.removeObserver)
        let session = AVAudioSession.sharedInstance()
        observers = [
            center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { note in
                let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init)
                let reason = (note.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt).flatMap(AVAudioSession.InterruptionReason.init)
                MainActor.assumeIsolated { interrupted(type: type, reason: reason) }
            },
            center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: .main) { note in
                let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init)
                MainActor.assumeIsolated {
                    TalkLog.note("audio: route changed (\(reason.map(describe) ?? "unknown")) now \(routeDescription)")
                }
            },
            center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: .main) { _ in
                MainActor.assumeIsolated {
                    TalkLog.note("audio: media services were reset")
                    onInterruption?("The iPhone's sound restarted, so the conversation stopped. Tap the orb to talk again.")
                }
            },
        ]
    }

    private static func interrupted(type: AVAudioSession.InterruptionType?, reason: AVAudioSession.InterruptionReason?) {
        switch type {
        case .began:
            TalkLog.note("audio: interruption began (reason \(reason.map { String($0.rawValue) } ?? "none"))")
            onInterruption?("The conversation stopped because a call, Siri or another app started using the sound. Tap the orb to talk again.")
        case .ended:
            TalkLog.note("audio: interruption ended")
        default:
            TalkLog.note("audio: interruption of unknown type")
        }
    }

    private static func describe(_ reason: AVAudioSession.RouteChangeReason) -> String {
        switch reason {
        case .newDeviceAvailable: "new device"
        case .oldDeviceUnavailable: "device removed"
        case .categoryChange: "category change"
        case .override: "override"
        case .wakeFromSleep: "wake"
        case .noSuitableRouteForCategory: "no suitable route"
        case .routeConfigurationChange: "configuration"
        default: "other \(reason.rawValue)"
        }
    }
    #endif
}
