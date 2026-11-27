import SwiftUI

/// The spoken conversation (Talk) on Create: what the person said and what Hera answered, with
/// anything she made shown as the usual cards under her answer, ready to approve while the
/// conversation carries on.
struct TalkView: View {
    let session: TalkSession
    /// The words being recognized right now, shown as they're spoken.
    let liveWords: String
    var openReview: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                SectionLabel("Conversation")
                Spacer()
                if !session.isActive {
                    Button("Close", systemImage: "xmark") { withAnimation { session.clear() } }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(session.turns) { turn in
                VStack(alignment: .leading, spacing: 16) {
                    bubble(turn.text, speaker: turn.speaker)
                    if let run = turn.run, RunOutputsView.hasOutputs(run) {
                        RunOutputsView(run: run, openReview: openReview)
                    }
                }
                .id(turn.id)
                .transition(.opacity)
            }
            if session.phase == .listening, !liveWords.isEmpty {
                bubble(liveWords, speaker: .person)
                    .opacity(0.6)
            }
            if session.phase == .thinking {
                HStack(spacing: 12) {
                    IconTile(systemImage: "sparkles", size: 30)
                    ThinkingBeam()
                }
                .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.spring(duration: 0.35), value: session.turns)
        .animation(.spring(duration: 0.35), value: session.phase)
    }

    /// The person's words on the right, Hera's on the left with her tile, as in Messages.
    @ViewBuilder
    private func bubble(_ text: String, speaker: TalkTurn.Speaker) -> some View {
        let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
        switch speaker {
        case .person:
            Text(text)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Theme.spectrum[1].opacity(0.22), in: shape)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.leading, 48)
                .accessibilityLabel("You said: \(text)")
        case .hera:
            HStack(alignment: .top, spacing: 12) {
                IconTile(systemImage: "sparkles", size: 30)
                Text(text)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .glassEffect(.regular, in: shape)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.trailing, 48)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Hera: \(text)")
        }
    }
}

/// While a conversation is going: what Hera is doing, and End. Pinned to the bottom of the screen
/// so it stays in reach when the conversation is longer than the screen.
struct TalkControls: View {
    let session: TalkSession

    var body: some View {
        HStack(spacing: 12) {
            Label(status, systemImage: symbol)
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                .contentTransition(.opacity)
                .lineLimit(1)
            Spacer(minLength: 0)
            if session.phase == .speaking {
                Button("Interrupt", systemImage: "mic.fill") { session.tapOrb() }
                    .buttonStyle(.glass)
                    .help("Stop Hera and speak now")
            }
            Button("End", systemImage: "stop.fill") { session.end(sayingGoodbye: false) }
                .buttonStyle(.glassProminent)
                .keyboardShortcut(.escape, modifiers: [])
        }
        .controlSize(.small)
        .lineLimit(1)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .glassEffect(.regular, in: .capsule)
        .frame(maxWidth: 720)
        .padding(.horizontal, 20)
        .padding(.bottom, 8)
        .animation(.easeInOut, value: session.phase)
    }

    private var status: String {
        switch session.phase {
        case .listening: "Listening · say \u{201C}bye\u{201D} to finish"
        case .thinking: "Hera is thinking…"
        case .speaking: "Hera is speaking"
        case .off: ""
        }
    }

    private var symbol: String {
        switch session.phase {
        case .listening: "waveform"
        case .thinking: "ellipsis"
        case .speaking: "speaker.wave.2.fill"
        case .off: "waveform"
        }
    }
}

extension TalkSession {
    /// Leaving the app ends a conversation, since the mic can't listen in the background. Only
    /// the background counts: inactive is also a notification banner, Control Center, the
    /// microphone prompt, or Siri handing the app over, and those mustn't end it.
    static func endsConversation(in phase: ScenePhase) -> Bool { phase == .background }

    /// A conversation from Siri starts once the app is fully in front: Siri opens it while it's
    /// still inactive, and the mic and speaker can't start before it's active.
    static func canStartFromSiri(in phase: ScenePhase) -> Bool { phase == .active }
}
