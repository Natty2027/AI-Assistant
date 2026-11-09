import SwiftUI

/// The signature control: a glowing glass orb. Tap to speak; while listening, rings ripple out
/// and the glow swells with the speaker's voice.
struct VoiceOrb: View {
    let isListening: Bool
    let isBusy: Bool
    /// Hera is talking: the orb becomes her Stop button.
    var isHeraSpeaking = false
    /// 0...1, how loud the speaker is.
    let level: Double
    let action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    private let size: CGFloat = 108

    var body: some View {
        Button(action: action) {
            ZStack {
                if isBusy {
                    ProgressView().controlSize(.large).tint(.white)
                } else {
                    Image(systemName: isHeraSpeaking ? "stop.fill" : isListening ? "waveform" : "mic.fill")
                        .font(.system(size: 34, weight: .semibold))
                        .foregroundStyle(.white)
                        .symbolEffect(.variableColor.iterative, isActive: isListening && !reduceMotion)
                        .contentTransition(.symbolEffect(.replace))
                }
            }
            .frame(width: size, height: size)
            .glassEffect(.regular.tint(Theme.spectrum[1].opacity(tintOpacity)).interactive(), in: .circle)
            .background { glow }
            .background { if isListening { ripples } }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isHeraSpeaking ? "Stop Hera" : isListening ? "Stop listening" : "Speak your request")
        .accessibilityHint(isHeraSpeaking ? "Ends what Hera is saying" : "Your voice is recognized on this device")
        .animation(.spring(duration: 0.35), value: isListening)
    }

    /// Light mode needs a deeper tint so the white symbol stays legible on the pale background.
    private var tintOpacity: Double {
        switch (colorScheme, isListening) {
        case (.dark, false): 0.35
        case (.dark, true): 0.55
        case (_, false): 0.8
        case (_, true): 0.9
        }
    }

    /// A blurred spectrum behind the glass that brightens and grows with the voice.
    private var glow: some View {
        Circle()
            .fill(AngularGradient(colors: Theme.spectrum, center: .center))
            .blur(radius: 22)
            .scaleEffect(reduceMotion ? 1 : 0.9 + level * 0.45 + (isListening ? 0.1 : 0))
            .opacity(isListening ? 0.95 : 0.6)
            .animation(.easeOut(duration: 0.12), value: level)
    }

    private var ripples: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            ZStack {
                ForEach(0..<3, id: \.self) { i in
                    let progress = reduceMotion ? 0.3 : (t / 2.4 + Double(i) / 3).truncatingRemainder(dividingBy: 1)
                    Circle()
                        .stroke(Theme.spectrumGradient, lineWidth: 1.5)
                        .scaleEffect(1 + progress * 0.9)
                        .opacity(1 - progress)
                }
            }
        }
        .frame(width: size, height: size)
        .allowsHitTesting(false)
    }
}

#Preview {
    HStack(spacing: 60) {
        VoiceOrb(isListening: false, isBusy: false, level: 0) {}
        VoiceOrb(isListening: true, isBusy: false, level: 0.6) {}
    }
    .padding(80)
    .auroraBackground()
}
