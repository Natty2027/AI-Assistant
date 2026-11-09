import SwiftUI

/// What Hera said after a run, then what to do next: approve what's waiting, share posts written
/// for other platforms, or fix what couldn't be proposed. Ends with a way to start over.
struct RunResultView: View {
    let run: AgentRunResponse
    var openReview: () -> Void
    var startOver: () -> Void

    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            if !run.text.isEmpty { reply }

            if run.tainted {
                Label("This used content from the web. Check everything carefully before approving.", systemImage: "exclamationmark.shield.fill")
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .glowCard(padding: 14)
            }

            if let changes = run.scheduleChanges, !changes.isEmpty {
                ScheduleChangesView(changes: changes)
            }

            let waiting = run.proposals.filter(\.isPending)
            if !waiting.isEmpty { waitingForApproval(waiting) }

            let sharable = run.drafts.filter(\.isForSharing)
            if !sharable.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    SectionLabel("Posts to share")
                    ForEach(sharable) { DraftCard(draft: $0) }
                }
            }

            let blocked = run.proposals.filter { $0.status == "blocked" }
            if !blocked.isEmpty { couldntBeProposed(blocked) }

            Button(action: startOver) {
                Label("Start something new", systemImage: "plus")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.glass)
            .controlSize(.large)
        }
    }

    /* ---------------- sections ---------------- */

    private var reply: some View {
        HStack(alignment: .top, spacing: 14) {
            IconTile(systemImage: run.needsAnswer ? "questionmark" : "sparkles", size: 34)
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(run.needsAnswer ? "A question for you" : "Hera")
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                    if HeraVoice.isAvailable { listenButton }
                }
                Text(run.text)
                    .textSelection(.enabled)
                if model.speech.phase == .preparing {
                    Label("Getting Hera's voice ready…", systemImage: "waveform")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let problem = model.speech.problem {
                    Text(problem)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if run.needsAnswer {
                    Text("Answer in the box above and tap Create again.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .glowCard()
    }

    private func waitingForApproval(_ waiting: [Proposal]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel("Waiting for your approval")
            VStack(alignment: .leading, spacing: 14) {
                ForEach(waiting) { p in
                    HStack(spacing: 12) {
                        IconTile(systemImage: p.isSite ? "globe" : "text.bubble.fill", size: 30)
                        Text(p.summary).font(.subheadline)
                    }
                }
                Button(action: openReview) {
                    Label("Review and publish", systemImage: "checkmark.seal.fill")
                        .font(.body.weight(.semibold))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
            }
            .glowCard()
        }
    }

    private func couldntBeProposed(_ blocked: [Proposal]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel("Couldn't be proposed", color: .red)
            ForEach(blocked) { p in
                VStack(alignment: .leading, spacing: 8) {
                    Text(p.summary).font(.headline)
                    CheckList(checks: p.checks)
                }
                .glowCard()
            }
        }
    }

    /// Replays the reply in Hera's voice, or stops her mid-sentence.
    private var listenButton: some View {
        let speaking = model.speech.isSpeaking
        return Button {
            if speaking { model.speech.stop() } else { model.speech.speak(run.text) }
        } label: {
            Label(speaking ? "Stop" : "Listen", systemImage: speaking ? "stop.fill" : "speaker.wave.2.fill")
                .font(.footnote.weight(.semibold))
                .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(.glass)
        .controlSize(.small)
    }
}
