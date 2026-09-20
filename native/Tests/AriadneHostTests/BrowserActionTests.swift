import XCTest
import ApplicationServices
@testable import AriadneHost

final class BrowserActionTests: XCTestCase {
    func sample() throws -> [String: Any] {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { root.deleteLastPathComponent() }
        return try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("examples/browser-action-task.json"))) as! [String: Any]
    }
    func testActionTaskRejectsUnknownInputDuplicateStepAndChangedShape() throws {
        let valid = try sample(); XCTAssertNoThrow(try BrowserActionTask.parse(valid))
        var invalid = valid; invalid["inputs"] = [String: String](); XCTAssertThrowsError(try BrowserActionTask.parse(invalid))
        invalid = valid; var steps = valid["steps"] as! [[String: Any]]; steps.append(steps[0]); invalid["steps"] = steps
        XCTAssertThrowsError(try BrowserActionTask.parse(invalid))
        invalid = valid; invalid["revision"] = true; XCTAssertThrowsError(try BrowserActionTask.parse(invalid))
        invalid = valid; invalid["requiredChecks"] = [String](); XCTAssertThrowsError(try BrowserActionTask.parse(invalid))
    }
    func testActionPolicyRejectsNonControlRolesAndFixtureActions() throws {
        let task = try sample()
        XCTAssertNoThrow(try BrowserActionPolicy.parse(["task": task, "setValueRoles": ["AXComboBox"], "invokeRoles": ["AXButton", "AXMenuItem"]]))
        for role in ["AXGroup", "AXWindow", "AXSecureTextField", "fixture.submit"] {
            XCTAssertThrowsError(try BrowserActionPolicy.parse(["task": task, "setValueRoles": [role], "invokeRoles": ["AXButton"]]))
        }
    }
    func testReadHostRefusesActionSessionAndActionRPCBeforeAX() throws {
        let helper = BrowserReadTests()
        let grant = try ScopeGrant.parse(helper.browserGrant())
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).path
        defer { try? FileManager.default.removeItem(atPath: path) }
        let host = try Host(pid: 1, windowTitle: "synthetic", grant: grant, journalPath: path, control: ControlState(), documentPath: nil)
        XCTAssertThrowsError(try host.openActionSession(JSONObject(sample()), admittedGeneration: 0))
        XCTAssertThrowsError(try host.prepareAction(JSONObject([:])))
        XCTAssertThrowsError(try host.commitAction("p-forged"))
        XCTAssertEqual(host.hello()["capabilities"] as? [String], [])
    }
    func testDurableRecheckFailureNeverDispatchesAndStaysUnknown() throws {
        var dispatches = 0
        try exerciseDispatch(recheck: { "precondition_changed" }, dispatch: { dispatches += 1; return .success }) { state in
            XCTAssertEqual(state.operations["op"]?.receipt["status"] as? String, "outcome_unknown")
        }
        XCTAssertEqual(dispatches, 0)
    }
    func testDriverFailureHasOneIntentAndCannotClaimAttemptedSuccess() throws {
        var dispatches = 0
        try exerciseDispatch(recheck: { nil }, dispatch: { dispatches += 1; return .cannotComplete }) { state in
            XCTAssertEqual(state.operations["op"]?.receipt["status"] as? String, "outcome_unknown")
            XCTAssertEqual(state.tasks["task#1"]?.operations, 1)
        }
        XCTAssertEqual(dispatches, 1)
    }
    private func exerciseDispatch(recheck: () -> String?, dispatch: () -> AXError, check: (Journal.State) -> Void) throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).path
        defer { try? FileManager.default.removeItem(atPath: path) }
        let journal = try Journal(path: path)
        try journal.append(["type": "boot", "epoch": "epoch"])
        try journal.append(["type": "task", "taskId": "task", "revision": 1, "digest": String(repeating: "a", count: 64), "deadlineWallMs": 999, "lastWallMs": 1])
        _ = try journaledDispatch(journal: journal, taskId: "task", revision: 1, scopeRef: "scope", operationId: "op", digest: String(repeating: "b", count: 64), faults: Faults(), receipt: { status, reason in
            ["kind": "host_receipt", "schemaVersion": "0.1", "operationId": "op", "sessionEpoch": "epoch", "eventSeq": 0, "status": status, "reason": reason]
        }, recheck: recheck, dispatch: dispatch)
        check(journal.currentState())
    }
}
