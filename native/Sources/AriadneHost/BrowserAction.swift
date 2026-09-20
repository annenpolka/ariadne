import ApplicationServices
import Foundation

/// Operator-bound, ordered browser steps. No site names, labels or navigation scripts.
final class BrowserActionSession {
    struct Preparation {
        let json: [String: Any]
        let step: BrowserActionTask.Step
        let guardInfo: BrowserReadTarget.ActionGuard
        let generation: Int
        let expires: Int
        let observationId: String
        let digest: String
    }
    let task: BrowserActionTask
    let policy: BrowserActionPolicy
    let grant: ScopeGrant
    let target: BrowserReadTarget
    let journal: Journal
    let control: ControlState
    let epoch: String
    let deadlineMonoMs: Int
    private var observation: [String: Any]?
    private var preparations: [String: Preparation] = [:]
    private var finished: [String: [String: Any]] = [:]

    init(task: BrowserActionTask, grant: ScopeGrant, target: BrowserReadTarget, journal: Journal,
         control: ControlState, epoch: String) throws {
        guard grant.act, let policy = grant.actionPolicy,
              NSDictionary(dictionary: task.raw).isEqual(to: policy.task.raw) else { throw HostError(.scopeDenied, "task is not the operator-authorized task") }
        self.task = task; self.policy = policy; self.grant = grant; self.target = target
        self.journal = journal; self.control = control; self.epoch = epoch
        let state = journal.currentState(), now = wallNowMs(), key = Journal.taskKey(task.taskId, task.revision)
        let digest = digestJSON(task.raw)
        let prior = state.tasks[key]
        guard state.epoch == epoch else { throw HostError(.staleSession, "host epoch changed") }
        if let prior {
            guard prior.digest == digest, now >= prior.lastWallMs else { throw HostError(.invalidRequest, "task or clock changed") }
        }
        let deadline = min(prior?.deadlineWallMs ?? Int.max, now + min(task.limits.deadlineMs, grant.limits.deadlineMs))
        try journal.append(["type": "task", "taskId": task.taskId, "revision": task.revision, "digest": digest,
                            "deadlineWallMs": deadline, "lastWallMs": now])
        deadlineMonoMs = monoNowMs() + max(0, deadline - now)
    }

    var unresolved: [String] {
        journal.currentState().operations.compactMap { key, op in
            ["dispatch_intent", "outcome_unknown"].contains(op.receipt["status"] as? String ?? "") ? key : nil
        }.sorted()
    }
    var attemptedSteps: [String] {
        let operations = journal.currentState().operations
        return task.steps.filter { operations[task.operationId($0)]?.receipt["status"] as? String == "attempted" }.map(\.id)
    }
    func observed(_ value: [String: Any]) { observation = value }
    func invalidate() { observation = nil }

    private func active() throws {
        if control.isClosed { throw HostError(.closed, "host closed") }
        if control.isCancelled { throw HostError(.cancelled, "session cancelled") }
        guard monoNowMs() < deadlineMonoMs else { throw HostError(.scopeDenied, "action deadline exhausted") }
        guard journal.currentState().epoch == epoch else { throw HostError(.staleSession, "host epoch changed") }
    }
    private func mutable() throws {
        try active()
        guard unresolved.isEmpty else { throw HostError(.outcomeUnknown, "journal has unresolved operations") }
        let used = journal.currentState().tasks[Journal.taskKey(task.taskId, task.revision)]?.operations ?? 0
        guard used < min(task.steps.count, grant.limits.maxOperations) else { throw HostError(.scopeDenied, "operation budget exhausted") }
    }

    func prepare(_ params: JSONObject) throws -> [String: Any] {
        try params.requireOnly(["stepId", "observationId", "targetRef"]); try params.require(["stepId", "observationId", "targetRef"])
        try mutable()
        let stepId = try params.string("stepId"), observationId = try params.string("observationId"), ref = try params.string("targetRef")
        guard let step = task.steps.first(where: { !attemptedSteps.contains($0.id) }), step.id == stepId else {
            throw HostError(.invalidRequest, "step is not the next unattempted step")
        }
        guard let observation, observation["observationId"] as? String == observationId,
              let rawNodes = observation["nodes"] as? [[String: Any]],
              let node = rawNodes.first(where: { $0["ref"] as? String == ref }) else { throw HostError(.staleBinding, "target requires a fresh observation") }
        let stamp = try DocumentStamp.parse(observation["document"] as Any)
        let nodes = Dictionary(uniqueKeysWithValues: rawNodes.map { ($0["ref"] as! String, $0) })
        let guardInfo = try target.guardAction(stamp: stamp, node: node, nodes: nodes, kind: step.kind, policy: policy)
        let operationId = task.operationId(step), preparedId = "p-" + UUID().uuidString
        let command: [String: Any] = step.kind == "set_value"
            ? ["kind": step.kind, "targetRef": ref, "value": task.inputs[step.inputRef!]!]
            : ["kind": step.kind, "targetRef": ref]
        let binding: [String: Any] = ["slotId": step.id, "targetRef": ref, "observationId": observationId, "source": "operator",
            "evidence": ["name", "role", "parentRef", "value", "enabled"].map { ["observationId": observationId, "nodeRef": ref, "field": $0] }]
        let expires = min(deadlineMonoMs, monoNowMs() + 10_000)
        let result: [String: Any] = ["kind": "prepared_operation", "schemaVersion": "0.1", "preparedId": preparedId,
            "operationId": operationId, "taskId": task.taskId, "taskRevision": task.revision, "sessionEpoch": epoch,
            "controlEpoch": control.generation, "scopeRef": grant.scopeRef, "grantRef": grant.grantRef, "grantVersion": grant.version,
            "originObservationId": observationId, "binding": binding, "command": command,
            "guardSetRef": "g-" + UUID().uuidString, "expiresAtMonoMs": expires]
        // Only one outstanding prepare; a new proposal invalidates earlier ones.
        preparations = [preparedId: Preparation(json: result, step: step, guardInfo: guardInfo, generation: control.generation,
            expires: expires, observationId: observationId, digest: digestJSON(result))]
        return result
    }

    private func preflight(_ p: Preparation) throws {
        try active()
        guard control.generation == p.generation, monoNowMs() < p.expires,
              observation?["observationId"] as? String == p.observationId else { throw HostError(.staleBinding, "action preparation expired") }
        try target.validateAction(p.guardInfo, policy: policy)
    }
    private func receipt(_ operationId: String, _ status: String, _ reason: String) -> [String: Any] {
        ["kind": "host_receipt", "schemaVersion": "0.1", "operationId": operationId, "sessionEpoch": epoch,
         "eventSeq": target.counter.value, "status": status, "reason": reason]
    }
    func commit(_ preparedId: String) throws -> [String: Any] {
        if let prior = finished[preparedId] { return prior }
        guard let p = preparations[preparedId] else { throw HostError(.staleSession, "unknown prepared id") }
        let operationId = task.operationId(p.step)
        if let prior = journal.currentState().operations[operationId] { return recover(prior.receipt) }
        try mutable()
        do { try preflight(p) } catch {
            let result = receipt(operationId, "not_dispatched", control.isCancelled ? "cancelled_before_dispatch" : "precondition_changed")
            finished[preparedId] = result
            return result
        }
        let result = try journaledDispatch(journal: journal, taskId: task.taskId, revision: task.revision,
            scopeRef: grant.scopeRef, operationId: operationId, digest: p.digest, faults: Faults(),
            receipt: { self.receipt(operationId, $0, $1) },
            recheck: {
                do { try self.preflight(p) } catch { return "precondition_changed" }
                let (generation, cancelled, closed) = self.control.snapshot()
                return generation != p.generation || cancelled || closed ? "host_lost" : nil
            }, dispatch: {
                AXUIElementSetMessagingTimeout(p.guardInfo.element, 5.0)
                if p.step.kind == "invoke" { return AXUIElementPerformAction(p.guardInfo.element, kAXPressAction as CFString) }
                return AXUIElementSetAttributeValue(p.guardInfo.element, kAXValueAttribute as CFString,
                                                   self.task.inputs[p.step.inputRef!]! as CFString)
            })
        observation = nil
        finished[preparedId] = result
        return result
    }
    private func recover(_ raw: [String: Any]) -> [String: Any] {
        var result = raw
        if result["status"] as? String == "dispatch_intent" { result["status"] = "outcome_unknown"; result["reason"] = "host_lost" }
        return result
    }
}
