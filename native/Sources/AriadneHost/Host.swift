import AppKit
import ApplicationServices
import CryptoKit
import Foundation

func monoNowMs() -> Int {
    Int(DispatchTime.now().uptimeNanoseconds / 1_000_000)
}

func wallNowMs() -> Int {
    Int(Date().timeIntervalSince1970 * 1000)
}

func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func digestJSON(_ object: [String: Any]) -> String {
    sha256Hex(jsonData(object))
}

// MARK: - Fault injection (fixture profile only)

struct Faults {
    var afterIntent = false
    var afterDispatch = false
    var responseLost = false
    var journalError = false

    static func fromEnvironment(appId: String) -> Faults {
        guard appId == "ariadne.fixture" else { return Faults() }
        var faults = Faults()
        switch ProcessInfo.processInfo.environment["ARIADNE_FAULT"] {
        case "after_intent": faults.afterIntent = true
        case "after_dispatch": faults.afterDispatch = true
        case "response_lost": faults.responseLost = true
        case "journal_error": faults.journalError = true
        default: break
        }
        return faults
    }
}

// MARK: - Stored state

struct NodeInfo {
    var parentRef: String?
    var ancestors: [AncestryStep]
    var role: String
    var nativeRole: String
    var nameJSON: String
    var enabledJSON: String
    var valueStatus: String
    var actionId: String?
}

struct StoredObservation {
    var json: [String: Any]
    var nodeRefs: Set<String>
    var nodeInfo: [String: NodeInfo]
    var refToElement: [String: AXUIElement]
    var rootRef: String
}

struct GuardInfo {
    var operationId: String
    var taskId: String
    var taskRevision: Int
    var scopeRef: String
    var commandKind: String
    var targetRef: String
    var targetElement: AXUIElement
    var ancestry: [AncestryStep]
    var focused: AXUIElement?
    var originalValue: String
    var newValue: String
    var actionId: String?
    var requiredRole: String?
    var grantVersion: Int
    var grantRef: String
    var controlEpoch: Int
    var sessionEpoch: String
    var expiresAtMonoMs: Int
}

struct StoredPreparation {
    var operation: [String: Any]
    var guardInfo: GuardInfo
    var digest: String
}

// MARK: - Host state machine

final class Host {
    let epoch: String
    let grant: ScopeGrant
    let journal: Journal
    let pid: pid_t
    let windowTitle: String
    let documentPath: String?
    let pageURL: String?
    let faults: Faults
    let control: ControlState

    private var task: TaskSpec?
    private var deadlineMonoMs = Int.max
    private var target: AXTarget?
    private var observations: [String: StoredObservation] = [:]
    private var observationOrder: [String] = []
    private var preparations: [String: StoredPreparation] = [:]
    private var byOperation: [String: StoredPreparation] = [:]
    private var receipts: [String: [String: Any]] = [:]
    private var suppressedResponses = Set<String>()

    // Generic read session state. It is separate from Task state and is
    // admitted at most once per host, so a reopen cannot reset the deadline
    // or the capture count.
    private var readOpenAttempted = false
    private var readSpec: ReadSessionSpec?
    private var readTarget: BrowserReadTarget?
    private var readDeadlineMonoMs = 0
    private var readCapturesUsed = 0

    init(pid: pid_t, windowTitle: String, grant: ScopeGrant, journalPath: String,
         control: ControlState, documentPath: String?, pageURL: String? = nil) throws {
        self.pid = pid
        self.windowTitle = windowTitle
        self.documentPath = documentPath
        self.pageURL = pageURL
        self.grant = grant
        self.control = control
        self.epoch = "s-" + UUID().uuidString
        self.faults = Faults.fromEnvironment(appId: grant.appId)
        self.journal = try Journal(path: journalPath)
        try journal.append(["type": "boot", "epoch": epoch])
    }

    /// The invoke action IDs this host instance may actually use. Empty unless
    /// the fixture profile, the operator allowed invoke, and the operator listed
    /// specific registered actions.
    private var allowedInvokeActions: Set<String> {
        guard grant.appId == AppProfile.fixtureId,
              grant.allowedCommands.contains("invoke") else { return [] }
        return Set(grant.allowedActions).intersection(AppProfile.registeredActions)
    }

    // MARK: Protocol methods

    func hello() -> [String: Any] {
        var capabilities = grant.appId == AppProfile.chromeId ? [] : ["set_value"]
        if grant.appId == AppProfile.fixtureId, grant.allowedCommands.contains("invoke") {
            capabilities.append("invoke")
        }
        return ["protocolVersion": "1", "schemaVersion": "0.1", "sessionEpoch": epoch,
                "capabilities": capabilities, "platform": "macos"]
    }

    func openSession(_ taskObject: JSONObject, admittedGeneration: Int) throws -> [String: Any] {
        guard control.generation == admittedGeneration else { throw HostError(.cancelled, "open request predates cancellation") }
        if control.isClosed { throw HostError(.closed, "host closed") }
        guard grant.appId != AppProfile.chromeId else {
            throw HostError(.scopeDenied, "generic Chrome profile cannot open a Task session")
        }
        let newTask = try TaskSpec.parse(taskObject.raw)
        guard grant.read else { throw HostError(.scopeDenied, "read is not granted") }
        guard newTask.scopeRef == grant.scopeRef else {
            throw HostError(.scopeDenied, "task scope does not match grant")
        }
        guard AXIsProcessTrusted() else { throw HostError(.scopeDenied, "accessibility permission missing") }
        _ = try ensureTarget()
        let newDigest = digestJSON(taskJSON(newTask))
        let previous = self.task
        let sameTask = previous?.taskId == newTask.taskId && previous?.revision == newTask.revision
        if sameTask, let previous, digestJSON(taskJSON(previous)) != newDigest {
            throw HostError(.invalidRequest, "task changed without a new revision")
        }

        let state = journal.currentState()
        try checkEpoch(state)
        // Unresolved scope operations are observable but not mutable, so a
        // read-only session may still open. They are reported to Core.

        let key = Journal.taskKey(newTask.taskId, newTask.revision)
        let prior = state.tasks[key]
        if let prior, prior.digest != newDigest {
            throw HostError(.invalidRequest, "persisted task changed without a new revision")
        }
        let nowWall = wallNowMs()
        if let prior, nowWall < prior.lastWallMs {
            throw HostError(.invalidRequest, "clock moved backwards")
        }
        let requested = min(newTask.budgets.deadlineMs, grant.limits.deadlineMs)
        let deadlineWall = min(prior?.deadlineWallMs ?? Int.max, nowWall + requested)
        try journal.append(["type": "task", "taskId": newTask.taskId, "revision": newTask.revision,
                            "digest": newDigest, "deadlineWallMs": deadlineWall, "lastWallMs": nowWall])

        let wasCancelled = control.isCancelled
        guard control.generation == admittedGeneration else { throw HostError(.cancelled, "open request predates cancellation") }
        if sameTask && !wasCancelled {
            self.task = newTask
            self.deadlineMonoMs = min(deadlineMonoMs, monoNowMs() + max(0, deadlineWall - nowWall))
        } else {
            self.task = newTask
            self.deadlineMonoMs = monoNowMs() + max(0, deadlineWall - nowWall)
            observations.removeAll()
            observationOrder.removeAll()
            preparations.removeAll()
            byOperation.removeAll()
            try control.reopen(expectedGeneration: admittedGeneration)
        }
        return ["sessionEpoch": epoch, "controlEpoch": control.generation,
                "scopeRef": grant.scopeRef, "grantRef": grant.grantRef,
                "grantVersion": grant.version, "unresolvedOperationIds": resolvedUnresolvedIds(state, scopeRef: newTask.scopeRef)]
    }

    func capture(_ query: String) throws -> [String: Any] {
        guard grant.appId != AppProfile.chromeId else {
            throw HostError(.scopeDenied, "generic Chrome profile has no Task observation queries")
        }
        try requireActive()
        guard ["window_summary", "active_dialog", "editable_fields", "element_context", "changes_since"].contains(query) else {
            throw HostError(.invalidRequest, "unknown observation query")
        }
        guard grant.read else { throw HostError(.scopeDenied, "read is not granted") }
        let target = try ensureTarget()
        guard AXIsProcessTrusted() else { throw HostError(.scopeDenied, "accessibility permission missing") }

        let before = target.counter.value
        let started = monoNowMs()
        // With no active modal, active_dialog is unsupported. With one, the
        // whole granted window (including the dialog) is returned.
        if query == "active_dialog" && target.modalSheet() == nil {
            throw HostError(.unsupported, "no active dialog")
        }
        let result = target.captureIncludingModal(rootRef: grant.windowRef, maxNodes: 2048)
        let ended = monoNowMs()
        let after = target.counter.value
        let observationId = "obs-" + UUID().uuidString
        let omitted = result.omitted.sorted()
        let observation: [String: Any] = [
            "kind": "observation", "schemaVersion": "0.1", "observationId": observationId,
            "sessionEpoch": epoch, "scopeRef": grant.scopeRef,
            "capture": ["startedMonoMs": started, "endedMonoMs": ended, "eventSeqBefore": before,
                        "eventSeqAfter": after, "consistency": "best_effort"],
            "coverage": ["rootRef": grant.windowRef, "status": omitted.isEmpty ? "provider_exhausted" : "partial",
                         "omittedReasons": omitted, "nodeCount": result.nodes.count],
            "nodes": result.nodes.map(\.json),
        ]

        var refToElement: [String: AXUIElement] = [:]
        var nodeInfo: [String: NodeInfo] = [:]
        for node in result.nodes {
            refToElement[node.ref] = node.element
            nodeInfo[node.ref] = NodeInfo(parentRef: node.parentRef, ancestors: node.ancestors,
                                          role: node.role, nativeRole: node.nativeRole,
                                          nameJSON: node.nameJSON, enabledJSON: node.enabledJSON,
                                          valueStatus: node.valueStatus, actionId: node.actionId)
        }
        observations[observationId] = StoredObservation(json: observation, nodeRefs: Set(nodeInfo.keys),
                                                        nodeInfo: nodeInfo, refToElement: refToElement,
                                                        rootRef: grant.windowRef)
        observationOrder.append(observationId)
        while observationOrder.count > 128 {
            let old = observationOrder.removeFirst()
            observations.removeValue(forKey: old)
        }
        return observation
    }

    func prepare(_ params: JSONObject) throws -> [String: Any] {
        guard grant.appId != AppProfile.chromeId else {
            throw HostError(.scopeDenied, "a read session cannot prepare operations")
        }
        try requireActive()
        try params.requireOnly(["operationId", "taskId", "taskRevision", "sessionEpoch", "binding", "command"])
        try params.require(["operationId", "taskId", "taskRevision", "sessionEpoch", "binding", "command"])
        guard grant.act else { throw HostError(.scopeDenied, "act is not granted") }
        guard AXIsProcessTrusted() else { throw HostError(.scopeDenied, "accessibility permission missing") }
        guard let task = self.task else { throw HostError(.closed, "no open session") }

        let operationId = try params.string("operationId")
        guard isValidId(operationId) else { throw HostError(.invalidRequest, "invalid operation id") }
        let taskId = try params.string("taskId")
        let revision = try params.int("taskRevision")
        let sessionEpoch = try params.string("sessionEpoch")
        guard taskId == task.taskId, revision == task.revision, sessionEpoch == epoch else {
            throw HostError(.staleSession, "prepare task or session mismatch")
        }
        let binding = try Binding.parse(try params.object("binding").raw as Any)
        let command = try Command.parse(try params.object("command").raw as Any)
        guard command.targetRef == binding.targetRef else {
            throw HostError(.invalidRequest, "command target does not match binding")
        }
        guard let origin = observations[binding.observationId] else {
            throw HostError(.staleBinding, "binding observation is not current")
        }
        guard origin.nodeRefs.contains(binding.targetRef), let info = origin.nodeInfo[binding.targetRef] else {
            throw HostError(.staleBinding, "binding target is not in the observation")
        }
        for evidence in binding.evidence {
            guard evidence.observationId == binding.observationId,
                  origin.nodeRefs.contains(evidence.nodeRef) else {
                throw HostError(.staleBinding, "binding evidence is outside its observation")
            }
        }
        guard let slot = task.slots.first(where: { $0.id == binding.slotId }) else {
            throw HostError(.invalidRequest, "binding references an unknown slot")
        }
        guard let element = origin.refToElement[binding.targetRef] else {
            throw HostError(.staleBinding, "binding target handle is gone")
        }
        // set_value must use its fixed slot input; invoke carries no value but
        // still binds to a valid task slot and issued observation.
        let newValue: String
        if case .setValue(_, let value) = command {
            guard value == task.inputs[slot.inputRef] else {
                throw HostError(.invalidRequest, "operation must use its fixed slot input")
            }
            newValue = value
        } else {
            newValue = ""
        }

        let digest = digestJSON(["taskId": task.taskId, "taskRevision": task.revision,
                                 "sessionEpoch": epoch, "binding": binding.json, "command": command.json])
        if let prior = byOperation[operationId] {
            guard prior.digest == digest else {
                throw HostError(.invalidRequest, "operation id reused with different content")
            }
            return prior.operation
        }

        let state = journal.currentState()
        try checkEpoch(state)
        try checkUnresolved(state, grant.scopeRef)
        try checkBudget(state)
        if state.operations[operationId] != nil {
            throw HostError(.invalidRequest, "operation id already recorded; use status")
        }

        let target = try ensureTarget()
        guard target.isFocusedWindowRetained() else {
            throw HostError(.staleBinding, "granted window is not focused")
        }
        guard target.modalSheet() == nil else {
            throw HostError(.staleBinding, "modal context is present")
        }
        // Compare live target and ancestor identities/roles/names to the issued
        // observation before storing any guard.
        guard let live = target.liveAncestry(for: element) else {
            throw HostError(.staleBinding, "target lineage is incomplete")
        }
        guard live.count == info.ancestors.count else {
            throw HostError(.staleBinding, "target ancestry length changed")
        }
        let observedLineage = Array(info.ancestors.reversed())
        for (index, step) in live.enumerated() {
            let expected = observedLineage[index]
            guard step.ref == expected.ref, step.role == expected.role,
                  step.nativeRole == expected.nativeRole, step.nameJSON == expected.nameJSON else {
                throw HostError(.staleBinding, "target ancestry changed")
            }
            if let stored = origin.nodeInfo[step.ref] {
                guard stored.role == step.role, stored.nativeRole == step.nativeRole,
                      stored.nameJSON == step.nameJSON else {
                    throw HostError(.staleBinding, "ancestor attributes changed")
                }
            }
        }
        guard live.first?.ref == binding.targetRef else {
            throw HostError(.staleBinding, "live target is not the bound ref")
        }
        guard live.last?.ref == origin.rootRef, origin.rootRef == grant.windowRef else {
            throw HostError(.staleBinding, "target lineage does not reach the granted window")
        }
        guard target.attributeEnabled(element).availableValue == true else {
            throw HostError(.unsupported, "target is not enabled")
        }
        var originalValue = ""
        var actionId: String?
        var requiredRole: String?
        switch command {
        case .setValue:
            if grant.appId == AppProfile.textEditId {
                guard target.nativeRole(element) == "AXTextArea" else {
                    throw HostError(.unsupported, "TextEdit set_value requires a text area")
                }
                requiredRole = "text_area"
            }
            if grant.appId == AppProfile.chromeFixtureId {
                // Only non-secure raw text fields inside the retained page web
                // area; browser chrome and groups never receive set_value.
                guard target.isUnderRetainedWebArea(element) else {
                    throw HostError(.staleBinding, "target is not inside the retained page")
                }
                guard ["AXTextField", "AXTextArea"].contains(target.nativeRole(element)),
                      !isSecureElement(element) else {
                    throw HostError(.unsupported, "Chrome set_value requires a non-secure text field")
                }
            }
            guard target.capabilities(element).contains("set_value"), target.isValueSettable(element) else {
                throw HostError(.unsupported, "target value is not settable")
            }
            guard let value = target.attributeValue(element).availableValue else {
                throw HostError(.unsupported, "target value is not readable")
            }
            originalValue = value
        case .invoke:
            guard grant.appId == AppProfile.fixtureId else {
                throw HostError(.unsupported, "invoke is only registered for the fixture profile")
            }
            guard grant.allowedCommands.contains("invoke") else {
                throw HostError(.scopeDenied, "invoke is not granted")
            }
            guard let registered = target.registeredInvokeAction(element), info.actionId == registered else {
                throw HostError(.unsupported, "target is not a registered action")
            }
            guard target.nativeRole(element) == "AXButton", target.hasPressAction(element) else {
                throw HostError(.unsupported, "target does not support AXPress")
            }
            guard grant.allowedActions.contains(registered) else {
                throw HostError(.scopeDenied, "action is not allowed by the grant")
            }
            actionId = registered
        }

        let preparedId = "p-" + UUID().uuidString
        let guardSetRef = "g-" + UUID().uuidString
        let expiresAt = min(deadlineMonoMs, monoNowMs() + 10_000)
        let operation: [String: Any] = [
            "kind": "prepared_operation", "schemaVersion": "0.1", "preparedId": preparedId,
            "operationId": operationId, "taskId": task.taskId, "taskRevision": task.revision,
            "sessionEpoch": epoch, "controlEpoch": control.generation, "scopeRef": grant.scopeRef,
            "grantRef": grant.grantRef, "grantVersion": grant.version,
            "originObservationId": binding.observationId, "binding": binding.json,
            "command": command.json, "guardSetRef": guardSetRef, "expiresAtMonoMs": expiresAt,
        ]
        let guardInfo = GuardInfo(operationId: operationId, taskId: task.taskId,
                                  taskRevision: task.revision, scopeRef: grant.scopeRef,
                                  commandKind: command.kind, targetRef: binding.targetRef,
                                  targetElement: element, ancestry: live,
                                  focused: target.focusedWindow(),
                                  originalValue: originalValue, newValue: newValue,
                                  actionId: actionId, requiredRole: requiredRole,
                                  grantVersion: grant.version, grantRef: grant.grantRef,
                                  controlEpoch: control.generation, sessionEpoch: epoch,
                                  expiresAtMonoMs: expiresAt)
        let stored = StoredPreparation(operation: operation, guardInfo: guardInfo, digest: digest)
        preparations[preparedId] = stored
        byOperation[operationId] = stored
        return operation
    }

    func commit(_ preparedId: String) throws -> (receipt: [String: Any], suppress: Bool) {
        guard grant.appId != AppProfile.chromeId else {
            throw HostError(.scopeDenied, "a read session cannot commit operations")
        }
        guard let stored = preparations[preparedId] else {
            throw HostError(.staleSession, "unknown prepared id")
        }
        let operationId = stored.guardInfo.operationId
        if let known = receipts[operationId] {
            return (known, shouldSuppress(operationId, known))
        }
        if let drifted = preflight(stored) {
            return (remember(drifted), false)
        }

        let state = journal.currentState()
        try checkEpoch(state)
        if let existing = state.operations[operationId] {
            return (remember(recover(existing.receipt)), false)
        }
        try checkUnresolved(state, stored.guardInfo.scopeRef)
        try checkBudget(state)
        if let drifted = preflight(stored) {
            return (remember(drifted), false)
        }

        // Fixture-only deterministic failure immediately before intent sync.
        if faults.journalError {
            throw HostError(.journalError, "injected journal failure before intent")
        }
        let intent = receipt(operationId, "dispatch_intent", "none")
        try journal.append(["type": "intent", "taskId": stored.guardInfo.taskId,
                            "taskRevision": stored.guardInfo.taskRevision,
                            "scopeRef": stored.guardInfo.scopeRef, "operationId": operationId,
                            "requestDigest": stored.digest, "receipt": intent])
        if faults.afterIntent { exit(70) }

        // All guard AX reads happen first; the control generation is then
        // rechecked immediately before the dispatch boundary. A late cancel
        // after persisted intent leaves the operation unknown, never a retry.
        let driftAfterIntent = preflight(stored) != nil
        let (generation, cancelled, closed) = control.snapshot()
        if cancelled || closed || generation != stored.guardInfo.controlEpoch {
            let unknown = receipt(operationId, "outcome_unknown", "host_lost")
            try? journal.append(["type": "receipt", "operationId": operationId, "receipt": unknown])
            return (remember(unknown), false)
        }
        if driftAfterIntent {
            let unknown = receipt(operationId, "outcome_unknown", "precondition_changed")
            try? journal.append(["type": "receipt", "operationId": operationId, "receipt": unknown])
            return (remember(unknown), false)
        }

        let error: AXError
        if stored.guardInfo.commandKind == "invoke" {
            error = target?.performPress(stored.guardInfo.targetElement) ?? .invalidUIElement
        } else {
            error = target?.setValue(stored.guardInfo.targetElement, stored.guardInfo.newValue) ?? .invalidUIElement
        }
        guard error == .success else {
            let unknown = receipt(operationId, "outcome_unknown", "driver_error")
            try? journal.append(["type": "receipt", "operationId": operationId, "receipt": unknown])
            return (remember(unknown), false)
        }
        if faults.afterDispatch { exit(70) }

        let attempted = receipt(operationId, "attempted", "none")
        do {
            try journal.append(["type": "receipt", "operationId": operationId, "receipt": attempted])
        } catch {
            let unknown = receipt(operationId, "outcome_unknown", "journal_error")
            try? journal.append(["type": "receipt", "operationId": operationId, "receipt": unknown])
            return (remember(unknown), false)
        }
        return (remember(attempted), shouldSuppress(operationId, attempted))
    }

    func status(_ operationId: String) throws -> Any {
        if let known = receipts[operationId] { return known }
        let state = journal.currentState()
        if let operation = state.operations[operationId] { return recover(operation.receipt) }
        return NSNull()
    }

    func cancel() { control.cancel() }
    func close() { control.close() }

    // MARK: Generic read session

    /// Opens the single Task-free read session of this host. No Task is
    /// recorded and the journal is only read: unresolved operations of the
    /// scope are reported as they are, never cleared.
    func openReadSession(_ specObject: JSONObject, admittedGeneration: Int) throws -> [String: Any] {
        guard control.generation == admittedGeneration else { throw HostError(.cancelled, "open request predates cancellation") }
        if control.isClosed { throw HostError(.closed, "host closed") }
        guard grant.appId == AppProfile.chromeId, let pageScope = grant.pageScope,
              let ceiling = grant.readLimits else {
            throw HostError(.unsupported, "read sessions are registered for the generic Chrome profile only")
        }
        let spec = try ReadSessionSpec.parse(specObject.raw)
        // Cancellation is never cleared by a read session.
        if control.isCancelled { throw HostError(.cancelled, "session cancelled") }
        guard !readOpenAttempted else {
            throw HostError(.scopeDenied, "this host already admitted its read session")
        }
        guard grant.read, !grant.act, !grant.model else { throw HostError(.scopeDenied, "read-only grant required") }
        guard spec.scopeRef == grant.scopeRef else {
            throw HostError(.scopeDenied, "read session scope does not match grant")
        }
        guard spec.limits.isWithin(ceiling) else {
            throw HostError(.scopeDenied, "read session limits exceed the grant")
        }
        guard let pageURL, let origin = BrowserURL.origin(pageURL), pageScope.origins.contains(origin) else {
            throw HostError(.scopeDenied, "operator page origin is not granted")
        }
        guard AXIsProcessTrusted() else { throw HostError(.scopeDenied, "accessibility permission missing") }
        let state = journal.currentState()
        try checkEpoch(state)

        // From here the one admission is spent, whatever the outcome.
        readOpenAttempted = true
        let deadline = monoNowMs() + spec.limits.deadlineMs
        let resolved = try BrowserReadTarget.resolve(pid: pid, windowTitle: windowTitle, pageURL: pageURL,
                                                     allowedOrigins: pageScope.origins)
        let (generation, cancelled, closed) = control.snapshot()
        guard generation == admittedGeneration, !cancelled, !closed else {
            throw HostError(.cancelled, "open request predates cancellation")
        }
        guard monoNowMs() < deadline else { throw HostError(.scopeDenied, "read session deadline exhausted during open") }
        guard let stamp = resolved.stamp(sessionEpoch: epoch) else {
            throw HostError(.staleBinding, "no document selected")
        }
        readTarget = resolved
        readSpec = spec
        readDeadlineMonoMs = deadline
        return ["sessionEpoch": epoch, "controlEpoch": generation,
                "scopeRef": grant.scopeRef, "grantRef": grant.grantRef, "grantVersion": grant.version,
                "unresolvedOperationIds": resolvedUnresolvedIds(state, scopeRef: grant.scopeRef),
                "document": stamp.json]
    }

    /// Explicitly re-selects the active page of the retained window. Refs of
    /// the previous document are gone even when this fails. Deadline and
    /// capture count are untouched.
    func refreshPage(admittedGeneration: Int) throws -> [String: Any] {
        let (_, target) = try requireReadActive(admittedGeneration)
        try target.refresh()
        try requireNotCancelled(admittedGeneration)
        guard monoNowMs() < readDeadlineMonoMs else {
            target.invalidate()
            throw HostError(.scopeDenied, "read session deadline exhausted during refresh")
        }
        guard let stamp = target.stamp(sessionEpoch: epoch) else {
            throw HostError(.staleBinding, "no document selected")
        }
        return stamp.json
    }

    func readObservation(_ params: JSONObject, admittedGeneration: Int) throws -> [String: Any] {
        try params.requireOnly(["document", "rootRef"])
        try params.require(["document"])
        let stamp = try DocumentStamp.parse(try params.object("document").raw)
        var requestedRoot: String?
        if params.raw["rootRef"] != nil {
            let rootRef = try params.string("rootRef")
            guard isValidId(rootRef) else { throw ShapeFailure.shape("invalid root ref") }
            requestedRoot = rootRef
        }
        let (spec, target) = try requireReadActive(admittedGeneration)
        guard readCapturesUsed < spec.limits.maxCaptures else {
            throw HostError(.scopeDenied, "capture budget exhausted")
        }
        // Every admitted attempt is charged, including ones that fail below.
        readCapturesUsed += 1
        guard stamp.sessionEpoch == epoch else {
            throw HostError(.staleSession, "document stamp is from another session")
        }

        let before = target.counter.value
        let started = monoNowMs()
        let overhead = jsonData(observationEnvelope(
            observationId: "obs-" + UUID().uuidString, rootRef: "r-" + UUID().uuidString, stamp: stamp,
            started: 9_007_199_254_740_991, ended: 9_007_199_254_740_991,
            eventsBefore: 9_007_199_254_740_991, eventsAfter: 9_007_199_254_740_991,
            omitted: ["budget", "error", "frame", "redacted", "unsupported", "virtualized"],
            nodes: [], nodeCount: spec.limits.maxNodes)).count
        let control = self.control
        let budgetMs = min(spec.limits.maxCaptureMs, readDeadlineMonoMs - started)
        let result = try target.capture(stamp: stamp, rootRef: requestedRoot, limits: spec.limits,
                                        overheadBytes: overhead, captureBudgetMs: budgetMs,
                                        shouldStop: {
                                            let (generation, cancelled, closed) = control.snapshot()
                                            return cancelled || closed || generation != admittedGeneration
                                        })
        let ended = monoNowMs()
        let after = target.counter.value

        var nodes = result.nodes
        var omitted = result.omitted
        func build() -> [String: Any] {
            observationEnvelope(observationId: "obs-" + UUID().uuidString, rootRef: result.rootRef,
                                stamp: stamp, started: started, ended: ended,
                                eventsBefore: before, eventsAfter: after,
                                omitted: omitted.sorted(), nodes: nodes, nodeCount: nodes.count)
        }
        // The capture already accounts bytes per node; this exact check on
        // the final serialization is the backstop. Parents precede children,
        // so dropping from the tail keeps the tree valid.
        var observation = build()
        while jsonData(observation).count > spec.limits.maxBytes {
            guard nodes.count > 1 else { throw HostError(.unsupported, "capture root exceeds the byte budget") }
            nodes.removeLast(max(1, nodes.count / 8))
            omitted.insert("budget")
            observation = build()
        }
        // A cancel admitted while the capture was in flight wins over success.
        try requireNotCancelled(admittedGeneration)
        guard monoNowMs() < readDeadlineMonoMs else { throw HostError(.scopeDenied, "read session deadline exhausted during capture") }
        return observation
    }

    private func observationEnvelope(observationId: String, rootRef: String, stamp: DocumentStamp,
                                     started: Int, ended: Int, eventsBefore: Int, eventsAfter: Int,
                                     omitted: [String], nodes: [[String: Any]], nodeCount: Int) -> [String: Any] {
        ["kind": "observation", "schemaVersion": "0.1", "observationId": observationId,
         "sessionEpoch": epoch, "scopeRef": grant.scopeRef, "document": stamp.json,
         "capture": ["startedMonoMs": started, "endedMonoMs": ended, "eventSeqBefore": eventsBefore,
                     "eventSeqAfter": eventsAfter, "consistency": "best_effort"],
         "coverage": ["rootRef": rootRef, "status": omitted.isEmpty ? "provider_exhausted" : "partial",
                      "omittedReasons": omitted, "nodeCount": nodeCount],
         "nodes": nodes]
    }

    private func requireNotCancelled(_ admittedGeneration: Int) throws {
        let (generation, cancelled, closed) = control.snapshot()
        if closed { throw HostError(.closed, "host closed") }
        if cancelled || generation != admittedGeneration { throw HostError(.cancelled, "session cancelled") }
    }

    private func requireReadActive(_ admittedGeneration: Int) throws -> (ReadSessionSpec, BrowserReadTarget) {
        if control.isClosed { throw HostError(.closed, "host closed") }
        guard let readSpec, let readTarget else { throw HostError(.closed, "no open read session") }
        try requireNotCancelled(admittedGeneration)
        guard grant.read else { throw HostError(.scopeDenied, "read is not granted") }
        guard monoNowMs() < readDeadlineMonoMs else {
            throw HostError(.scopeDenied, "read session deadline exhausted")
        }
        try checkEpoch(journal.currentState())
        return (readSpec, readTarget)
    }

    // MARK: Internals

    private func resolvedUnresolvedIds(_ state: Journal.State, scopeRef: String) -> [String] {
        state.operations.values
            .filter { operation in
                operation.scopeRef == scopeRef
                    && ["dispatch_intent", "outcome_unknown"].contains(operation.receipt["status"] as? String ?? "")
            }
            .map { $0.receipt["operationId"] as? String ?? "" }
            .filter { !$0.isEmpty }
            .sorted()
    }

    private func requireActive() throws {
        if control.isClosed { throw HostError(.closed, "host closed") }
        guard task != nil else { throw HostError(.closed, "no open session") }
        if control.isCancelled { throw HostError(.cancelled, "session cancelled") }
    }

    private func ensureTarget() throws -> AXTarget {
        if let target {
            try target.verifyWindowIdentity()
            return target
        }
        let resolved = try AXTarget.resolve(pid: pid, windowTitle: windowTitle,
                                            appId: grant.appId, documentPath: documentPath,
                                            pageURL: pageURL)
        resolved.invokeActionIds = allowedInvokeActions
        target = resolved
        return resolved
    }

    private func checkEpoch(_ state: Journal.State) throws {
        if state.epoch != epoch { throw HostError(.staleSession, "another host replaced this session") }
    }

    private func checkUnresolved(_ state: Journal.State, _ scopeRef: String) throws {
        for operation in state.operations.values {
            let status = operation.receipt["status"] as? String
            if operation.scopeRef == scopeRef && (status == "dispatch_intent" || status == "outcome_unknown") {
                throw HostError(.outcomeUnknown, "scope has an unresolved operation")
            }
        }
    }

    private func checkBudget(_ state: Journal.State) throws {
        guard let task else { throw HostError(.closed, "no open session") }
        let key = Journal.taskKey(task.taskId, task.revision)
        guard let stored = state.tasks[key] else { throw HostError(.invalidRequest, "task is not recorded") }
        let nowWall = wallNowMs()
        let operatorLimit = min(task.budgets.maxOperations, grant.limits.maxOperations)
        if nowWall < stored.lastWallMs || nowWall >= stored.deadlineWallMs
            || monoNowMs() >= deadlineMonoMs || stored.operations >= operatorLimit {
            throw HostError(.invalidRequest, "task deadline or operation budget exhausted")
        }
    }

    private func preflight(_ stored: StoredPreparation) -> [String: Any]? {
        let info = stored.guardInfo
        let (generation, cancelled, closed) = control.snapshot()
        if closed || cancelled || generation != info.controlEpoch {
            return receipt(info.operationId, "not_dispatched",
                           cancelled ? "cancelled_before_dispatch" : "precondition_changed")
        }
        if monoNowMs() >= info.expiresAtMonoMs {
            return receipt(info.operationId, "expired", "expired")
        }
        guard grant.act, grant.read, grant.version == info.grantVersion,
              grant.grantRef == info.grantRef, grant.scopeRef == info.scopeRef,
              grant.allowedCommands.contains(info.commandKind) else {
            return receipt(info.operationId, "not_dispatched", "scope_denied")
        }
        guard let task, task.taskId == info.taskId, task.revision == info.taskRevision else {
            return receipt(info.operationId, "not_dispatched", "precondition_changed")
        }
        guard let target else {
            return receipt(info.operationId, "not_dispatched", "precondition_changed")
        }
        do { try target.verifyWindowIdentity() } catch {
            return receipt(info.operationId, "not_dispatched", "precondition_changed")
        }
        let element = info.targetElement
        guard let live = target.liveAncestry(for: element), live == info.ancestry else {
            return receipt(info.operationId, "not_dispatched", "precondition_changed")
        }
        guard target.attributeEnabled(element).availableValue == true else {
            return receipt(info.operationId, "not_dispatched", "precondition_changed")
        }
        if let requiredRole = info.requiredRole, normalizeRole(target.nativeRole(element)) != requiredRole {
            return receipt(info.operationId, "not_dispatched", "precondition_changed")
        }
        if info.commandKind == "invoke" {
            guard grant.appId == AppProfile.fixtureId,
                  grant.allowedCommands.contains("invoke"),
                  let actionId = info.actionId,
                  grant.allowedActions.contains(actionId),
                  target.registeredInvokeAction(element) == actionId,
                  target.nativeRole(element) == "AXButton",
                  target.hasPressAction(element) else {
                return receipt(info.operationId, "not_dispatched", "precondition_changed")
            }
        } else {
            if grant.appId == AppProfile.chromeFixtureId {
                guard ["AXTextField", "AXTextArea"].contains(target.nativeRole(element)),
                      target.isUnderRetainedWebArea(element),
                      !isSecureElement(element) else {
                    return receipt(info.operationId, "not_dispatched", "precondition_changed")
                }
            }
            guard target.attributeValue(element).availableValue == info.originalValue,
                  target.isValueSettable(element),
                  target.capabilities(element).contains("set_value") else {
                return receipt(info.operationId, "not_dispatched", "precondition_changed")
            }
        }
        let focused = target.focusedWindow()
        switch (focused, info.focused) {
        case (nil, nil): break
        case (let a?, let b?): if !CFEqual(a, b) { return receipt(info.operationId, "not_dispatched", "precondition_changed") }
        default: return receipt(info.operationId, "not_dispatched", "precondition_changed")
        }
        guard target.modalSheet() == nil else {
            return receipt(info.operationId, "not_dispatched", "precondition_changed")
        }
        return nil
    }

    private func shouldSuppress(_ operationId: String, _ receipt: [String: Any]) -> Bool {
        guard faults.responseLost, (receipt["status"] as? String) == "attempted" else { return false }
        if suppressedResponses.contains(operationId) { return false }
        suppressedResponses.insert(operationId)
        return true
    }

    private func receipt(_ operationId: String, _ status: String, _ reason: String) -> [String: Any] {
        ["kind": "host_receipt", "schemaVersion": "0.1", "operationId": operationId,
         "sessionEpoch": epoch, "eventSeq": target?.counter.value ?? 0,
         "status": status, "reason": reason]
    }

    private func recover(_ receipt: [String: Any]) -> [String: Any] {
        var recovered = receipt
        if (recovered["status"] as? String) == "dispatch_intent" {
            recovered["status"] = "outcome_unknown"
            recovered["reason"] = "host_lost"
        }
        return recovered
    }

    @discardableResult
    private func remember(_ receipt: [String: Any]) -> [String: Any] {
        if let operationId = receipt["operationId"] as? String { receipts[operationId] = receipt }
        return receipt
    }

    private func taskJSON(_ task: TaskSpec) -> [String: Any] {
        ["kind": "task", "schemaVersion": "0.1", "taskId": task.taskId, "revision": task.revision,
         "goal": task.goal, "scopeRef": task.scopeRef, "recipeId": task.recipeId,
         "inputs": task.inputs,
         "slots": task.slots.map { ["id": $0.id, "meaning": $0.meaning, "inputRef": $0.inputRef,
                                    "regionHint": $0.regionHint] },
         "requiredChecks": task.requiredChecks.map { ["id": $0.id, "kind": $0.kind, "slotId": $0.slotId,
                                                       "inputRef": $0.inputRef, "comparison": $0.comparison] },
         "budgets": ["maxOperations": task.budgets.maxOperations,
                     "maxSemanticRequests": task.budgets.maxSemanticRequests,
                     "maxObservationExpansions": task.budgets.maxObservationExpansions,
                     "deadlineMs": task.budgets.deadlineMs]]
    }
}
