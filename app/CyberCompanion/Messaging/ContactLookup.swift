import Contacts
import Foundation

/// Finds the phone numbers for a name the person said ("Sarah", "Mom"), in the Contacts on this
/// device. Only names go to the server; numbers are looked up here and never leave the phone.
enum ContactLookup {
    struct Match: Hashable, Identifiable, Sendable {
        let name: String
        let number: String
        /// "mobile", "home", "work"…
        let label: String
        var id: String { name + "|" + number }
    }

    enum Problem: Error, Equatable {
        /// The person said no to Contacts access, or it's restricted.
        case notAllowed
    }

    /// Every phone number of every contact whose name matches, mobile numbers first. Asks for
    /// Contacts access the first time (the system shows its own prompt).
    static func numbers(for name: String) async throws -> [Match] {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        let store = CNContactStore()
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .notDetermined:
            guard (try? await store.requestAccess(for: .contacts)) == true else { throw Problem.notAllowed }
        case .denied, .restricted:
            throw Problem.notAllowed
        default:
            break  // full or limited access: search what we're allowed to see
        }
        // Contacts searches can take a moment on a big address book; keep it off the main thread.
        return try await Task.detached(priority: .userInitiated) {
            try search(store, for: trimmed)
        }.value
    }

    private static func search(_ store: CNContactStore, for name: String) throws -> [Match] {
        let keys: [CNKeyDescriptor] = [
            CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactNicknameKey as CNKeyDescriptor,
        ]
        var contacts = try store.unifiedContacts(matching: CNContact.predicateForContacts(matchingName: name), keysToFetch: keys)
        if contacts.isEmpty {
            // "Mom", "Grandma": often saved as a nickname rather than a name.
            let all = CNContactFetchRequest(keysToFetch: keys)
            try store.enumerateContacts(with: all) { contact, _ in
                if contact.nickname.localizedCaseInsensitiveCompare(name) == .orderedSame { contacts.append(contact) }
            }
        }
        let matches = contacts.flatMap { contact -> [Match] in
            let fullName = CNContactFormatter.string(from: contact, style: .fullName) ?? (contact.nickname.isEmpty ? name : contact.nickname)
            return contact.phoneNumbers.map { phone in
                Match(name: fullName, number: phone.value.stringValue,
                      label: phone.label.map { CNLabeledValue<CNPhoneNumber>.localizedString(forLabel: $0) } ?? "phone")
            }
        }
        return Self.sorted(matches)
    }

    /// Mobile numbers first (they can get texts), then the rest, each group by name.
    static func sorted(_ matches: [Match]) -> [Match] {
        func isMobile(_ m: Match) -> Bool { m.label.localizedCaseInsensitiveContains("mobile") || m.label.localizedCaseInsensitiveContains("iphone") }
        return matches.sorted { a, b in
            if isMobile(a) != isMobile(b) { return isMobile(a) }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }
}
