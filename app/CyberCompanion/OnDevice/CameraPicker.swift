#if os(iOS)
import SwiftUI
import UIKit

/// The system camera, for "Snap it". It hands back an upright JPEG, at most 2048 pixels on its
/// long side: big enough for Vision to read small print, small enough to be quick.
struct CameraPicker: UIViewControllerRepresentable {
    /// False on devices without a camera (and in the simulator), or while another app uses it.
    static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    let onPhoto: (Data) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onPhoto: onPhoto, dismiss: { dismiss() })
    }

    @MainActor
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onPhoto: (Data) -> Void
        let dismiss: () -> Void

        init(onPhoto: @escaping (Data) -> Void, dismiss: @escaping () -> Void) {
            self.onPhoto = onPhoto
            self.dismiss = dismiss
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage, let jpeg = CameraPicker.uprightJPEG(image) {
                onPhoto(jpeg)
            }
            dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            dismiss()
        }
    }

    /// Drawing the photo applies the camera's rotation, so what's saved is the right way up
    /// whatever reads it next.
    static func uprightJPEG(_ image: UIImage, maxPixels: CGFloat = 2048) -> Data? {
        let longest = max(image.size.width, image.size.height)
        guard longest > 0 else { return nil }
        let scale = min(1, maxPixels / longest)
        let size = CGSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).jpegData(withCompressionQuality: 0.9) { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }
}
#endif
