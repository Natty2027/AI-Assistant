import CoreGraphics
import Foundation
import ImageIO
import SwiftUI
import Testing
import UniformTypeIdentifiers
@testable import CyberCompanion

/// The Content Studio: posters drawn on the device in every size, with the brand kit.
@MainActor
struct StudioTests {
    private let poster = PosterDraft(id: "p1", style: .bold, headline: "Pottery Workshop", subheadline: "Make your own mug",
                                     details: ["Sat, Nov 20 · 6 PM", "Clay Corner", "$40"], callToAction: "Book now",
                                     footer: "claycorner.com", emoji: "🏺", usePhoto: false, problems: nil)

    @Test(arguments: PosterSize.allCases)
    func everySizeRendersAtItsExactPixels(size: PosterSize) throws {
        for style in PosterDraft.Style.allCases {
            var p = poster
            p.style = style
            let png = try #require(PosterExport(poster: p, brand: BrandKit(businessName: "Clay Corner"), size: size, photo: nil).renderPNG())
            let source = try #require(CGImageSourceCreateWithData(png as CFData, nil))
            let props = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
            #expect(props[kCGImagePropertyPixelWidth] as? Int == Int(size.pixels.width), "\(style) \(size)")
            #expect(props[kCGImagePropertyPixelHeight] as? Int == Int(size.pixels.height), "\(style) \(size)")
            if size == .flyer { #expect(props[kCGImagePropertyDPIWidth] as? Double == 300, "prints at Letter size") }
        }
    }

    @Test func aPosterWithAPhotoUsesIt() throws {
        var p = poster
        p.usePhoto = true
        let jpeg = try #require(Self.solidJPEG())
        #expect(PosterExport(poster: p, brand: BrandKit(), size: .square, photo: jpeg).renderPNG() != nil)
    }

    @Test func brandColorsRoundTripThroughHex() {
        let color = Color(hex: "#5B4BDB")
        #expect(color?.hexString() == "#5B4BDB")
        #expect(Color(hex: "F2A541")?.hexString() == "#F2A541")
        #expect(Color(hex: "not a color") == nil)
    }

    @Test func logosAreKeptAsSmallPNGs() throws {
        let jpeg = try #require(Self.solidJPEG(width: 2000, height: 1000))
        let png = try #require(BrandKitStore.logoPNG(from: jpeg))
        let source = try #require(CGImageSourceCreateWithData(png as CFData, nil))
        #expect(CGImageSourceGetType(source) as String? == UTType.png.identifier)
        let props = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        #expect(props[kCGImagePropertyPixelWidth] as? Int == 512)
        #expect(BrandKitStore.logoPNG(from: Data("not an image".utf8)) == nil)
    }

    @Test func readsPostersFromTheServer() throws {
        let json = #"{"status":"done","text":"","proposals":[],"drafts":[],"tainted":false,"posterDrafts":[{"id":"p_1","style":"elegant","headline":"Open House","subheadline":null,"details":["Sat 10–2"],"callToAction":"Drop by","footer":null,"emoji":"🏡","usePhoto":false,"problems":[]}]}"#
        let run = try JSONDecoder().decode(AgentRunResponse.self, from: Data(json.utf8))
        #expect(run.posterDrafts?.first?.style == .elegant)
        #expect(LaunchKitSummary(run: run) == nil, "one kind of thing: no overview")
    }

    @Test func studioLeadsTheCreateScreen() {
        #expect(CreateMode.displayOrder == [.launch, .posts, .site, .schedule])
        #expect(CreateMode.posts.title == "Studio")
        #expect(CreateMode.posts.rawValue == "posts", "the server's name doesn't change")
    }

    private static func solidJPEG(width: Int = 400, height: Int = 300) -> Data? {
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        context.setFillColor(CGColor(red: 0.3, green: 0.5, blue: 0.8, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        guard let image = context.makeImage() else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, nil)
        return CGImageDestinationFinalize(dest) ? out as Data : nil
    }
}
