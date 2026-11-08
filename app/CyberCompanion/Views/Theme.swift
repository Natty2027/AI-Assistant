import SwiftUI

/// The app's visual language. Content sits on standard materials; Liquid Glass is kept for the
/// controls people touch (the voice orb, the composer, primary buttons), as Apple's guidelines
/// recommend. Every animation here stops when Reduce Motion is on.
enum Theme {
    static let cornerRadius: CGFloat = 24

    /// Electric cyan → indigo → violet: the signature gradient for glows and highlights.
    static let spectrum: [Color] = [
        Color(red: 0.31, green: 0.82, blue: 0.97),
        Color(red: 0.38, green: 0.44, blue: 0.98),
        Color(red: 0.66, green: 0.36, blue: 0.96),
        Color(red: 0.31, green: 0.82, blue: 0.97),
    ]

    static var spectrumGradient: LinearGradient {
        LinearGradient(colors: Array(spectrum.dropLast()), startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    static func heading(_ style: Font.TextStyle = .largeTitle) -> Font {
        .system(style, design: .rounded, weight: .bold)
    }
}

/* ---------------- background ---------------- */

/// A slowly drifting aurora behind every screen: deep space in dark mode, soft pearl in light.
struct AuroraBackground: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
            let t = reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate
            MeshGradient(width: 3, height: 3, points: points(at: t), colors: colors, smoothsColors: true)
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }

    /// The middle points wander on slow, out-of-phase orbits so the light never visibly loops.
    private func points(at t: Double) -> [SIMD2<Float>] {
        func drift(_ speed: Double, _ phase: Double, _ amount: Float) -> Float {
            Float(sin(t * speed + phase)) * amount
        }
        return [
            [0, 0], [0.5 + drift(0.11, 0, 0.12), 0], [1, 0],
            [0, 0.5 + drift(0.09, 1, 0.1)], [0.5 + drift(0.13, 2, 0.15), 0.5 + drift(0.07, 3, 0.15)], [1, 0.5 + drift(0.1, 4, 0.1)],
            [0, 1], [0.5 + drift(0.08, 5, 0.12), 1], [1, 1],
        ]
    }

    private var colors: [Color] {
        if colorScheme == .dark {
            return [
                Color(red: 0.03, green: 0.04, blue: 0.10), Color(red: 0.07, green: 0.08, blue: 0.22), Color(red: 0.04, green: 0.05, blue: 0.14),
                Color(red: 0.05, green: 0.16, blue: 0.26), Color(red: 0.20, green: 0.10, blue: 0.38), Color(red: 0.04, green: 0.20, blue: 0.30),
                Color(red: 0.03, green: 0.05, blue: 0.12), Color(red: 0.10, green: 0.06, blue: 0.22), Color(red: 0.02, green: 0.03, blue: 0.08),
            ]
        }
        return [
            Color(red: 0.95, green: 0.96, blue: 1.00), Color(red: 0.90, green: 0.94, blue: 1.00), Color(red: 0.97, green: 0.95, blue: 1.00),
            Color(red: 0.88, green: 0.96, blue: 0.99), Color(red: 0.93, green: 0.90, blue: 1.00), Color(red: 0.89, green: 0.97, blue: 0.98),
            Color(red: 0.97, green: 0.97, blue: 1.00), Color(red: 0.94, green: 0.92, blue: 1.00), Color(red: 0.96, green: 0.98, blue: 1.00),
        ]
    }
}

extension View {
    /// Puts the aurora behind a screen and lets scrolling content and forms show it.
    func auroraBackground() -> some View {
        self
            .scrollContentBackground(.hidden)
            .background { AuroraBackground() }
    }

    /// A frosted content card with a fine light-catching edge.
    func glowCard(padding: CGFloat = 18) -> some View {
        modifier(GlowCard(padding: padding))
    }
}

private struct GlowCard: ViewModifier {
    let padding: CGFloat
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: Theme.cornerRadius, style: .continuous)
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.regularMaterial, in: shape)
            .overlay {
                shape.strokeBorder(
                    LinearGradient(colors: [.white.opacity(colorScheme == .dark ? 0.28 : 0.7), Theme.spectrum[1].opacity(0.25), .clear],
                                   startPoint: .topLeading, endPoint: .bottomTrailing),
                    lineWidth: 1)
            }
            .shadow(color: Theme.spectrum[1].opacity(colorScheme == .dark ? 0.25 : 0.10), radius: 24, y: 10)
    }
}

/* ---------------- small pieces ---------------- */

/// A small monospaced label above a group, with a glowing dot: "● POSTS TO SHARE".
struct SectionLabel: View {
    let title: String
    var color: Color = Theme.spectrum[0]

    init(_ title: String, color: Color = Theme.spectrum[0]) {
        self.title = title
        self.color = color
    }

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
                .shadow(color: color, radius: 4)
            Text(title.uppercased())
                .font(.caption.monospaced().weight(.semibold))
                .tracking(1.5)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// A thin beam of light that sweeps while the assistant works.
struct ThinkingBeam: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if reduceMotion {
            ProgressView().frame(maxWidth: .infinity)
        } else {
            TimelineView(.animation) { context in
                let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6
                GeometryReader { geo in
                    Capsule()
                        .fill(.quaternary)
                        .overlay(alignment: .leading) {
                            Capsule()
                                .fill(Theme.spectrumGradient)
                                .frame(width: geo.size.width * 0.35)
                                .offset(x: (geo.size.width * 1.35) * phase - geo.size.width * 0.35)
                                .shadow(color: Theme.spectrum[0], radius: 6)
                        }
                        .clipShape(.capsule)
                }
            }
            .frame(height: 4)
            .accessibilityLabel("Working")
        }
    }
}

/// A rotating spectrum edge, drawn around the composer while the assistant works.
struct SpectrumEdge: View {
    var cornerRadius: CGFloat
    var isActive: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if isActive {
            TimelineView(.animation(paused: reduceMotion)) { context in
                let angle = reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate * 120
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(AngularGradient(colors: Theme.spectrum, center: .center, angle: .degrees(angle)), lineWidth: 2)
                    .shadow(color: Theme.spectrum[1].opacity(0.6), radius: 10)
            }
            .allowsHitTesting(false)
            .transition(.opacity)
        }
    }
}

/// A status shown as a glowing dot and a word.
struct StatusPill: View {
    let status: String

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
                .shadow(color: color, radius: 3)
            Text(title)
                .font(.caption.weight(.semibold))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(color.opacity(0.14), in: .capsule)
        .foregroundStyle(color)
        .accessibilityElement(children: .combine)
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
        case "pending": Theme.spectrum[0]
        case "executed": .green
        case "blocked", "failed": .red
        case "approved", "executing": Theme.spectrum[2]
        default: .secondary
        }
    }
}

/// An icon in a softly glowing tile, used for platforms and kinds of action.
struct IconTile: View {
    let systemImage: String
    var size: CGFloat = 36

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: size * 0.45, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Theme.spectrumGradient, in: RoundedRectangle(cornerRadius: size * 0.3, style: .continuous))
            .shadow(color: Theme.spectrum[1].opacity(0.4), radius: 6, y: 2)
            .accessibilityHidden(true)
    }
}

#Preview {
    ScrollView {
        VStack(alignment: .leading, spacing: 20) {
            SectionLabel("Posts to share")
            Text("A frosted card").glowCard()
            ThinkingBeam()
            HStack { StatusPill(status: "pending"); StatusPill(status: "executed") }
            IconTile(systemImage: "globe")
        }
        .padding()
    }
    .auroraBackground()
}
