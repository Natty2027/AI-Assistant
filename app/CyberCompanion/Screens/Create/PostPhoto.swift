import CoreGraphics
import Foundation
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

/// A photo attached to a posts request, ready to upload: a JPEG that Instagram will accept.
struct PostPhoto: Equatable {
    let jpeg: Data
    let preview: CGImage

    /// Instagram feed photos must be between 4:5 (portrait) and 1.91:1 (landscape), and it
    /// downsizes anything wider than 1440 pixels anyway.
    private static let maxPixels = 1440
    private static let tallest = 4.0 / 5.0
    private static let widest = 1.91

    /// Turns any image the photo library hands back (HEIC, PNG, JPEG…) into an upright JPEG, at most
    /// 1440 pixels on its long side, center-cropped if it's taller or wider than Instagram allows.
    /// Returns nil if the data isn't an image.
    nonisolated static func prepare(from data: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,  // apply the camera's rotation
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              let cropped = cropToAllowedShape(image) else { return nil }

        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, cropped, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return out as Data
    }

    private nonisolated static func cropToAllowedShape(_ image: CGImage) -> CGImage? {
        let width = Double(image.width), height = Double(image.height)
        guard width > 0, height > 0 else { return nil }
        let ratio = width / height
        if ratio < tallest {
            let newHeight = (width / tallest).rounded(.down)
            return image.cropping(to: CGRect(x: 0, y: ((height - newHeight) / 2).rounded(.down), width: width, height: newHeight))
        }
        if ratio > widest {
            let newWidth = (height * widest).rounded(.down)
            return image.cropping(to: CGRect(x: ((width - newWidth) / 2).rounded(.down), y: 0, width: newWidth, height: height))
        }
        return image
    }

    init?(jpeg: Data) {
        guard let source = CGImageSourceCreateWithData(jpeg as CFData, nil),
              let preview = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        self.jpeg = jpeg
        self.preview = preview
    }
}
