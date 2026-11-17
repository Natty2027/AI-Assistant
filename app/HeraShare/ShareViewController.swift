import Social
import UIKit

/// "Hera" in the share sheet: share a text message (or any text) and Hera reads it to you and
/// helps you reply the next time you open her. An extension can't open its app, so the text is
/// left in the app group Hera reads from (SharedTexts in the app), and nothing leaves the phone
/// until the person asks Hera for help with it.
final class ShareViewController: SLComposeServiceViewController {
    private static let appGroup = "group.com.natty2027.hera"
    private static let key = "sharedTexts"

    private struct Item: Codable {
        let text: String
        let sharedAt: Date
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Hera"
        placeholder = "Paste or type the text for Hera"
        navigationController?.navigationBar.topItem?.rightBarButtonItem?.title = "Save for Hera"
    }

    override func isContentValid() -> Bool {
        !(contentText ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    override func didSelectPost() {
        let text = (contentText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty, let defaults = UserDefaults(suiteName: Self.appGroup) {
            var items = defaults.data(forKey: Self.key).flatMap { try? JSONDecoder().decode([Item].self, from: $0) } ?? []
            items.append(Item(text: String(text.prefix(4000)), sharedAt: .now))
            if let data = try? JSONEncoder().encode(items.suffix(5)) { defaults.set(data, forKey: Self.key) }
        }
        extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }

    override func configurationItems() -> [Any]! {
        let next = SLComposeSheetConfigurationItem()
        next?.title = "Next"
        next?.value = "Open Hera to hear it and reply"
        return [next as Any]
    }
}
