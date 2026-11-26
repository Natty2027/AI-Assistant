import ImageIO
import SwiftUI
#if os(iOS)
import Contacts
import ContactsUI
import EventKit
import EventKitUI
import UIKit
#elseif os(macOS)
import AppKit
#endif

/// A photo to work out, from the camera or the photo library.
struct Snap: Identifiable {
    let id = UUID()
    /// An upright JPEG.
    let jpeg: Data
}

/// What a snap leads to on the Create screen.
enum SnapAction {
    /// Ask Hera now (a Studio request), with a photo for the posts if there is one.
    case run(prompt: String, photo: Data?)
    /// Fill in the request and let the person finish it (the price and ZIP for eBay).
    case prefill(prompt: String, photo: Data?)
    /// Hand the words to Hera as a text the person received.
    case receive(String)
}

/// "Here's what I see": what was found in the photo, and what Hera can do with it. Everything up
/// to this point happened on the device.
struct SnapSheet: View {
    let snap: Snap
    let act: (SnapAction) -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage(EventReminders.enabledKey) private var eventReminders = true
    @AppStorage(EventReminders.leadKey) private var reminderLead = 15
    @State private var result: SnapResult?
    @State private var preview: CGImage?
    @State private var copied = false
    @State private var showContact = false
    @State private var showEventEditor = false
    @State private var addingEvent = false
    @State private var done: String?
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let preview {
                        Image(decorative: preview, scale: 1)
                            .resizable()
                            .scaledToFit()
                            .frame(maxHeight: 200)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .frame(maxWidth: .infinity)
                    }
                    if let result {
                        content(result)
                    } else {
                        VStack(spacing: 10) {
                            ThinkingBeam()
                            Text("Looking at it on this \(ThisDevice.name)…")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }
                        .glowCard()
                    }
                    if let done {
                        Label(done, systemImage: "checkmark.circle.fill")
                            .labelStyle(.alignedIcon)
                            .font(.callout)
                            .foregroundStyle(.green)
                    }
                    if let problem {
                        Label(problem, systemImage: "exclamationmark.triangle.fill")
                            .labelStyle(.alignedIcon)
                            .font(.callout)
                            .foregroundStyle(.orange)
                    }
                }
                .padding(20)
                .frame(maxWidth: 620)
                .frame(maxWidth: .infinity)
            }
            .auroraBackground()
            .navigationTitle("Here's what I see")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .task { await analyze() }
        #if os(iOS)
        .sheet(isPresented: $showContact) {
            if case .businessCard(let card) = result {
                NewContactSheet(card: card) { saved in
                    if saved { done = "Saved to your contacts." }
                }
                .ignoresSafeArea()
            }
        }
        .sheet(isPresented: $showEventEditor) {
            if case .event(let event) = result {
                EventEditSheet(event: event) { saved in
                    if saved { Task { await eventAdded() } }
                }
                .ignoresSafeArea()
            }
        }
        #endif
    }

    private func analyze() async {
        preview = Self.thumbnail(snap.jpeg)
        let reading = await SnapAnalysis.read(snap.jpeg)
        let understood = await SnapAnalysis.understand(reading, onDevice: model.onDevice)
        withAnimation(.spring(duration: 0.4)) { result = understood }
    }

    /* ---------------- what was found ---------------- */

    @ViewBuilder
    private func content(_ result: SnapResult) -> some View {
        switch result {
        case .businessCard(let card): cardView(card)
        case .event(let event): eventView(event)
        case .product(let product): productView(product)
        case .other(let text): otherView(text)
        }
    }

    private func cardView(_ card: BusinessCard) -> some View {
        found("A business card", systemImage: "person.crop.rectangle") {
            detail(card.name, "person")
            detail(card.title, "briefcase")
            detail(card.company, "building.2")
            detail(card.phone, "phone")
            detail(card.email, "envelope")
            detail(card.website, "globe")
            detail(card.address, "mappin.and.ellipse")
        } actions: {
            #if os(iOS)
            Button("Save contact", systemImage: "person.crop.circle.badge.plus") { showContact = true }
                .buttonStyle(.glassProminent)
            #else
            Button(copied ? "Copied" : "Copy details", systemImage: copied ? "checkmark" : "doc.on.doc") { copy(card.summary) }
                .buttonStyle(.glassProminent)
            #endif
            Button("Write a follow-up email", systemImage: "envelope") {
                finish(.run(prompt: SnapPrompts.followUpEmail(card), photo: nil))
            }
            .buttonStyle(.glass)
        } note: {
            #if os(macOS)
            Text("Copy the details into Contacts, or skip straight to the email.")
            #else
            Text("Contacts opens filled in, so you can check it before saving.")
            #endif
        }
    }

    private func eventView(_ event: SnapEvent) -> some View {
        found("An event", systemImage: "calendar") {
            detail(event.title, "textformat")
            detail(when(event), "clock")
            detail(event.location, "mappin.and.ellipse")
        } actions: {
            Button("Add to calendar", systemImage: "calendar.badge.plus") { addToCalendar(event) }
                .buttonStyle(.glassProminent)
                .disabled(addingEvent)
            Button("Make a poster and posts for it", systemImage: "photo.artframe") {
                finish(.run(prompt: SnapPrompts.posterAndPosts(event), photo: nil))
            }
            .buttonStyle(.glass)
        } note: {
            // Reminders for calendar events are automatic (EventReminders), so there's nothing to set up here.
            Label(eventReminders
                  ? "Remind me: once it's in your calendar, Hera reminds you \(reminderLead) minutes before it starts."
                  : "Remind me: turn on Event reminders in Settings and Hera will remind you before it starts.",
                  systemImage: "bell")
                .labelStyle(.alignedIcon)
        }
    }

    private func productView(_ product: SnapProduct) -> some View {
        found("Something to sell or show off", systemImage: "tag") {
            detail(product.name.prefix(1).uppercased() + product.name.dropFirst(), "shippingbox")
            detail(product.brand, "seal")
            detail(product.barcode, "barcode")
        } actions: {
            Button("Sell it on eBay", systemImage: "tag") {
                finish(.prefill(prompt: SnapPrompts.sellOnEbay(product), photo: snap.jpeg))
            }
            .buttonStyle(.glassProminent)
            Button("Make a post about it", systemImage: "text.bubble") {
                finish(.run(prompt: SnapPrompts.postAbout(product), photo: snap.jpeg))
            }
            .buttonStyle(.glass)
        } note: {
            Text("For eBay, add the price and the ZIP code it ships from, then tap Create. The photo goes with it.")
        }
    }

    private func otherView(_ text: String) -> some View {
        found(text.isEmpty ? "Nothing I can read" : "Some text", systemImage: "text.viewfinder") {
            if text.isEmpty {
                Text("I couldn't make out any words. Try again closer, with more light.")
                    .foregroundStyle(.secondary)
            } else {
                Text(text)
                    .textSelection(.enabled)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.background.secondary, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        } actions: {
            if !text.isEmpty {
                Button("Use this text", systemImage: "text.badge.plus") { finish(.receive(text)) }
                    .buttonStyle(.glassProminent)
                Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") { copy(text) }
                    .buttonStyle(.glass)
            }
        } note: {
            if !text.isEmpty { Text("Hera reads it like a text you received, and helps you answer it.") }
        }
    }

    /// One kind of find: a heading, its details, a row of buttons and a footnote.
    private func found<Details: View, Actions: View, Note: View>(
        _ title: String, systemImage: String,
        @ViewBuilder details: () -> Details, @ViewBuilder actions: () -> Actions, @ViewBuilder note: () -> Note
    ) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                IconTile(systemImage: systemImage, size: 30)
                Text(title).font(.headline)
            }
            VStack(alignment: .leading, spacing: 6) { details() }
                .font(.callout)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { actions() }
                VStack(alignment: .leading, spacing: 8) { actions() }
            }
            .controlSize(.small)
            .lineLimit(1)
            note()
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .glowCard()
    }

    @ViewBuilder
    private func detail(_ value: String?, _ systemImage: String) -> some View {
        if let value, !value.isEmpty {
            Label(value, systemImage: systemImage)
                .labelStyle(.alignedIcon)
                .textSelection(.enabled)
        }
    }

    private func when(_ event: SnapEvent) -> String {
        var text = HeraTime.spoken(event.start)
        if let end = event.end {
            text += Calendar.current.isDate(end, inSameDayAs: event.start)
                ? " to \(end.formatted(date: .omitted, time: .shortened))"
                : " to \(HeraTime.spoken(end))"
        }
        return text
    }

    /* ---------------- actions ---------------- */

    private func finish(_ action: SnapAction) {
        dismiss()
        act(action)
    }

    private func addToCalendar(_ event: SnapEvent) {
        problem = nil
        #if os(iOS)
        // Apple's event editor, filled in: the person checks it, picks a calendar and saves.
        showEventEditor = true
        #else
        addingEvent = true
        Task {
            defer { addingEvent = false }
            do {
                try await model.schedule.addEvent(title: event.title, start: event.start, end: event.end, location: event.location)
                await eventAdded()
            } catch {
                problem = error.localizedDescription
            }
        }
        #endif
    }

    /// Reminders and the widget pick the new event up straight away.
    private func eventAdded() async {
        done = eventReminders ? "Added to your calendar. Hera will remind you before it starts." : "Added to your calendar."
        await model.refreshReminders()
        await model.refreshWidget()
    }

    private func copy(_ text: String) {
        #if os(iOS)
        UIPasteboard.general.string = text
        #else
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
        copied = true
    }

    private static func thumbnail(_ jpeg: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(jpeg as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 800,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }
}

#if os(iOS)
/* ---------------- Apple's editors ---------------- */

/// Contacts' new-contact screen, filled in from the card. The person saves or cancels it there.
struct NewContactSheet: UIViewControllerRepresentable {
    let card: BusinessCard
    let onDone: (Bool) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UINavigationController {
        let controller = CNContactViewController(forNewContact: Self.contact(from: card))
        controller.delegate = context.coordinator
        // It shows its Cancel and Done buttons only inside a navigation controller.
        return UINavigationController(rootViewController: controller)
    }

    func updateUIViewController(_ controller: UINavigationController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onDone: onDone, dismiss: { dismiss() }) }

    static func contact(from card: BusinessCard) -> CNMutableContact {
        let contact = CNMutableContact()
        if let name = card.name {
            var parts = name.split(separator: " ").map(String.init)
            if parts.count > 1 { contact.familyName = parts.removeLast() }
            contact.givenName = parts.joined(separator: " ")
        }
        contact.jobTitle = card.title ?? ""
        contact.organizationName = card.company ?? ""
        if let phone = card.phone {
            contact.phoneNumbers = [CNLabeledValue(label: CNLabelWork, value: CNPhoneNumber(stringValue: phone))]
        }
        if let email = card.email {
            contact.emailAddresses = [CNLabeledValue(label: CNLabelWork, value: email as NSString)]
        }
        if let website = card.website {
            contact.urlAddresses = [CNLabeledValue(label: CNLabelURLAddressHomePage, value: website as NSString)]
        }
        if let address = card.address {
            let postal = CNMutablePostalAddress()
            postal.street = address
            contact.postalAddresses = [CNLabeledValue(label: CNLabelWork, value: postal)]
        }
        return contact
    }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency CNContactViewControllerDelegate {
        let onDone: (Bool) -> Void
        let dismiss: () -> Void
        init(onDone: @escaping (Bool) -> Void, dismiss: @escaping () -> Void) {
            self.onDone = onDone
            self.dismiss = dismiss
        }

        func contactViewController(_ viewController: CNContactViewController, didCompleteWith contact: CNContact?) {
            onDone(contact != nil)
            dismiss()
        }
    }
}

/// Calendar's event editor, filled in from the flyer. It needs no calendar permission: the
/// person saves it themselves.
struct EventEditSheet: UIViewControllerRepresentable {
    let event: SnapEvent
    let onDone: (Bool) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> EKEventEditViewController {
        let store = EKEventStore()
        let new = EKEvent(eventStore: store)
        new.title = event.title
        new.startDate = event.start
        new.endDate = event.end.flatMap { $0 > event.start ? $0 : nil } ?? event.start.addingTimeInterval(3600)
        new.location = event.location
        let controller = EKEventEditViewController()
        controller.eventStore = store
        controller.event = new
        controller.editViewDelegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: EKEventEditViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onDone: onDone, dismiss: { dismiss() }) }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency EKEventEditViewDelegate {
        let onDone: (Bool) -> Void
        let dismiss: () -> Void
        init(onDone: @escaping (Bool) -> Void, dismiss: @escaping () -> Void) {
            self.onDone = onDone
            self.dismiss = dismiss
        }

        func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
            onDone(action == .saved)
            dismiss()
        }
    }
}
#endif
