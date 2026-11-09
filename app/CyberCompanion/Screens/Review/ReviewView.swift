import SwiftUI

/// Everything the assistant proposed. Nothing reaches the public until it's approved here.
struct ReviewView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    let pending = model.proposals.filter(\.isPending)
                    let history = model.proposals.filter { !$0.isPending }
                    if pending.isEmpty && history.isEmpty {
                        ContentUnavailableView("Nothing to review", systemImage: "checkmark.seal",
                                               description: Text("When Hera has a website or post ready to publish, it appears here for you to approve."))
                            .glowCard()
                    }
                    if !pending.isEmpty {
                        group("Waiting for you", pending)
                    }
                    if !history.isEmpty {
                        group("Earlier", history, color: .secondary)
                    }
                }
                .padding(20)
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
            }
            .auroraBackground()
            .navigationTitle("Review")
            .navigationDestination(for: Proposal.self) { ProposalDetailView(proposal: $0) }
            .refreshable { await model.refreshProposals() }
            .toolbar {
                Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.refreshProposals() } }
            }
            .task { await model.refreshProposals() }
        }
    }

    private func group(_ title: String, _ proposals: [Proposal], color: Color = Theme.spectrum[0]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel(title, color: color)
            ForEach(proposals) { p in
                NavigationLink(value: p) { row(p) }
                    .buttonStyle(.plain)
            }
        }
    }

    private func row(_ p: Proposal) -> some View {
        HStack(spacing: 14) {
            IconTile(systemImage: p.isSite ? "globe" : "text.bubble.fill", size: 42)
            VStack(alignment: .leading, spacing: 6) {
                Text(p.summary)
                    .font(.headline)
                    .lineLimit(2)
                Text(p.label)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                StatusPill(status: p.status)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .glowCard(padding: 16)
        .contentShape(.rect)
    }
}

/// One proposal: the exact content, the rule results, and the confirmations required to approve.
struct ProposalDetailView: View {
    @Environment(AppModel.self) private var model
    @State private var proposal: Proposal
    @State private var confirmed: Set<String> = []
    @State private var acknowledgedTaint = false
    @State private var showPublishConfirmation = false
    @State private var isWorking = false

    init(proposal: Proposal) {
        _proposal = State(initialValue: proposal)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header
                content
                if !proposal.checks.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        SectionLabel("Checks")
                        CheckList(checks: proposal.checks).glowCard()
                    }
                }
                if proposal.isPending { decision }
                if let result = proposal.result { outcome(result) }
                if let message = model.errorMessage {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .glowCard(padding: 14)
                }
            }
            .padding(20)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
            .animation(.spring(duration: 0.4), value: proposal)
        }
        .auroraBackground()
        .navigationTitle(proposal.label)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .overlay { if isWorking { ProgressView().controlSize(.large) } }
        .sensoryFeedback(.success, trigger: proposal.status) { _, status in status == "executed" }
        .confirmationDialog("Publish this now?", isPresented: $showPublishConfirmation, titleVisibility: .visible) {
            Button("Publish") { Task { await publish() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Once published, anyone can see it.")
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 14) {
            IconTile(systemImage: proposal.isSite ? "globe" : "text.bubble.fill", size: 48)
            VStack(alignment: .leading, spacing: 8) {
                Text(proposal.summary).font(Theme.heading(.title2))
                StatusPill(status: proposal.status)
            }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel(proposal.isSite ? "Website" : "Exactly what will be posted")
            VStack(alignment: .leading, spacing: 10) {
                if proposal.isPost {
                    Text(proposal.postText ?? "")
                        .font(.body)
                        .textSelection(.enabled)
                    if let link = proposal.postLink, let url = URL(string: link) {
                        Link(destination: url) { Label(link, systemImage: "link") }
                            .font(.callout)
                    }
                } else {
                    Text("Publishes every file currently in your website, exactly as you can preview it in the Website tab.")
                        .foregroundStyle(.secondary)
                }
            }
            .glowCard()
        }
    }

    private var decision: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel("Your decision")
            VStack(alignment: .leading, spacing: 16) {
                ForEach(proposal.requiredAttestations) { check in
                    Toggle(isOn: binding(for: check.id)) {
                        Text(check.message).font(.callout)
                    }
                }
                if proposal.tainted {
                    Toggle("I've checked this. It used content from the web, and it says only what I intend.", isOn: $acknowledgedTaint)
                        .font(.callout)
                }
                if !proposal.canBeCarriedOut {
                    Text("There's no connected account that can publish this yet.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Button {
                    showPublishConfirmation = true
                } label: {
                    Label("Approve and publish", systemImage: "checkmark.seal.fill")
                        .font(.body.weight(.semibold))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
                .disabled(!canApprove || isWorking)

                Button(role: .destructive) {
                    Task {
                        isWorking = true
                        await model.reject(proposal)
                        refreshFromModel()
                        isWorking = false
                    }
                } label: {
                    Text("Decline").frame(maxWidth: .infinity)
                }
                .buttonStyle(.glass)
                .disabled(isWorking)
            }
            .glowCard()
        }
    }

    private func outcome(_ result: Proposal.Outcome) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel("Outcome", color: result.ok ? .green : .red)
            VStack(alignment: .leading, spacing: 12) {
                Label(result.detail, systemImage: result.ok ? "checkmark.circle.fill" : "xmark.circle.fill")
                    .foregroundStyle(result.ok ? .green : .red)
                if let ref = result.ref, let url = URL(string: ref) {
                    Link(destination: url) {
                        Label("Open", systemImage: "arrow.up.right")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glass)
                }
            }
            .glowCard()
        }
        .transition(.scale(scale: 0.95).combined(with: .opacity))
    }

    private var canApprove: Bool {
        proposal.isPending && proposal.canBeCarriedOut && !proposal.isBlocked
            && proposal.requiredAttestations.allSatisfy { confirmed.contains($0.id) }
            && (!proposal.tainted || acknowledgedTaint)
    }

    private func binding(for id: String) -> Binding<Bool> {
        Binding {
            confirmed.contains(id)
        } set: { on in
            if on { confirmed.insert(id) } else { confirmed.remove(id) }
        }
    }

    private func publish() async {
        isWorking = true
        defer { isWorking = false }
        let attestations = proposal.requiredAttestations.map(\.id).filter(confirmed.contains)
        if let updated = await model.approveAndCarryOut(proposal, attestations: attestations, acknowledgeTaint: acknowledgedTaint) {
            proposal = updated
        } else {
            refreshFromModel()
        }
    }

    private func refreshFromModel() {
        if let latest = model.proposals.first(where: { $0.id == proposal.id }) { proposal = latest }
    }
}

#Preview {
    ReviewView()
        .environment(AppModel())
}
