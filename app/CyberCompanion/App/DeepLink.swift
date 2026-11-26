import Foundation

/// The hera:// addresses that open a place in the app. Tapping a scheduled post on the Lock
/// Screen opens hera://review/<proposal id>.
///
/// hera://connected is not one of them: the sign-in sheet that ends there reads it itself
/// (AccountsView), so it never arrives here.
enum DeepLink: Equatable {
    /// The Review tab, opened at one proposal when there's an id.
    case review(proposalId: String?)

    static func parse(_ url: URL) -> DeepLink? {
        guard url.scheme?.lowercased() == "hera", url.host()?.lowercased() == "review" else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard let id = parts.first else { return .review(proposalId: nil) }
        // Anyone can open a hera:// link, so only an id-shaped value is used.
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        guard parts.count == 1, id.count <= 128, id.unicodeScalars.allSatisfy(allowed.contains) else { return nil }
        return .review(proposalId: id)
    }
}
