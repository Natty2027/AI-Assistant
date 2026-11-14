import CoreGraphics
import CoreTransferable
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

/// The sizes every poster comes in, in pixels.
enum PosterSize: String, CaseIterable, Identifiable, Sendable {
    case square, story, banner, flyer
    var id: Self { self }

    var title: String {
        switch self {
        case .square: "Post"
        case .story: "Story"
        case .banner: "Banner"
        case .flyer: "Flyer"
        }
    }

    var detail: String {
        switch self {
        case .square: "Square post, 1080 × 1080"
        case .story: "Story or Reel cover, 1080 × 1920"
        case .banner: "Facebook, X or email banner, 1200 × 630"
        case .flyer: "Printable flyer, US Letter at 300 dpi"
        }
    }

    var pixels: CGSize {
        switch self {
        case .square: CGSize(width: 1080, height: 1080)
        case .story: CGSize(width: 1080, height: 1920)
        case .banner: CGSize(width: 1200, height: 630)
        case .flyer: CGSize(width: 2550, height: 3300)
        }
    }
}

/// One poster, drawn. Everything is laid out in proportion to the poster's size, so the same words
/// and style make a square post, a Story, a banner and a printable flyer.
struct PosterView: View {
    let poster: PosterDraft
    let brand: BrandKit
    let size: PosterSize
    /// The photo the person attached, used when the poster asks for it.
    var photo: CGImage?

    private var canvas: CGSize { size.pixels }
    /// One "point" of the design: everything is sized in these, relative to the shorter side.
    private var unit: CGFloat { min(canvas.width, canvas.height) / 1080 }
    private var isWide: Bool { canvas.width > canvas.height * 1.3 }
    private var showsPhoto: Bool { poster.usePhoto && photo != nil }

    var body: some View {
        ZStack {
            background
            content
                .padding(.horizontal, 80 * unit)
                .padding(.vertical, (isWide ? 56 : 96) * unit)
        }
        .frame(width: canvas.width, height: canvas.height)
        .clipped()
        .environment(\.colorScheme, .light)
    }

    /* ---------------- styles ---------------- */

    private var ink: Color {
        switch poster.style {
        case .bold, .playful: .white
        case .elegant: Color(red: 0.16, green: 0.14, blue: 0.13)
        case .minimal: Color(red: 0.1, green: 0.1, blue: 0.12)
        }
    }

    private var headlineFont: Font {
        let size = (isWide ? 104 : 132) * unit
        switch poster.style {
        case .bold: return .system(size: size, weight: .black)
        case .elegant: return .system(size: size * 0.9, weight: .regular, design: .serif)
        case .playful: return .system(size: size, weight: .heavy, design: .rounded)
        case .minimal: return .system(size: size * 0.85, weight: .semibold)
        }
    }

    private func bodyFont(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        switch poster.style {
        case .elegant: .system(size: size * unit, weight: weight, design: .serif)
        case .playful: .system(size: size * unit, weight: weight, design: .rounded)
        default: .system(size: size * unit, weight: weight)
        }
    }

    @ViewBuilder
    private var background: some View {
        switch poster.style {
        case .bold:
            ZStack {
                brand.primary
                if showsPhoto, let photo {
                    Image(decorative: photo, scale: 1).resizable().scaledToFill()
                        .frame(width: canvas.width, height: canvas.height).clipped()
                    LinearGradient(colors: [brand.primary.opacity(0.35), brand.primary.opacity(0.92)], startPoint: .top, endPoint: .bottom)
                }
            }
        case .elegant:
            ZStack {
                Color(red: 0.98, green: 0.96, blue: 0.93)
                RoundedRectangle(cornerRadius: 8 * unit)
                    .strokeBorder(brand.primary.opacity(0.7), lineWidth: 6 * unit)
                    .padding(36 * unit)
            }
        case .playful:
            ZStack {
                LinearGradient(colors: [brand.primary, brand.accent], startPoint: .topLeading, endPoint: .bottomTrailing)
                Circle().fill(.white.opacity(0.12)).frame(width: 700 * unit).offset(x: canvas.width * 0.38, y: -canvas.height * 0.32)
                Circle().fill(.white.opacity(0.10)).frame(width: 520 * unit).offset(x: -canvas.width * 0.4, y: canvas.height * 0.36)
            }
        case .minimal:
            ZStack(alignment: .leading) {
                Color.white
                Rectangle().fill(brand.primary).frame(width: 24 * unit)
            }
        }
    }

    /* ---------------- content ---------------- */

    @ViewBuilder
    private var content: some View {
        if isWide {
            HStack(spacing: 56 * unit) {
                if showsPhoto, poster.style != .bold, let photo { photoTile(photo, side: canvas.height - 112 * unit) }
                words.frame(maxWidth: .infinity, alignment: alignment)
                if !showsPhoto || poster.style == .bold { logo(height: 140 * unit) }
            }
        } else {
            VStack(spacing: 40 * unit) {
                logo(height: 120 * unit)
                if showsPhoto, poster.style != .bold, let photo {
                    photoTile(photo, side: min(canvas.width - 160 * unit, canvas.height * 0.36))
                }
                Spacer(minLength: 0)
                words
                Spacer(minLength: 0)
                footerLine
            }
        }
    }

    private var alignment: Alignment { poster.style == .minimal ? .leading : .center }
    private var textAlignment: TextAlignment { poster.style == .minimal ? .leading : .center }

    private var words: some View {
        VStack(alignment: poster.style == .minimal ? .leading : .center, spacing: 28 * unit) {
            if let emoji = poster.emoji {
                Text(emoji).font(.system(size: (isWide ? 80 : 120) * unit))
            }
            Text(poster.style == .bold ? poster.headline.uppercased() : poster.headline)
                .font(headlineFont)
                .foregroundStyle(poster.style == .minimal || poster.style == .elegant ? brand.primary : ink)
                .lineLimit(3)
                .minimumScaleFactor(0.4)
            if let sub = poster.subheadline {
                Text(sub).font(bodyFont(isWide ? 40 : 50, weight: .medium)).foregroundStyle(ink.opacity(0.9)).lineLimit(2).minimumScaleFactor(0.5)
            }
            if !poster.details.isEmpty {
                VStack(alignment: poster.style == .minimal ? .leading : .center, spacing: 12 * unit) {
                    ForEach(poster.details, id: \.self) { line in
                        Text(line).font(bodyFont(isWide ? 34 : 44, weight: .semibold)).foregroundStyle(ink).lineLimit(1).minimumScaleFactor(0.5)
                    }
                }
                .padding(.top, 8 * unit)
            }
            if let cta = poster.callToAction {
                Text(cta)
                    .font(bodyFont(isWide ? 34 : 44, weight: .bold))
                    .foregroundStyle(poster.style == .playful || poster.style == .bold ? brand.primary : .white)
                    .padding(.horizontal, 48 * unit)
                    .padding(.vertical, 22 * unit)
                    .background(poster.style == .playful || poster.style == .bold ? Color.white : brand.accent, in: Capsule())
                    .rotationEffect(.degrees(poster.style == .playful ? -3 : 0))
                    .padding(.top, 12 * unit)
            }
            if isWide { footerLine }
        }
        .multilineTextAlignment(textAlignment)
    }

    @ViewBuilder
    private var footerLine: some View {
        let parts = [brand.businessName.isEmpty ? nil : brand.businessName, poster.footer].compactMap { $0 }
        if !parts.isEmpty {
            Text(parts.joined(separator: "  ·  "))
                .font(bodyFont(isWide ? 28 : 34, weight: .medium))
                .foregroundStyle(ink.opacity(0.8))
                .lineLimit(1).minimumScaleFactor(0.5)
                .frame(maxWidth: .infinity, alignment: alignment)
        }
    }

    @ViewBuilder
    private func logo(height: CGFloat) -> some View {
        if let data = brand.logo, let image = Self.image(from: data) {
            Image(decorative: image, scale: 1).resizable().scaledToFit().frame(height: height)
                .frame(maxWidth: .infinity, alignment: alignment)
        }
    }

    private func photoTile(_ photo: CGImage, side: CGFloat) -> some View {
        Image(decorative: photo, scale: 1).resizable().scaledToFill()
            .frame(width: side, height: side)
            .clipShape(RoundedRectangle(cornerRadius: (poster.style == .playful ? 48 : 16) * unit, style: .continuous))
            .shadow(color: .black.opacity(0.18), radius: 20 * unit, y: 8 * unit)
    }

    nonisolated static func image(from data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }
}

/* ---------------- export ---------------- */

/// A poster ready to share: rendered to PNG only when the share sheet asks for it.
struct PosterExport: Transferable {
    let poster: PosterDraft
    let brand: BrandKit
    let size: PosterSize
    let photo: Data?

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: .png) { export in
            guard let png = await export.renderPNG() else { throw CocoaError(.fileWriteUnknown) }
            return png
        }
        .suggestedFileName { "\($0.poster.headline) – \($0.size.title).png" }
    }

    @MainActor
    func renderPNG() -> Data? {
        let view = PosterView(poster: poster, brand: brand, size: size, photo: photo.flatMap(PosterView.image(from:)))
        let renderer = ImageRenderer(content: view)
        renderer.scale = 1
        renderer.proposedSize = ProposedViewSize(size.pixels)
        guard let image = renderer.cgImage else { return nil }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil) else { return nil }
        // 300 dpi for the printable flyer, so it prints at Letter size.
        let dpi: Double = size == .flyer ? 300 : 72
        CGImageDestinationAddImage(destination, image, [kCGImagePropertyDPIWidth: dpi, kCGImagePropertyDPIHeight: dpi] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? out as Data : nil
    }
}

#Preview("Styles") {
    let poster = PosterDraft(id: "p1", style: .playful, headline: "Pottery Workshop", subheadline: "Make your own mug",
                             details: ["Sat, Nov 20 · 6 PM", "Clay Corner, 12 Main St", "$40 · 8 spots"],
                             callToAction: "Book now", footer: "claycorner.com", emoji: "🏺✨", usePhoto: false, problems: nil)
    let brand = BrandKit(businessName: "Clay Corner", primaryHex: "#5B4BDB", accentHex: "#F2A541")
    ScrollView {
        VStack(spacing: 16) {
            ForEach(PosterDraft.Style.allCases) { style in
                var p = poster
                let _ = (p.style = style)
                PosterView(poster: p, brand: brand, size: .square).scaleEffect(0.3).frame(width: 324, height: 324)
            }
        }
    }
}

#Preview("Sizes") {
    let poster = PosterDraft(id: "p1", style: .bold, headline: "Open House", subheadline: "Tour the studio, meet the team",
                             details: ["Saturday · 10 AM – 2 PM", "Clay Corner, 12 Main St", "Free · All ages"],
                             callToAction: "RSVP today", footer: "claycorner.com", emoji: "🏡", usePhoto: false, problems: nil)
    let brand = BrandKit(businessName: "Clay Corner", primaryHex: "#1F6F5C", accentHex: "#F2A541")
    HStack(alignment: .top, spacing: 12) {
        PosterView(poster: poster, brand: brand, size: .story).scaleEffect(0.16, anchor: .topLeading).frame(width: 173, height: 307, alignment: .topLeading)
        VStack(spacing: 12) {
            var minimal = poster
            let _ = (minimal.style = .minimal)
            PosterView(poster: minimal, brand: brand, size: .banner).scaleEffect(0.16, anchor: .topLeading).frame(width: 192, height: 101, alignment: .topLeading)
            var elegant = poster
            let _ = (elegant.style = .elegant)
            PosterView(poster: elegant, brand: brand, size: .flyer).scaleEffect(0.068, anchor: .topLeading).frame(width: 173, height: 224, alignment: .topLeading)
        }
    }
    .padding()
}
