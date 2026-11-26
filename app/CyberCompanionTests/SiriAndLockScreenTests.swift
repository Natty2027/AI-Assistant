import Foundation
import Testing
@testable import CyberCompanion

/// Siri's answers, the Lock Screen countdowns' plan, and the hera://review link.
struct SiriAndLockScreenTests {
    static let now = Date(timeIntervalSince1970: 1_795_280_400)

    static func proposal(_ id: String, status: String, summary: String = "A post", postAt: Date? = nil,
                         kind: String = "social.post", connection: String = "c1") -> Proposal {
        var payload: [String: JSONValue] = ["connectionId": .string(connection), "text": .string("Hello")]
        if let postAt { payload["postAt"] = .string(ISO8601DateFormatter().string(from: postAt)) }
        return Proposal(id: id, kind: kind, label: "Publish a social post", summary: summary, payload: payload,
                        payloadHash: "h", checks: [], tainted: false, status: status,
                        expiresAt: "2026-12-01T00:00:00Z", result: nil, canBeCarriedOut: true)
    }

    /* ---------------- which posts get a Lock Screen countdown ---------------- */

    @Test func onlyScheduledPostsWithinEightHoursGetACountdown() {
        let soon = Self.proposal("soon", status: "scheduled", postAt: Self.now.addingTimeInterval(2 * 3600))
        let edge = Self.proposal("edge", status: "scheduled", postAt: Self.now.addingTimeInterval(8 * 3600))
        let later = Self.proposal("later", status: "scheduled", postAt: Self.now.addingTimeInterval(9 * 3600))
        let pending = Self.proposal("pending", status: "pending", postAt: Self.now.addingTimeInterval(3600))
        let noTime = Self.proposal("noTime", status: "scheduled")
        let listing = Self.proposal("listing", status: "scheduled", postAt: Self.now.addingTimeInterval(3600), kind: "marketplace.listing")
        let longPast = Self.proposal("past", status: "scheduled", postAt: Self.now.addingTimeInterval(-3600))
        let justDue = Self.proposal("due", status: "scheduled", postAt: Self.now.addingTimeInterval(-60))

        #expect(ScheduledPostPlan.wantsActivity(soon, now: Self.now))
        #expect(ScheduledPostPlan.wantsActivity(edge, now: Self.now))
        #expect(ScheduledPostPlan.wantsActivity(justDue, now: Self.now))
        for p in [later, pending, noTime, listing, longPast] {
            #expect(!ScheduledPostPlan.wantsActivity(p, now: Self.now), "\(p.id)")
        }
    }

    @Test func startsOnlyWhatIsntRunningSoonestFirst() {
        let a = Self.proposal("a", status: "scheduled", postAt: Self.now.addingTimeInterval(3 * 3600))
        let b = Self.proposal("b", status: "scheduled", postAt: Self.now.addingTimeInterval(3600))
        let c = Self.proposal("c", status: "scheduled", postAt: Self.now.addingTimeInterval(2 * 3600))
        let plan = ScheduledPostPlan.plan(proposals: [a, b, c], running: ["c"], showing: true, canStart: true, now: Self.now)
        #expect(plan.start.map(\.id) == ["b", "a"])
        #expect(plan.update.map(\.id) == ["c"])
        #expect(plan.finish.isEmpty && plan.remove.isEmpty)
    }

    @Test func finishedPostsEndWithTheirOutcomeAndMissingOnesAreRemoved() {
        let posted = Self.proposal("posted", status: "executed")
        let failed = Self.proposal("failed", status: "failed")
        let declined = Self.proposal("declined", status: "rejected")
        let plan = ScheduledPostPlan.plan(proposals: [posted, failed, declined],
                                          running: ["posted", "failed", "declined", "gone"],
                                          showing: true, canStart: true, now: Self.now)
        #expect(plan.finish == [.init(proposalId: "posted", status: "posted"),
                                .init(proposalId: "failed", status: "failed"),
                                .init(proposalId: "declined", status: "cancelled")])
        #expect(plan.remove == ["gone"])
        #expect(plan.start.isEmpty && plan.update.isEmpty)
    }

    @Test func turnedOffRemovesEverythingAndStartsNothing() {
        let soon = Self.proposal("soon", status: "scheduled", postAt: Self.now.addingTimeInterval(3600))
        let plan = ScheduledPostPlan.plan(proposals: [soon], running: ["soon", "other"], showing: false, canStart: true, now: Self.now)
        #expect(plan == ScheduledPostPlan.Plan(remove: ["soon", "other"]))
    }

    @Test func liveActivitiesNotAllowedStillEndsButDoesntStart() {
        let soon = Self.proposal("soon", status: "scheduled", postAt: Self.now.addingTimeInterval(3600))
        let done = Self.proposal("done", status: "executed")
        let plan = ScheduledPostPlan.plan(proposals: [soon, done], running: ["done"], showing: true, canStart: false, now: Self.now)
        #expect(plan.start.isEmpty)
        #expect(plan.finish == [.init(proposalId: "done", status: "posted")])
    }

    @Test func thePlatformComesFromThePostsAccount() {
        let post = Self.proposal("p", status: "scheduled", connection: "ig")
        let connections = [Connection(id: "ig", kind: "social", provider: "meta", platform: "instagram", label: "Clay Corner"),
                           Connection(id: "x", kind: "social", provider: "custom", platform: nil, label: "My blog")]
        #expect(ScheduledPostPlan.platformName(for: post, connections: connections) == "Instagram")
        #expect(ScheduledPostPlan.platformName(for: Self.proposal("q", status: "scheduled", connection: "x"), connections: connections) == "My blog")
        #expect(ScheduledPostPlan.platformName(for: Self.proposal("r", status: "scheduled", connection: "none"), connections: connections) == "social media")
    }

    /* ---------------- hera://review/<id> ---------------- */

    @Test func reviewLinksOpenTheirProposal() throws {
        #expect(DeepLink.parse(try #require(URL(string: "hera://review/abc-123_X"))) == .review(proposalId: "abc-123_X"))
        #expect(DeepLink.parse(try #require(URL(string: "HERA://Review/p1"))) == .review(proposalId: "p1"))
        #expect(DeepLink.parse(try #require(URL(string: "hera://review"))) == .review(proposalId: nil))
        #expect(DeepLink.parse(try #require(URL(string: "hera://review/"))) == .review(proposalId: nil))
    }

    @Test func otherLinksAreIgnored() throws {
        for link in ["hera://connected?status=ok", "https://review/p1", "hera://review/p1/extra", "hera://review/p%201",
                     "hera://review/" + String(repeating: "a", count: 129)] {
            #expect(DeepLink.parse(try #require(URL(string: link))) == nil, "\(link)")
        }
    }

    /* ---------------- what Siri says ---------------- */

    @Test func approvalsWithNothingOneAndSeveral() {
        #expect(SiriAnswers.approvals([]) == "Nothing is waiting for your approval.")
        #expect(SiriAnswers.approvals(["Open house post."]) == "One thing is waiting for your approval: Open house post.")
        #expect(SiriAnswers.approvals(["Open house post", "Vase listing"])
                == "2 things are waiting for your approval: Open house post and Vase listing.")
        #expect(SiriAnswers.approvals(["A", "B", "C"]) == "3 things are waiting for your approval: A, B and C.")
    }

    @Test func approvalsReadOnlyTheFirstThree() {
        let answer = SiriAnswers.approvals(["A", "B", "C", "D", "E"])
        #expect(answer == "5 things are waiting for your approval. The first three are A, B and C.")
        #expect(!answer.contains("D"))
    }

    @Test func onlyPendingItemsAreWaiting() {
        let proposals = [Self.proposal("1", status: "pending", summary: "One"), Self.proposal("2", status: "scheduled", summary: "Two"),
                         Self.proposal("3", status: "blocked", summary: "Three"), Self.proposal("4", status: "pending", summary: "Four")]
        #expect(SiriAnswers.waiting(in: proposals) == ["One", "Four"])
    }

    @Test func nothingComingUp() {
        #expect(SiriAnswers.comingUp([], now: Self.now) == "Nothing is scheduled to go out.")
        #expect(SiriAnswers.upcoming(in: [Self.proposal("1", status: "pending", postAt: Self.now)]).isEmpty)
    }

    @Test func comingUpSaysEachPostAndItsTime() {
        let at = Self.now.addingTimeInterval(3600)
        #expect(SiriAnswers.comingUp([.init(summary: "Open house", at: at)], now: Self.now)
                == "One post is coming up. Open house goes out \(HeraTime.spoken(at)).")
        let due = SiriAnswers.Upcoming(summary: "Sale", at: Self.now.addingTimeInterval(-30))
        #expect(SiriAnswers.comingUp([due, .init(summary: "Open house", at: at)], now: Self.now)
                == "2 posts are coming up. Sale is going out now. Open house goes out \(HeraTime.spoken(at)).")
    }

    @Test func comingUpIsSoonestFirstAndReadsOnlyThree() {
        let times = (1...5).map { Self.now.addingTimeInterval(Double($0) * 3600) }
        let proposals = [Self.proposal("e", status: "scheduled", summary: "E", postAt: times[4]),
                         Self.proposal("a", status: "scheduled", summary: "A", postAt: times[0]),
                         Self.proposal("d", status: "scheduled", summary: "D", postAt: times[3]),
                         Self.proposal("c", status: "scheduled", summary: "C", postAt: times[2]),
                         Self.proposal("b", status: "scheduled", summary: "B", postAt: times[1]),
                         Self.proposal("x", status: "executed", summary: "X", postAt: times[0])]
        let upcoming = SiriAnswers.upcoming(in: proposals)
        #expect(upcoming.map(\.summary) == ["A", "B", "C", "D", "E"])
        let answer = SiriAnswers.comingUp(upcoming, now: Self.now)
        #expect(answer.hasPrefix("5 posts are coming up. The next three: A goes out"))
        #expect(answer.contains("C goes out") && !answer.contains("D goes out"))
    }

    /* ---------------- "Ask Hera to make something" ---------------- */

    @MainActor
    @Test func aCreationRequestIsTakenOnce() {
        let requests = ConversationRequests()
        requests.requestCreation("Draft this week's posts", mode: .posts)
        requests.requestCreation("Plan my launch", mode: .launch)
        #expect(requests.takeCreation() == .init(request: "Plan my launch", mode: .launch))
        #expect(requests.takeCreation() == nil)
    }

    @Test func everyKindMapsToItsMode() {
        #expect(HeraTaskKind.allCases.map(\.mode) == [.posts, .launch, .schedule])
        #expect(HeraTaskKind.allCases.allSatisfy { HeraTaskKind.caseDisplayRepresentations[$0] != nil })
    }
}
