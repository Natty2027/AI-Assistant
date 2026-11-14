import CoreGraphics
import Foundation
import ImageIO
import Observation
import SwiftUI
import UniformTypeIdentifiers

/// The business's look: its name, two colors and a logo. Set once in Settings and used on every
/// poster, so everything Hera makes looks like it came from the same place. Kept on this device.
struct BrandKit: Codable, Equatable, Sendable {
    var businessName: String = ""
    /// Hex, e.g. "#5B4BDB". The main color: backgrounds and headlines.
    var primaryHex: String = "#5B4BDB"
    /// Hex. The accent: buttons, highlights.
    var accentHex: String = "#F2A541"
    /// PNG, at most 512 pixels on its long side. Stored as its own file, not in this record.
    var logo: Data?

    var primary: Color { Color(hex: primaryHex) ?? .indigo }
    var accent: Color { Color(hex: accentHex) ?? .orange }

    private enum CodingKeys: String, CodingKey { case businessName, primaryHex, accentHex }
}

/// Loads and saves the brand kit in Application Support.
@MainActor
@Observable
final class BrandKitStore {
    private(set) var kit: BrandKit

    private static var folder: URL {
        URL.applicationSupportDirectory.appending(path: "BrandKit", directoryHint: .isDirectory)
    }
    private static var recordURL: URL { folder.appending(path: "brand.json") }
    private static var logoURL: URL { folder.appending(path: "logo.png") }

    init() {
        var kit = (try? Data(contentsOf: Self.recordURL)).flatMap { try? JSONDecoder().decode(BrandKit.self, from: $0) } ?? BrandKit()
        kit.logo = try? Data(contentsOf: Self.logoURL)
        self.kit = kit
    }

    func update(_ change: (inout BrandKit) -> Void) {
        var next = kit
        change(&next)
        kit = next
        save()
    }

    /// Takes any image (HEIC, JPEG, PNG…) and keeps it as a PNG of at most 512 pixels, so it stays
    /// sharp on posters but small on disk. Returns false if it isn't an image.
    @discardableResult
    func setLogo(from data: Data) -> Bool {
        guard let png = Self.logoPNG(from: data) else { return false }
        update { $0.logo = png }
        return true
    }

    func removeLogo() { update { $0.logo = nil } }

    private func save() {
        try? FileManager.default.createDirectory(at: Self.folder, withIntermediateDirectories: true)
        if let record = try? JSONEncoder().encode(kit) { try? record.write(to: Self.recordURL, options: .atomic) }
        if let logo = kit.logo { try? logo.write(to: Self.logoURL, options: .atomic) }
        else { try? FileManager.default.removeItem(at: Self.logoURL) }
    }

    nonisolated static func logoPNG(from data: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 512,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        return CGImageDestinationFinalize(destination) ? out as Data : nil
    }
}

extension Color {
    /// "#RRGGBB" or "RRGGBB".
    init?(hex: String) {
        let digits = hex.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "#", with: "")
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return nil }
        self.init(red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255, blue: Double(value & 0xFF) / 255)
    }

    /// "#RRGGBB" for storing a picked color.
    func hexString(in environment: EnvironmentValues = EnvironmentValues()) -> String {
        let c = resolve(in: environment)
        func byte(_ v: Float) -> Int { Int((max(0, min(1, v)) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", byte(c.red), byte(c.green), byte(c.blue))
    }
}
