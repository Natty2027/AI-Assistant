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

            if let kit = LaunchKitSummary(run: run) {
                launchKit(kit)
            }

            if run.tainted {
                Label("This used content from the web. Check everything carefully before approving.", systemImage: "exclamationmark.shield.fill")
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .glowCard(padding: 14)
            }

            if let changes = run.scheduleChanges, !changes.isEmpty {
                ScheduleChangesView(changes: changes)
            }

            if let emails = run.emailDrafts, !emails.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    SectionLabel(emails.count == 1 ? "Email to send" : "Emails to send")
                    ForEach(emails) { EmailDraftCard(draft: $0) }
                }
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
                    Text("Answer in the box above and tap Send. Hera carries on from here.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .glowCard()
    }

    /// Launch Kit: everything one request made ready, at a glance, before the details below.
    private func launchKit(_ kit: LaunchKitSummary) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel("Launch Kit")
            VStack(alignment: .leading, spacing: 10) {
                ForEach(kit.items, id: \.text) { item in
                    Label(item.text, systemImage: item.systemImage)
                        .font(.subheadline)
                }
                Text("Each piece waits for your approval below or in Review. Nothing goes out until you say so.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .glowCard()
        }
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

/// What a run made ready, by kind. Shown as the Launch Kit overview when a run produced more than
/// one kind of thing (a website and posts, posts and calendar entries, and so on).
struct LaunchKitSummary: Equatable {
    struct Item: Equatable {
        let text: String
        let systemImage: String
    }

    let items: [Item]

    init?(run: AgentRunResponse) {
        func plural(_ n: Int, _ one: String, _ many: String) -> String { n == 1 ? one : "\(n) \(many)" }
        let pending = run.proposals.filter(\.isPending)
        let site = pending.filter(\.isSite).count
        let posts = pending.count - site
        let sharing = run.drafts.filter(\.isForSharing).count
        let calendar = run.scheduleChanges ?? []
        let events = calendar.filter { [.addEvent, .changeEvent, .cancelEvent].contains($0.kind) }.count
        let reminders = calendar.count - events
        let emails = run.emailDrafts?.count ?? 0

        var items: [Item] = []
        if site > 0 { items.append(.init(text: "Website ready to publish", systemImage: "globe")) }
        if posts > 0 { items.append(.init(text: plural(posts, "A post ready to approve", "posts ready to approve"), systemImage: "text.bubble.fill")) }
        if sharing > 0 { items.append(.init(text: plural(sharing, "A post to share yourself", "posts to share yourself"), systemImage: "square.and.arrow.up")) }
        if events > 0 { items.append(.init(text: plural(events, "A calendar change", "calendar changes"), systemImage: "calendar")) }
        if reminders > 0 { items.append(.init(text: plural(reminders, "A reminder", "reminders"), systemImage: "checklist")) }
        if emails > 0 { items.append(.init(text: plural(emails, "An email to send", "emails to send"), systemImage: "envelope.fill")) }
        guard items.count > 1 else { return nil }
        self.items = items
    }
}
