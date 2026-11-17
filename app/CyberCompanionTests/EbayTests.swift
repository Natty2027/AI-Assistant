import Foundation
import Testing
@testable import CyberCompanion

struct EbayTests {
    private let listingJSON = """
    {"id":"p1","kind":"marketplace.listing","label":"List an item for sale","summary":"Sell the Canon AE-1 for $180",
     "payload":{"connectionId":"c1","sku":"hera-0123456789abcdef","title":"Canon AE-1 35mm Film Camera",
                "description":"Works well.","categoryId":"15230","categoryName":"Film Cameras","condition":"USED_VERY_GOOD",
                "conditionNote":"Small scratch","price":"180.00","quantity":1,"aspects":{"Model":["AE-1"],"Brand":["Canon"]},
                "mediaRefs":["u-1"],"postalCode":"95819","policies":{"fulfillment":"f","payment":"p","returns":"r"}},
     "payloadHash":"h","checks":[],"tainted":false,"status":"pending","expiresAt":"2026-11-18T00:00:00Z","result":null,"canBeCarriedOut":true}
    """

    @Test func aListingReadsAsBuyersWillSeeIt() throws {
        let p = try JSONDecoder().decode(Proposal.self, from: Data(listingJSON.utf8))
        #expect(p.isListing && !p.isPost && !p.isSite)
        #expect(p.listingTitle == "Canon AE-1 35mm Film Camera")
        #expect(p.listingPrice == "180.00")
        #expect(p.listingCondition == "Used, very good")
        #expect(p.listingQuantity == 1)
        #expect(p.listingShipsFrom == "95819")
        #expect(p.listingSpecifics.map(\.name) == ["Brand", "Model"])
        #expect(p.listingSpecifics.first?.value == "Canon")
    }

    @Test func eBaySignInIsOfferedOnlyWhenTheServerSaysSo() throws {
        let withEbay = try JSONDecoder().decode(SignInAvailability.self, from: Data(#"{"x":false,"meta":false,"ebay":true}"#.utf8))
        #expect(withEbay.isAvailable(.ebay))
        let older = try JSONDecoder().decode(SignInAvailability.self, from: Data(#"{"x":true,"meta":true}"#.utf8))
        #expect(!older.isAvailable(.ebay), "servers from before eBay selling")
    }
}
