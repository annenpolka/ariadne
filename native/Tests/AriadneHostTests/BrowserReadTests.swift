import XCTest
import ApplicationServices
@testable import AriadneHost

final class BrowserReadTests: XCTestCase {
    func testShortAXRangesPreserveEveryChildAndTheCallerLimit() throws {
        let root = AXUIElementCreateApplication(getpid())
        let children = (0..<1500).map { AXUIElementCreateApplication(pid_t(20000 + $0)) }
        for limit in [100, 1500] {
            let fetched = boundedChildren(of: root, limit: limit, clock: AXClock(endMonoMs: monoNowMs() + 5000),
                countReader: { _, _ in (.success, children.count) },
                rangeReader: { _, _, index, wanted in
                    (.success, Array(children[index..<min(children.count, index + min(17, wanted))]) as CFArray)
                })
            guard case .children(let result, let invalid, let truncated) = fetched else { return XCTFail("no children") }
            XCTAssertEqual(result.count, limit); XCTAssertEqual(invalid, 0)
            XCTAssertEqual(truncated, limit < children.count)
            for (actual, expected) in zip(result, children) { XCTAssertTrue(CFEqual(actual, expected)) }
        }
    }
    func testEarlyEmptyAXRangeCannotClaimExhaustion() throws {
        let root = AXUIElementCreateApplication(getpid())
        let fetched = boundedChildren(of: root, limit: 50, clock: AXClock(endMonoMs: monoNowMs() + 5000),
            countReader: { _, _ in (.success, 50) },
            rangeReader: { _, _, index, _ in (.success, (index == 0 ? [root] : []) as CFArray) })
        guard case .children(let result, _, let truncated) = fetched else { return XCTFail("no children") }
        XCTAssertEqual(result.count, 1); XCTAssertTrue(truncated)
    }
    func testAXRangeCannotReturnMoreThanRequested() throws {
        let root = AXUIElementCreateApplication(getpid())
        let fetched = boundedChildren(of: root, limit: 1, clock: AXClock(endMonoMs: monoNowMs() + 5000),
            countReader: { _, _ in (.success, 50) },
            rangeReader: { _, _, _, _ in (.success, [root, root] as CFArray) })
        guard case .failed = fetched else { return XCTFail("oversized range accepted") }
    }
    let readLimits: [String: Int] = ["maxNodes": 2048, "maxDepth": 64, "maxBytes": 524288,
                                    "maxCaptureMs": 3000, "maxCaptures": 10, "deadlineMs": 60000]
    func browserGrant() -> [String: Any] {
        ["scopeRef": "scope-read", "grantRef": "grant-read", "version": 1,
         "read": true, "model": false, "act": false, "allowedCommands": [String](),
         "appId": AppProfile.chromeId, "windowRef": "browser-page",
         "pageScope": ["origins": ["https://example.org"]], "readLimits": readLimits,
         "limits": ["maxOperations": 0, "maxSemanticRequests": 0, "maxObservationExpansions": 0, "deadlineMs": 60000]]
    }
    func testSharedURLPolicyCorpus() throws {
        var repo = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { repo.deleteLastPathComponent() }
        let data = try Data(contentsOf: repo.appendingPathComponent("test/browser-url-cases.json"))
        let cases = try JSONSerialization.jsonObject(with: data) as! [[String: Any]]
        for c in cases {
            let input = c["url"] as! String
            XCTAssertEqual(BrowserURL.origin(input), c["origin"] as? String, input)
        }
        for origin in ["https://example.org/", "https://EXAMPLE.org", "https://example.org:443", "https://example.org?x=1"] {
            XCTAssertFalse(BrowserURL.isCanonicalOrigin(origin))
        }
        XCTAssertEqual(canonicalPageURL("http://127.0.0.1:1234/fixture"), "http://127.0.0.1:1234/fixture")
        XCTAssertNil(canonicalPageURL("http://127.0.0.1:1234/fixture?q=1"))
    }
    func testBrowserGrantRejectsBroaderAuthorityAndMissingScope() throws {
        XCTAssertNoThrow(try ScopeGrant.parse(browserGrant()))
        for (field, value): (String, Any) in [("read", false), ("act", true), ("model", true),
            ("allowedCommands", ["set_value"]), ("allowedCommands", ["invoke"]),
            ("allowedActions", ["fixture.submit"]), ("pageScope", ["origins": [String]()]),
            ("pageScope", ["origins": ["https://example.org/"]]),
            ("pageScope", ["origins": ["https://example.org", "https://example.org"]]),
            ("readLimits", ["maxNodes": 1])] {
            var grant = browserGrant(); grant[field] = value
            XCTAssertThrowsError(try ScopeGrant.parse(grant), field)
        }
        for field in ["pageScope", "readLimits"] {
            var grant = browserGrant(); grant.removeValue(forKey: field)
            XCTAssertThrowsError(try ScopeGrant.parse(grant), field)
        }
        var legacy = browserGrant(); legacy["appId"] = AppProfile.chromeFixtureId
        XCTAssertThrowsError(try ScopeGrant.parse(legacy))
    }
    func testReadSpecIsSeparateFromTaskAndLimitsCannotWiden() throws {
        let spec: [String: Any] = ["kind": "read_session", "schemaVersion": "0.1",
            "readSessionId": "read-1", "scopeRef": "scope-read", "limits": readLimits]
        XCTAssertNoThrow(try ReadSessionSpec.parse(spec))
        XCTAssertThrowsError(try TaskSpec.parse(spec))
        var extra = spec; extra["slots"] = [String]()
        XCTAssertThrowsError(try ReadSessionSpec.parse(extra))
        let ceiling = try ReadLimits.parse(JSONObject(readLimits))
        var expanded = readLimits; expanded["maxCaptures"] = 11
        XCTAssertFalse(try ReadLimits.parse(JSONObject(expanded)).isWithin(ceiling))
        expanded["maxNodes"] = 65537
        XCTAssertThrowsError(try ReadLimits.parse(JSONObject(expanded)))
    }
    func testLargerReadBudgetsStillRespectOperatorCeiling() throws {
        var limits = readLimits
        limits["maxNodes"] = 65536; limits["maxDepth"] = 256
        limits["maxBytes"] = 33554432; limits["maxCaptureMs"] = 20000
        let large = try ReadLimits.parse(JSONObject(limits))
        XCTAssertFalse(large.isWithin(try ReadLimits.parse(JSONObject(readLimits))))
        for (key, value) in [("maxNodes", 65537), ("maxDepth", 257), ("maxBytes", 33554433), ("maxCaptureMs", 20001)] {
            var invalid = limits; invalid[key] = value
            XCTAssertThrowsError(try ReadLimits.parse(JSONObject(invalid)), key)
        }
    }
    func testReadHandshakeAndTaskRejectionBeforeAX() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let host = try Host(pid: 1, windowTitle: "synthetic", grant: ScopeGrant.parse(browserGrant()),
            journalPath: directory.appendingPathComponent("host.jsonl").path, control: ControlState(),
            documentPath: nil, pageURL: "https://example.org/?opaque=1#fragment")
        XCTAssertEqual(host.hello()["capabilities"] as? [String], [])
        XCTAssertThrowsError(try host.openSession(JSONObject([String: Any]()), admittedGeneration: 0))
        XCTAssertThrowsError(try host.prepare(JSONObject([String: Any]())))
        XCTAssertThrowsError(try host.commit("forged"))
        XCTAssertThrowsError(try host.capture("window_summary"))
    }
}
