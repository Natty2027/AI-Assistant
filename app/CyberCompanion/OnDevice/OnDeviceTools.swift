import SwiftUI

/// Rewrite, and for posts hashtag ideas, done on this device by Apple's model. The result replaces
/// the editable text, with Undo to go back. Hidden entirely when the model isn't available (an
/// older device, or Apple Intelligence off).
struct OnDeviceTools: View {
    @Binding var text: String
    /// The most the text may be, counted with `measure`. nil for no limit.
    var characterLimit: Int? = nil
    var measure: (String) -> Int = { $0.count }
    /// Posts only: suggest hashtags to add.
    var offersHashtags = false

    @Environment(AppModel.self) private var model
    private enum Job: Equatable { case rewrite, hashtags }
    @State private var working: Job?
    @State private var suggested: [String] = []
    /// The text before the last rewrite, for Undo.
    @State private var previous: String?
    @State private var problem: String?

    var body: some View {
        if model.onDevice.isAvailable {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    Menu {
                        ForEach(RewriteStyle.allCases) { style in
                            Button(style.title, systemImage: style.systemImage) { Task { await rewrite(style) } }
                        }
                    } label: {
                        busyLabel("Rewrite", systemImage: "wand.and.stars", busy: working == .rewrite)
                    }
                    .menuIndicator(.hidden)
                    .buttonStyle(.glass)
                    .disabled(working != nil || isEmpty)

                    if offersHashtags {
                        Button { Task { await suggestHashtags() } } label: {
                            busyLabel("Hashtags", systemImage: "number", busy: working == .hashtags)
                        }
                        .buttonStyle(.glass)
                        .disabled(working != nil || isEmpty)
                    }

                    if let previous, working == nil {
                        Button("Undo", systemImage: "arrow.uturn.backward") {
                            text = previous
                            self.previous = nil
                        }
                        .buttonStyle(.glass)
                    }
                }
                .controlSize(.small)
                .lineLimit(1)
                .help("Runs on this device with Apple Intelligence: instant, private and free.")

                if !suggested.isEmpty { hashtagChoices }
                if let problem {
                    Text(problem)
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .animation(.spring(duration: 0.3), value: suggested)
        }
    }

    /// The suggestions, each tapped to add it, or all at once.
    private var hashtagChoices: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                Button("Add all", systemImage: "plus") { add(suggested) }
                    .buttonStyle(.glassProminent)
                ForEach(suggested, id: \.self) { tag in
                    Button(tag) { add([tag]) }
                        .buttonStyle(.glass)
                        .accessibilityLabel("Add \(tag)")
                }
            }
            .controlSize(.small)
            .lineLimit(1)
            .padding(.vertical, 2)
        }
        .scrollIndicators(.hidden)
    }

    /// A title that keeps its size while a progress view shows in its place.
    private func busyLabel(_ title: String, systemImage: String, busy: Bool) -> some View {
        ZStack {
            Label(title, systemImage: systemImage).opacity(busy ? 0 : 1)
            if busy { ProgressView().controlSize(.small) }
        }
    }

    private var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private func rewrite(_ style: RewriteStyle) async {
        working = .rewrite
        problem = nil
        defer { working = nil }
        let before = text
        do {
            let rewritten = try await model.onDevice.rewrite(before, style: style, characterLimit: characterLimit, measure: measure)
            // Left alone if the person edited it while the rewrite was running.
            guard text == before else { return }
            previous = before
            text = rewritten
        } catch is CancellationError {
        } catch {
            problem = error.localizedDescription
        }
    }

    private func suggestHashtags() async {
        working = .hashtags
        problem = nil
        defer { working = nil }
        do {
            suggested = try await model.onDevice.hashtags(for: text)
        } catch is CancellationError {
        } catch {
            problem = error.localizedDescription
        }
    }

    private func add(_ tags: [String]) {
        let updated = OnDeviceHera.appending(tags, to: text, limit: characterLimit, measure: measure)
        let added = tags.filter { updated.localizedCaseInsensitiveContains($0) }
        if added.count < tags.count { problem = "Some hashtags didn't fit within the character limit." }
        previous = text
        text = updated
        suggested.removeAll { tag in tags.contains(tag) }
    }
}
