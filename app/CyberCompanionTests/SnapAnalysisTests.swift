import Foundation
import Testing
@testable import CyberCompanion

/// "Snap it": deciding what a photo is from the words and items read off it, and the requests it
/// leads to. Plain inputs only; Vision and the model aren't involved.
struct SnapAnalysisTests {
    private let now = Calendar.current.date(from: DateComponents(year: 2026, month: 11, day: 26, hour: 9))!
    private func day(_ d: Int, _ hour: Int) -> Date {
        Calendar.current.date(from: DateComponents(year: 2026, month: 12, day: d, hour: hour))!
    }

    private let cardLines = ["Jane Doe", "Owner", "Clay Corner Studio", "(916) 555-0142", "jane@claycorner.com", "claycorner.com"]

    @Test func theDetectorFindsNumbersEmailsLinksAndDates() throws {
        let found = DetectedItems.detect(in: "Call (916) 555-0142 or email jane@claycorner.com\nOpen house December 12, 2026 at 10 AM", now: now)
        #expect(found.phones == ["(916) 555-0142"])
        #expect(found.emails == ["jane@claycorner.com"])
        let start = try #require(found.dates.first?.start)
        let parts = Calendar.current.dateComponents([.year, .month, .day, .hour], from: start)
        #expect(parts.year == 2026 && parts.month == 12 && parts.day == 12 && parts.hour == 10)
    }

    @Test func aBusinessCardIsReadIntoItsParts() throws {
        let reading = SnapReading(lines: cardLines, headline: "Jane Doe")
        let detected = DetectedItems.detect(in: reading.text, now: now)
        guard case .businessCard(let card) = SnapAnalysis.classify(reading, detected: detected, now: now) else {
            Issue.record("expected a business card")
            return
        }
        #expect(card.name == "Jane Doe")
        #expect(card.title == "Owner")
        #expect(card.company == "Clay Corner Studio")
        #expect(card.phone == "(916) 555-0142")
        #expect(card.email == "jane@claycorner.com")
        #expect(card.website == "claycorner.com")
    }

    @Test func aFlyerWithAComingDateIsAnEvent() throws {
        let reading = SnapReading(
            lines: ["Spring Pottery Open House", "Saturday, December 12", "10 AM - 2 PM",
                    "Clay Corner, 12 Main St, Sacramento, CA 95819", "Free! All welcome", "Call (916) 555-0142"],
            headline: "Spring Pottery Open House")
        let detected = DetectedItems(
            dates: [.init(start: day(12, 10), end: day(12, 14))],
            phones: ["(916) 555-0142"],
            addresses: ["12 Main St, Sacramento, CA 95819"],
            matched: ["Saturday, December 12", "10 AM - 2 PM", "12 Main St, Sacramento, CA 95819", "(916) 555-0142"])
        let result = SnapAnalysis.classify(reading, detected: detected, now: now)
        #expect(result == .event(SnapEvent(title: "Spring Pottery Open House", start: day(12, 10), end: day(12, 14),
                                           location: "12 Main St, Sacramento, CA 95819")),
                "a phone number on a flyer doesn't make it a card")
    }

    @Test func aDateThatHasPassedIsNotAnEvent() {
        let reading = SnapReading(lines: ["Receipt", "Thank you"], headline: "Receipt")
        let detected = DetectedItems(dates: [.init(start: now.addingTimeInterval(-7 * 86_400))], matched: [])
        if case .event = SnapAnalysis.classify(reading, detected: detected, now: now) {
            Issue.record("a past date isn't an event to add")
        }
    }

    @Test func aPictureOfAThingIsAProductNamedByWhatItShows() {
        let reading = SnapReading(lines: ["YAMAHA"], headline: "YAMAHA", labels: ["indoor", "acoustic_guitar", "guitar"])
        let result = SnapAnalysis.classify(reading, detected: DetectedItems(), now: now)
        #expect(result == .product(SnapProduct(name: "acoustic guitar", brand: "YAMAHA")))
    }

    @Test func aBarcodeIsKeptWithTheProduct() {
        let reading = SnapReading(lines: ["Trail Mix"], headline: "Trail Mix", barcodes: ["012345678905"])
        #expect(SnapAnalysis.classify(reading, detected: DetectedItems(), now: now)
                == .product(SnapProduct(name: "Trail Mix", barcode: "012345678905")))
    }

    @Test func aPageOfWordsIsJustText() {
        let lines = (1...9).map { "This is line number \($0) of a long letter about the weather" }
        let reading = SnapReading(lines: lines, labels: ["document"])
        #expect(SnapAnalysis.classify(reading, detected: DetectedItems(), now: now) == .other(reading.text))
    }

    @Test func namesAreToldApartFromTitlesAndCompanies() {
        #expect(SnapAnalysis.looksLikeName("Mary-Kate O'Neil"))
        #expect(!SnapAnalysis.looksLikeName("Marketing Director"))
        #expect(!SnapAnalysis.looksLikeName("Clay Corner LLC"))
        #expect(!SnapAnalysis.looksLikeName("jane doe"))
        #expect(SnapAnalysis.hasTitleWord("Head of Sales"))
        #expect(SnapAnalysis.hasCompanyWord("Acme Inc."))
    }

    /* ---------------- the model's view, checked ---------------- */

    @Test func theModelCantMakeUpAName() {
        let reading = SnapReading(lines: cardLines)
        let detected = DetectedItems.detect(in: reading.text, now: now)
        let rules = SnapAnalysis.classify(reading, detected: detected, now: now)
        let guess = SnapModelGuess.Plain(kind: .businessCard, name: "John Smith", title: "Owner", company: "Clay Corner Studio")
        guard case .businessCard(let card) = SnapAnalysis.merge(guess, reading: reading, detected: detected, rules: rules, now: now) else {
            Issue.record("expected a business card")
            return
        }
        #expect(card.name == "Jane Doe", "a name that isn't on the card is ignored")
        #expect(card.email == "jane@claycorner.com", "contact details come from the detector")
    }

    @Test func anEventNeedsARealDate() {
        let reading = SnapReading(lines: ["Pottery Night", "Every week"])
        let rules = SnapAnalysis.classify(reading, detected: DetectedItems(), now: now)
        let merged = SnapAnalysis.merge(.init(kind: .event, eventTitle: "Pottery Night"), reading: reading,
                                        detected: DetectedItems(), rules: rules, now: now)
        #expect(merged == rules)
    }

    @Test func theModelsBetterTitleIsUsedWhenItsInTheText() {
        let reading = SnapReading(lines: ["Clay Corner presents", "Spring Open House", "Dec 12"], headline: "Clay Corner presents")
        let detected = DetectedItems(dates: [.init(start: day(12, 10))], matched: ["Dec 12"])
        let rules = SnapAnalysis.classify(reading, detected: detected, now: now)
        let merged = SnapAnalysis.merge(.init(kind: .event, eventTitle: "Spring Open House"), reading: reading,
                                        detected: detected, rules: rules, now: now)
        #expect(merged == .event(SnapEvent(title: "Spring Open House", start: day(12, 10))))
    }

    /* ---------------- what Hera is asked ---------------- */

    @Test func theFollowUpEmailNamesThePersonTheirEmailAndCompany() {
        let card = BusinessCard(name: "Jane Doe", company: "Clay Corner Studio", email: "jane@claycorner.com")
        let prompt = SnapPrompts.followUpEmail(card)
        #expect(prompt.hasPrefix("Write a short follow-up email to Jane Doe (jane@claycorner.com) from Clay Corner Studio."))
        #expect(SnapPrompts.followUpEmail(BusinessCard(email: "sam@example.com")).contains("to sam@example.com."))
    }

    @Test func theEventRequestCarriesItsDetails() {
        let event = SnapEvent(title: "Spring Open House", start: day(12, 10), end: day(12, 14), location: "12 Main St")
        let prompt = SnapPrompts.posterAndPosts(event)
        #expect(prompt.hasPrefix("Make a poster and posts for Spring Open House on "))
        #expect(prompt.contains(HeraTime.spoken(day(12, 10))))
        #expect(prompt.contains("until"))
        #expect(prompt.hasSuffix(", at 12 Main St."))
    }

    @Test func theEbayRequestLeavesRoomForThePriceAndZIP() {
        let product = SnapProduct(name: "acoustic guitar", brand: "Yamaha", barcode: "012345678905")
        #expect(SnapPrompts.sellOnEbay(product) == "Sell this on eBay: acoustic guitar, Yamaha (barcode 012345678905). ")
        #expect(SnapPrompts.postAbout(SnapProduct(name: "mug")) == "Make a post about this: mug.")
    }

    @Test func aCardCanBeCopiedAsText() {
        let card = BusinessCard(name: "Jane Doe", phone: "(916) 555-0142", email: "jane@claycorner.com")
        #expect(card.summary == "Jane Doe\n(916) 555-0142\njane@claycorner.com")
    }
}
