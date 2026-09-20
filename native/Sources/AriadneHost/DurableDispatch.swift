import ApplicationServices
import Foundation

/// Both fixture and browser mutations cross the same durable intent boundary.
/// A doubtful dispatch is never converted into a retryable failure.
func journaledDispatch(journal: Journal, taskId: String, revision: Int, scopeRef: String,
                       operationId: String, digest: String, faults: Faults,
                       receipt: (String, String) -> [String: Any],
                       recheck: () -> String?, dispatch: () -> AXError) throws -> [String: Any] {
    if faults.journalError { throw HostError(.journalError, "injected journal failure before intent") }
    try journal.append(["type": "intent", "taskId": taskId, "taskRevision": revision, "scopeRef": scopeRef,
                        "operationId": operationId, "requestDigest": digest, "receipt": receipt("dispatch_intent", "none")])
    if faults.afterIntent { exit(70) }
    if let reason = recheck() {
        let unknown = receipt("outcome_unknown", reason)
        try? journal.append(["type": "receipt", "operationId": operationId, "receipt": unknown])
        return unknown
    }
    guard dispatch() == .success else {
        let unknown = receipt("outcome_unknown", "driver_error")
        try? journal.append(["type": "receipt", "operationId": operationId, "receipt": unknown])
        return unknown
    }
    if faults.afterDispatch { exit(70) }
    let attempted = receipt("attempted", "none")
    do { try journal.append(["type": "receipt", "operationId": operationId, "receipt": attempted]) }
    catch {
        let unknown = receipt("outcome_unknown", "journal_error")
        try? journal.append(["type": "receipt", "operationId": operationId, "receipt": unknown])
        return unknown
    }
    return attempted
}
