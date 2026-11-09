import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import CyberCompanion

/// Photos are turned into JPEGs Instagram accepts: at most 1440 pixels, between 4:5 and 1.91:1.
struct PostPhotoTests {
    @Test(arguments: [
        (1000, 3000, 480, 600),     // too tall: shrunk to 480x1440, then cropped to 4:5
        (4000, 1000, 687, 360),     // too wide: shrunk to 1440x360, then cropped to 1.91:1
        (3000, 3000, 1440, 1440),   // square: only made smaller
    ])
    func photosAreShapedForInstagram(width: Int, height: Int, expectedWidth: Int, expectedHeight: Int) throws {
        let png = try #require(Self.png(width: width, height: height))
        let jpeg = try #require(PostPhoto.prepare(from: png))
        #expect(jpeg.prefix(3) == Data([0xFF, 0xD8, 0xFF]), "the server only accepts JPEG")
        let photo = try #require(PostPhoto(jpeg: jpeg))
        #expect(abs(photo.preview.width - expectedWidth) <= 2)
        #expect(abs(photo.preview.height - expectedHeight) <= 2)
    }

    @Test func somethingThatIsntAnImageIsRefused() {
        #expect(PostPhoto.prepare(from: Data("not an image".utf8)) == nil)
    }

    private static func png(width: Int, height: Int) -> Data? {
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.setFillColor(CGColor(red: 0.8, green: 0.4, blue: 0.2, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        guard let image = context.makeImage() else { return nil }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        return CGImageDestinationFinalize(destination) ? out as Data : nil
    }
}
