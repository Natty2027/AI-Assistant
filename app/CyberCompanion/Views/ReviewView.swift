import SwiftUI

/// Everything the assistant proposed. Nothing reaches the public until it's approved here.
struct ReviewView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            List {
                let pending = model.proposals.filter(\.isPending)
                let history = model.proposals.filter { !$0.isPending }
                if pending.isEmpty && history.isEmpty {
                    ContentUnavailableView("Nothing to review", systemImage: "checkmark.seal",
                                           description: Text("When the assistant has a website or post ready to publish, it shows up here for you to approve."))
                }
                if !pending.isEmpty {
                    Section("Waiting for you") {
                        ForEach(pending) { row($0) }
                    }
                }
                if !history.isEmpty {
                    Section("Earlier") {
                        ForEach(history) { row($0) }
                    }
                }
            }
            .navigationTitle("Review")
            .navigationDestination(for: Proposal.self) { ProposalDetailView(proposal: $0) }
            .refreshable { await model.refreshProposals() }
            .toolbar {
                Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.refreshProposals() } }
            }
            .task { await model.refreshProposals() }
        }
    }

    private func row(_ p: Proposal) -> some View {
        NavigationLink(value: p) {
            VStack(alignment: .leading, spacing: 4) {
                Label(p.label, systemImage: p.isSite ? "globe" : "text.bubble")
                    .font(.headline)
                Text(p.summary)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                StatusBadge(status: p.status)
            }
        }
    }
}

struct StatusBadge: View {
    let status: String

    var body: some View {
        Text(title)
            .font(.caption.bold())
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.2), in: .capsule)
            .foregroundStyle(color)
    }

    private var title: String {
        switch status {
        case "pending": "Needs approval"
        case "executed": "Published"
        case "blocked": "Blocked"
        case "failed": "Failed"
        case "rejected": "Declined"
        case "expired": "Expired"
        case "approved", "executing": "Publishing…"
        default: status.capitalized
        }
    }

    private var color: Color {
        switch status {
        case "pending": .blue
        case "executed": .green
        case "blocked", "failed": .red
        default: .secondary
        }
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
        Form {
            Section {
                Text(proposal.summary).font(.headline)
                StatusBadge(status: proposal.status)
            }

            Section(proposal.isSite ? "Website" : "Post") {
                if proposal.isPost {
                    Text(proposal.postText ?? "")
                        .textSelection(.enabled)
                    if let link = proposal.postLink, let url = URL(string: link) {
                        Link(link, destination: url)
                    }
                } else if proposal.isSite {
                    Text("Publishes every file currently in your website, exactly as you can preview it in the Website tab.")
                        .foregroundStyle(.secondary)
                }
            }

            if !proposal.checks.isEmpty {
                Section("Checks") { CheckList(checks: proposal.checks) }
            }

            if proposal.isPending {
                if !proposal.requiredAttestations.isEmpty {
                    Section("Confirm before publishing") {
                        ForEach(proposal.requiredAttestations) { check in
                            Toggle(isOn: binding(for: check.id)) {
                                Text(check.message).font(.callout)
                            }
                        }
                    }
                }
                if proposal.tainted {
                    Section {
                        Toggle("I've checked this. It used content from the web, and it says only what I intend.", isOn: $acknowledgedTaint)
                    }
                }
                Section {
                    if !proposal.canBeCarriedOut {
                        Text("There's no connected account that can publish this yet.")
                            .foregroundStyle(.secondary)
                    }
                    Button {
                        showPublishConfirmation = true
                    } label: {
                        Label("Approve and publish", systemImage: "checkmark.seal.fill")
                    }
                    .disabled(!canApprove || isWorking)

                    Button("Decline", role: .destructive) {
                        Task {
                            isWorking = true
                            await model.reject(proposal)
                            refreshFromModel()
                            isWorking = false
                        }
                    }
                    .disabled(isWorking)
                }
            }

            if let result = proposal.result {
                Section("Outcome") {
                    Label(result.detail, systemImage: result.ok ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .foregroundStyle(result.ok ? .green : .red)
                    if let ref = result.ref, let url = URL(string: ref) {
                        Link("Open", destination: url)
                    }
                }
            }

            if let message = model.errorMessage {
                Section { Text(message).foregroundStyle(.red) }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(proposal.label)
        .overlay { if isWorking { ProgressView() } }
        .confirmationDialog("Publish this now?", isPresented: $showPublishConfirmation, titleVisibility: .visible) {
            Button("Publish") { Task { await publish() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Once published, anyone can see it.")
        }
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
