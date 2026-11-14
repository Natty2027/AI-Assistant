import SwiftUI

/// A poster Hera designed: pick a size and a style, then share it (to Instagram, Messages, Photos,
/// Print…). Drawn on this device with the brand kit, so changes show instantly and cost nothing.
struct PosterCard: View {
    @State private var poster: PosterDraft
    @State private var size: PosterSize = .square
    @Environment(AppModel.self) private var model

    init(poster: PosterDraft) {
        _poster = State(initialValue: poster)
    }

    private var photo: CGImage? { model.lastRunPhoto.flatMap(PosterView.image(from:)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            preview
            Picker("Size", selection: $size) {
                ForEach(PosterSize.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            Text(size.detail).font(.caption).foregroundStyle(.secondary)

            HStack(spacing: 10) {
                ShareLink(item: PosterExport(poster: poster, brand: model.brand.kit, size: size, photo: model.lastRunPhoto),
                          preview: SharePreview(poster.headline, image: Image(systemName: "photo"))) {
                    Label("Share", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.glassProminent)
                Menu {
                    Picker("Style", selection: $poster.style) {
                        ForEach(PosterDraft.Style.allCases) { Text($0.title).tag($0) }
                    }
                } label: {
                    Label("Style: \(poster.style.title)", systemImage: "paintbrush")
                }
                .buttonStyle(.glass)
            }
            .controlSize(.small)

            if let problems = poster.problems, !problems.isEmpty {
                CheckList(checks: problems)
            }
            if model.brand.kit.logo == nil && model.brand.kit.businessName.isEmpty {
                Label("Add your logo and colors in Settings → Brand kit to use them on every poster.", systemImage: "paintpalette")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .glowCard()
    }

    /// The poster at its real size, scaled down to fit the card.
    private var preview: some View {
        let pixels = size.pixels
        return GeometryReader { geo in
            let scale = geo.size.width / pixels.width
            PosterView(poster: poster, brand: model.brand.kit, size: size, photo: photo)
                .scaleEffect(scale, anchor: .topLeading)
                .frame(width: geo.size.width, height: pixels.height * scale, alignment: .topLeading)
        }
        .aspectRatio(pixels.width / pixels.height, contentMode: .fit)
        .frame(maxHeight: size == .story || size == .flyer ? 520 : nil)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Poster: \(poster.headline). \(poster.details.joined(separator: ", "))")
        .animation(.spring(duration: 0.35), value: size)
        .animation(.spring(duration: 0.35), value: poster.style)
    }
}
