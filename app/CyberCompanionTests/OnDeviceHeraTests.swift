import Foundation
import Testing
@testable import CyberCompanion

/// On-device Hera's parts that don't need the model: tidying what it says, fitting a limit,
/// keeping links, and adding hashtags. The model itself only runs where Apple Intelligence is on.
struct OnDeviceHeraTests {
    @Test func quotesAndPreamblesAreRemoved() {
        #expect(OnDeviceHera.cleaned("  \"Big sale this Saturday!\"  ") == "Big sale this Saturday!")
        #expect(OnDeviceHera.cleaned("\u{201C}Open late on Friday.\u{201D}") == "Open late on Friday.")
        #expect(OnDeviceHera.cleaned("Here's the rewritten text:\nDoors open at 10.") == "Doors open at 10.")
        #expect(OnDeviceHera.cleaned("Sure! Here it is:\n\n\"Come say hi.\"") == "Come say hi.")
    }

    @Test func quotesThatArePartOfTheTextStay() {
        #expect(OnDeviceHera.cleaned("\"Sale\" today, \"Open\" late") == "\"Sale\" today, \"Open\" late")
        #expect(OnDeviceHera.cleaned("Here at the shop: we're open.") == "Here at the shop: we're open.")
    }

    @Test func longTextIsCutAtASentenceFirst() {
        let text = "Our spring class opens Saturday. Beginners are very welcome to join us."
        let fitted = OnDeviceHera.fit(text, limit: 40)
        #expect(fitted == "Our spring class opens Saturday.")
    }

    @Test func otherwiseItsCutAtAWordWithAnEllipsis() {
        let fitted = OnDeviceHera.fit("Handmade mugs bowls and plates for every kitchen in town", limit: 30)
        #expect(fitted.count <= 30)
        #expect(fitted.hasSuffix("\u{2026}"))
        #expect(fitted.hasPrefix("Handmade mugs"))
    }

    @Test func aCutNeverBreaksALinkAndCountsTheWayThePlatformDoes() {
        let text = "Join our class at the studio this weekend https://clay.example/class"
        let fitted = OnDeviceHera.fit(text, limit: 40, measure: Platform.x.measuredLength)
        #expect(fitted.contains("https://clay.example/class"))
        #expect(Platform.x.measuredLength(of: fitted) <= 40)
    }

    @Test func textWithinTheLimitIsUntouched() {
        #expect(OnDeviceHera.fit("Open at 10.", limit: 280) == "Open at 10.")
    }

    @Test func aDroppedLinkIsPutBack() {
        let original = "Sign up at https://clay.example/spring before Friday."
        let rewritten = OnDeviceHera.restoringLinks(from: original, in: "Sign up before Friday!")
        #expect(rewritten.hasSuffix("https://clay.example/spring"))
        #expect(OnDeviceHera.restoringLinks(from: original, in: original) == original)
    }

    @Test func theRewritePromptCarriesTheStyleAndTheLimit() {
        let prompt = OnDeviceHera.rewritePrompt("Open at 10.", style: .shorter, characterLimit: 280)
        #expect(prompt.contains("shorter"))
        #expect(prompt.contains("at most 280 characters"))
        #expect(prompt.hasSuffix("Open at 10."))
        #expect(!OnDeviceHera.rewritePrompt("Hi", style: .friendlier, characterLimit: nil).contains("at most"))
    }

    @Test func hashtagsAreTidiedDeduplicatedAndAtMostFive() {
        let tags = OnDeviceHera.normalizedHashtags(
            ["pottery", "#Pottery", "# Sacramento!", "#local art", "#ceramics", "#handmade", "#clay", "#more"],
            excluding: "Class today #ceramics")
        #expect(tags == ["#pottery", "#Sacramento", "#localart", "#handmade", "#clay"])
    }

    @Test func hashtagsGoOnTheirOwnLineOrOnTheExistingOne() {
        #expect(OnDeviceHera.appending(["#pottery", "#clay"], to: "Class Saturday!") == "Class Saturday!\n\n#pottery #clay")
        #expect(OnDeviceHera.appending(["#pottery"], to: "Class Saturday!\n\n#ceramics") == "Class Saturday!\n\n#ceramics #pottery")
        #expect(OnDeviceHera.appending(["#ceramics"], to: "Class Saturday! #ceramics") == "Class Saturday! #ceramics", "already there")
    }

    @Test func hashtagsThatDontFitAreLeftOff() {
        let text = OnDeviceHera.appending(["#pottery", "#a"], to: "Class on Saturday!", limit: 22)
        #expect(text == "Class on Saturday!\n\n#a")
    }

    @Test func aDraftsTextLimitLeavesRoomForItsLink() {
        let draft = Draft(id: "d1", connectionId: nil, platform: "x", text: "Spring class!", link: "https://clay.example",
                          sponsored: false, problems: [])
        #expect(draft.textCharacterLimit == 280 - 25, "two line breaks and a 23-character link")
        #expect(draft.shareable("Edited!") == "Edited!\n\nhttps://clay.example")
        let instagram = Draft(id: "d2", connectionId: nil, platform: "instagram", text: "Hi", link: nil, sponsored: false, problems: [])
        #expect(instagram.textCharacterLimit == 2200)
    }

    @Test func failuresReadPlainly() {
        #expect(OnDeviceHera.message(for: OnDeviceHera.Failure(message: "Try later.")) == "Try later.")
        #expect(OnDeviceHera.message(for: URLError(.badURL)).contains("ask Hera"))
    }

    #if targetEnvironment(simulator)
    @MainActor
    @Test func theSimulatorHidesTheToolsAndSaysWhy() {
        let hera = OnDeviceHera()
        #expect(!hera.isAvailable)
        #expect(hera.unavailableReason?.contains("Simulator") == true)
    }
    #endif

    /// Only on a device with Apple Intelligence on: the Simulator reports the model as available
    /// but won't run it.
    @MainActor
    @Test(.enabled(if: OnDeviceHera.canRunModel), .timeLimit(.minutes(1)))
    func theModelRewritesWithinTheLimit() async throws {
        let hera = OnDeviceHera()
        let text = "Our spring pottery class starts Saturday at 10 AM at Clay Corner. Beginners welcome, $40 a seat."
        let rewritten = try await hera.rewrite(text, style: .shorter, characterLimit: 100)
        #expect(!rewritten.isEmpty)
        #expect(rewritten.count <= 100)
    }
}
