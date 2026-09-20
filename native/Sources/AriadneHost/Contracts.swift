import Foundation

// MARK: - Static app profiles

/// Operator-registered app profiles. Registration is static code, not data
/// discovered from the UI. Only the fixture profile may invoke actions.
enum AppProfile {
    static let fixtureId = "ariadne.fixture"
    static let textEditId = "com.apple.TextEdit"
    static let chromeFixtureId = "ariadne.chrome_fixture"
    /// Generic read-only Chrome profile. Pages are chosen by the operator's
    /// grant (pageScope) and startup pin, never by site-specific code.
    static let chromeId = "ariadne.chrome"
    static let chromeBundleId = "com.google.Chrome"
    /// The only action IDs that may ever be invoked, and only when the operator
    /// lists them in grant.allowedActions.
    static let registeredActions: Set<String> = [
        "fixture.submit", "fixture.replace_field", "fixture.show_modal",
    ]

    static func expectedExecutable(for appId: String) -> String? {
        switch appId {
        case fixtureId: return "AriadneFixture"
        case textEditId: return "TextEdit"
        case chromeFixtureId, chromeId: return "Google Chrome"
        default: return nil
        }
    }

    static func isBrowser(_ appId: String) -> Bool {
        [chromeFixtureId, chromeId].contains(appId)
    }

    /// Only the localhost input fixture has a canonical page spelling. The
    /// generic profile pins the operator's exact raw URL and authorizes it by
    /// origin (`BrowserURL.origin`), so it has no entry here.
    static func canonicalURL(_ raw: String, for appId: String) -> String? {
        if appId == chromeFixtureId { return canonicalPageURL(raw) }
        return nil
    }
}

/// Returns the accepted canonical `http://127.0.0.1:PORT/path` serialization,
/// or nil. The operator's spelling must already equal this canonical
/// serialization (explicit port included); alternative spellings are rejected
/// rather than silently rewritten. Credentials, query, fragment, non-loopback
/// hosts, missing/invalid ports and empty paths are rejected.
func canonicalPageURL(_ raw: String) -> String? {
    guard let components = URLComponents(string: raw) else { return nil }
    guard components.scheme == "http",
          components.host == "127.0.0.1",
          let port = components.port, (1...65535).contains(port),
          !components.percentEncodedPath.isEmpty,
          components.user == nil, components.password == nil,
          components.query == nil, components.fragment == nil else { return nil }
    let canonical = "http://127.0.0.1:\(port)\(components.percentEncodedPath)"
    guard canonical == raw else { return nil }
    return canonical
}

// MARK: - Contract structs

struct Budgets: Equatable {
    var maxOperations: Int
    var maxSemanticRequests: Int
    var maxObservationExpansions: Int
    var deadlineMs: Int

    static func parse(_ object: JSONObject) throws -> Budgets {
        try object.requireOnly(["maxOperations", "maxSemanticRequests", "maxObservationExpansions", "deadlineMs"])
        try object.require(["maxOperations", "maxSemanticRequests", "maxObservationExpansions", "deadlineMs"])
        let values = Budgets(
            maxOperations: try object.int("maxOperations"),
            maxSemanticRequests: try object.int("maxSemanticRequests"),
            maxObservationExpansions: try object.int("maxObservationExpansions"),
            deadlineMs: try object.int("deadlineMs"))
        guard (1...100).contains(values.maxOperations),
              (1...100).contains(values.maxSemanticRequests),
              (0...20).contains(values.maxObservationExpansions),
              (1_000...600_000).contains(values.deadlineMs) else {
            throw ShapeFailure.shape("budget out of range")
        }
        return values
    }
}

struct Slot: Equatable {
    var id: String
    var meaning: String
    var inputRef: String
    var regionHint: String

    static func parse(_ any: Any) throws -> Slot {
        let object = try JSONObject(any)
        try object.requireOnly(["id", "meaning", "inputRef", "regionHint"])
        try object.require(["id", "meaning", "inputRef", "regionHint"])
        let slot = Slot(id: try object.string("id"),
                        meaning: try object.string("meaning"),
                        inputRef: try object.string("inputRef"),
                        regionHint: try object.string("regionHint"))
        guard isValidId(slot.id), isValidId(slot.inputRef) else { throw ShapeFailure.shape("invalid slot id") }
        guard !slot.meaning.isEmpty, slot.meaning.count <= 4096 else { throw ShapeFailure.shape("invalid meaning") }
        guard slot.regionHint.count <= 65_536 else { throw ShapeFailure.shape("invalid region hint") }
        return slot
    }
}

struct CheckSpec: Equatable {
    var id: String
    var kind: String
    var slotId: String
    var inputRef: String
    var comparison: String

    static func parse(_ any: Any) throws -> CheckSpec {
        let object = try JSONObject(any)
        try object.requireOnly(["id", "kind", "slotId", "inputRef", "comparison"])
        try object.require(["id", "kind", "slotId", "inputRef", "comparison"])
        let check = CheckSpec(id: try object.string("id"),
                              kind: try object.string("kind"),
                              slotId: try object.string("slotId"),
                              inputRef: try object.string("inputRef"),
                              comparison: try object.string("comparison"))
        guard isValidId(check.id), isValidId(check.slotId), isValidId(check.inputRef) else {
            throw ShapeFailure.shape("invalid check id")
        }
        guard check.kind == "value_equals_input", check.comparison == "exact" else {
            throw ShapeFailure.shape("unsupported check kind")
        }
        return check
    }
}

struct TaskSpec: Equatable {
    var taskId: String
    var revision: Int
    var goal: String
    var scopeRef: String
    var recipeId: String
    var inputs: [String: String]
    var slots: [Slot]
    var requiredChecks: [CheckSpec]
    var budgets: Budgets

    static func parse(_ any: Any) throws -> TaskSpec {
        let object = try JSONObject(any)
        try object.requireOnly(["kind", "schemaVersion", "taskId", "revision", "goal", "scopeRef",
                                "recipeId", "inputs", "slots", "requiredChecks", "budgets"])
        try object.require(["kind", "schemaVersion", "taskId", "revision", "goal", "scopeRef",
                            "recipeId", "inputs", "slots", "requiredChecks", "budgets"])
        guard (try object.string("kind")) == "task",
              (try object.string("schemaVersion")) == "0.1",
              (try object.string("recipeId")) == "fill-fields.v1" else {
            throw ShapeFailure.shape("unsupported task kind or version")
        }
        let taskId = try object.string("taskId")
        let scopeRef = try object.string("scopeRef")
        guard isValidId(taskId), isValidId(scopeRef) else { throw ShapeFailure.shape("invalid task id") }
        let revision = try object.int("revision")
        guard revision >= 1 else { throw ShapeFailure.shape("invalid revision") }
        let goal = try object.string("goal")
        guard !goal.isEmpty, goal.count <= 4096 else { throw ShapeFailure.shape("invalid goal") }

        let inputsObject = try object.object("inputs")
        guard (1...16).contains(inputsObject.raw.count) else { throw ShapeFailure.shape("invalid input count") }
        var inputs: [String: String] = [:]
        for (key, value) in inputsObject.raw {
            guard isValidId(key), let text = value as? String, text.count <= 65_536 else {
                throw ShapeFailure.shape("invalid input entry")
            }
            inputs[key] = text
        }

        let slotValues = try object.array("slots")
        guard (1...16).contains(slotValues.count) else { throw ShapeFailure.shape("invalid slot count") }
        let slots = try slotValues.map(Slot.parse)
        guard Set(slots.map(\.id)).count == slots.count else { throw ShapeFailure.shape("duplicate slot id") }
        for slot in slots where inputs[slot.inputRef] == nil {
            throw ShapeFailure.shape("slot references unknown input")
        }

        let checkValues = try object.array("requiredChecks")
        guard (1...16).contains(checkValues.count) else { throw ShapeFailure.shape("invalid check count") }
        let checks = try checkValues.map(CheckSpec.parse)
        guard Set(checks.map(\.id)).count == checks.count else { throw ShapeFailure.shape("duplicate check id") }
        // One value_equals_input check per slot, exact comparison.
        guard checks.count == slots.count else { throw ShapeFailure.shape("check count must match slots") }
        var seenSlots = Set<String>()
        for check in checks {
            guard let slot = slots.first(where: { $0.id == check.slotId }) else {
                throw ShapeFailure.shape("check references unknown slot")
            }
            guard !seenSlots.contains(check.slotId) else { throw ShapeFailure.shape("duplicate slot check") }
            seenSlots.insert(check.slotId)
            guard check.inputRef == slot.inputRef else { throw ShapeFailure.shape("check input mismatch") }
        }

        let budgets = try Budgets.parse(try object.object("budgets"))
        return TaskSpec(taskId: taskId, revision: revision, goal: goal, scopeRef: scopeRef,
                        recipeId: "fill-fields.v1", inputs: inputs, slots: slots,
                        requiredChecks: checks, budgets: budgets)
    }
}

struct Limits {
    var maxOperations: Int
    var maxSemanticRequests: Int
    var maxObservationExpansions: Int
    var deadlineMs: Int

    static func parse(_ object: JSONObject) throws -> Limits {
        try object.requireOnly(["maxOperations", "maxSemanticRequests", "maxObservationExpansions", "deadlineMs"])
        try object.require(["maxOperations", "maxSemanticRequests", "maxObservationExpansions", "deadlineMs"])
        let limits = Limits(maxOperations: try object.int("maxOperations"),
                            maxSemanticRequests: try object.int("maxSemanticRequests"),
                            maxObservationExpansions: try object.int("maxObservationExpansions"),
                            deadlineMs: try object.int("deadlineMs"))
        guard limits.maxOperations >= 0, limits.maxSemanticRequests >= 0,
              limits.maxObservationExpansions >= 0, limits.deadlineMs >= 0 else {
            throw ShapeFailure.shape("invalid grant limit")
        }
        return limits
    }
}

/// Budgets of a generic read session. The grant carries the operator ceiling;
/// a ReadSessionSpec may only request values at or below it.
struct ReadLimits: Equatable {
    var maxNodes: Int
    var maxDepth: Int
    var maxBytes: Int
    var maxCaptureMs: Int
    var maxCaptures: Int
    var deadlineMs: Int

    static func parse(_ object: JSONObject) throws -> ReadLimits {
        let keys = ["maxNodes", "maxDepth", "maxBytes", "maxCaptureMs", "maxCaptures", "deadlineMs"]
        try object.requireOnly(Set(keys))
        try object.require(keys)
        let limits = ReadLimits(maxNodes: try object.int("maxNodes"),
                                maxDepth: try object.int("maxDepth"),
                                maxBytes: try object.int("maxBytes"),
                                maxCaptureMs: try object.int("maxCaptureMs"),
                                maxCaptures: try object.int("maxCaptures"),
                                deadlineMs: try object.int("deadlineMs"))
        guard BrowserReadBudget.maxNodes.contains(limits.maxNodes),
              BrowserReadBudget.maxDepth.contains(limits.maxDepth),
              BrowserReadBudget.maxBytes.contains(limits.maxBytes),
              BrowserReadBudget.maxCaptureMs.contains(limits.maxCaptureMs),
              BrowserReadBudget.maxCaptures.contains(limits.maxCaptures),
              BrowserReadBudget.deadlineMs.contains(limits.deadlineMs) else {
            throw ShapeFailure.shape("read limit out of range")
        }
        return limits
    }

    func isWithin(_ ceiling: ReadLimits) -> Bool {
        maxNodes <= ceiling.maxNodes && maxDepth <= ceiling.maxDepth
            && maxBytes <= ceiling.maxBytes && maxCaptureMs <= ceiling.maxCaptureMs
            && maxCaptures <= ceiling.maxCaptures && deadlineMs <= ceiling.deadlineMs
    }
}

/// Origins the operator allows a refresh to select. Exact canonical origins
/// only; no wildcard, path or hostname rule. This is permission to re-select a
/// page, never the identity of the current document.
struct PageScope: Equatable {
    var origins: [String]

    static func parse(_ object: JSONObject) throws -> PageScope {
        try object.requireOnly(["origins"])
        try object.require(["origins"])
        let origins = try object.stringArray("origins")
        guard (1...16).contains(origins.count), Set(origins).count == origins.count,
              origins.allSatisfy(BrowserURL.isCanonicalOrigin) else {
            throw ShapeFailure.shape("invalid page scope origins")
        }
        return PageScope(origins: origins)
    }
}

struct ScopeGrant {
    var scopeRef: String
    var grantRef: String
    var version: Int
    var read: Bool
    var model: Bool
    var act: Bool
    var allowedCommands: [String]
    var allowedActions: [String]
    var appId: String
    var windowRef: String
    var limits: Limits
    /// Present only for the generic Chrome profile.
    var pageScope: PageScope?
    var readLimits: ReadLimits?

    static func parse(_ any: Any) throws -> ScopeGrant {
        let object = try JSONObject(any)
        try object.requireOnly(["scopeRef", "grantRef", "version", "read", "model", "act",
                                "allowedCommands", "allowedActions", "appId", "windowRef", "limits",
                                "pageScope", "readLimits"])
        try object.require(["scopeRef", "grantRef", "version", "read", "model", "act",
                            "allowedCommands", "appId", "windowRef", "limits"])
        var allowedActions: [String] = []
        if object.has("allowedActions") {
            for item in try object.array("allowedActions") {
                guard let action = item as? String else { throw ShapeFailure.shape("invalid action") }
                allowedActions.append(action)
            }
            guard Set(allowedActions).count == allowedActions.count else {
                throw ShapeFailure.shape("duplicate action")
            }
            guard allowedActions.allSatisfy({ AppProfile.registeredActions.contains($0) }) else {
                throw ShapeFailure.shape("unknown action")
            }
        }
        // pageScope/readLimits belong to the generic Chrome profile only. Any
        // other profile rejects the keys outright, including an explicit null.
        let isGenericChrome = (try object.string("appId")) == AppProfile.chromeId
        var pageScope: PageScope?
        var readLimits: ReadLimits?
        if isGenericChrome {
            try object.require(["pageScope", "readLimits"])
            pageScope = try PageScope.parse(try object.object("pageScope"))
            readLimits = try ReadLimits.parse(try object.object("readLimits"))
        } else {
            guard object.raw["pageScope"] == nil, object.raw["readLimits"] == nil else {
                throw ShapeFailure.shape("page scope is only valid for the generic Chrome profile")
            }
        }
        let grant = ScopeGrant(scopeRef: try object.string("scopeRef"),
                               grantRef: try object.string("grantRef"),
                               version: try object.int("version"),
                               read: try object.bool("read"),
                               model: try object.bool("model"),
                               act: try object.bool("act"),
                               allowedCommands: try object.stringArray("allowedCommands"),
                               allowedActions: allowedActions,
                               appId: try object.string("appId"),
                               windowRef: try object.string("windowRef"),
                               limits: try Limits.parse(try object.object("limits")),
                               pageScope: pageScope, readLimits: readLimits)
        guard isValidId(grant.scopeRef), isValidId(grant.grantRef), isValidId(grant.windowRef) else {
            throw ShapeFailure.shape("invalid grant id")
        }
        guard grant.version >= 1 else { throw ShapeFailure.shape("invalid grant version") }
        guard !grant.appId.isEmpty, grant.appId.count <= 128 else { throw ShapeFailure.shape("invalid app id") }
        guard grant.allowedCommands.allSatisfy({ $0 == "set_value" || $0 == "invoke" }),
              !grant.act || !grant.allowedCommands.isEmpty else {
            throw ShapeFailure.shape("unsupported command in grant")
        }
        if grant.appId == AppProfile.chromeId {
            guard grant.read, !grant.model, !grant.act,
                  grant.allowedCommands.isEmpty, grant.allowedActions.isEmpty,
                  grant.limits.maxOperations == 0, grant.limits.maxSemanticRequests == 0 else {
                throw ShapeFailure.shape("generic Chrome profile requires a read-only, model-free grant")
            }
        }
        return grant
    }
}

/// A Task-free read session. It carries no inputs, slots or checks and can
/// never be used to prepare or commit an operation.
struct ReadSessionSpec: Equatable {
    var readSessionId: String
    var scopeRef: String
    var limits: ReadLimits

    static func parse(_ any: Any) throws -> ReadSessionSpec {
        let object = try JSONObject(any)
        let keys = ["kind", "schemaVersion", "readSessionId", "scopeRef", "limits"]
        try object.requireOnly(Set(keys))
        try object.require(keys)
        guard (try object.string("kind")) == "read_session",
              (try object.string("schemaVersion")) == "0.1" else {
            throw ShapeFailure.shape("unsupported read session kind or version")
        }
        let spec = ReadSessionSpec(readSessionId: try object.string("readSessionId"),
                                   scopeRef: try object.string("scopeRef"),
                                   limits: try ReadLimits.parse(try object.object("limits")))
        guard isValidId(spec.readSessionId), isValidId(spec.scopeRef) else {
            throw ShapeFailure.shape("invalid read session id")
        }
        return spec
    }
}

/// Identifies one selected document generation of this host epoch. `ref` is an
/// opaque token; it is not derived from the URL.
struct DocumentStamp: Equatable {
    var sessionEpoch: String
    var ref: String
    var generation: Int

    static func parse(_ any: Any) throws -> DocumentStamp {
        let object = try JSONObject(any)
        try object.requireOnly(["sessionEpoch", "ref", "generation"])
        try object.require(["sessionEpoch", "ref", "generation"])
        let stamp = DocumentStamp(sessionEpoch: try object.string("sessionEpoch"),
                                  ref: try object.string("ref"),
                                  generation: try object.int("generation"))
        guard isValidId(stamp.sessionEpoch), isValidId(stamp.ref), stamp.generation >= 1 else {
            throw ShapeFailure.shape("invalid document stamp")
        }
        return stamp
    }

    var json: [String: Any] { ["sessionEpoch": sessionEpoch, "ref": ref, "generation": generation] }
}

struct EvidenceRef: Equatable {
    var observationId: String
    var nodeRef: String
    var field: String

    static func parse(_ any: Any) throws -> EvidenceRef {
        let object = try JSONObject(any)
        try object.requireOnly(["observationId", "nodeRef", "field"])
        try object.require(["observationId", "nodeRef", "field"])
        let field = try object.string("field")
        guard ["name", "role", "parentRef", "value", "enabled", "capabilities"].contains(field) else {
            throw ShapeFailure.shape("unknown evidence field")
        }
        let evidence = EvidenceRef(observationId: try object.string("observationId"),
                                   nodeRef: try object.string("nodeRef"),
                                   field: field)
        guard isValidId(evidence.observationId), isValidId(evidence.nodeRef) else {
            throw ShapeFailure.shape("invalid evidence ref")
        }
        return evidence
    }

    var json: [String: Any] { ["observationId": observationId, "nodeRef": nodeRef, "field": field] }
}

struct Binding: Equatable {
    var slotId: String
    var targetRef: String
    var observationId: String
    var source: String
    var evidence: [EvidenceRef]

    static func parse(_ any: Any) throws -> Binding {
        let object = try JSONObject(any)
        try object.requireOnly(["slotId", "targetRef", "observationId", "source", "evidence"])
        try object.require(["slotId", "targetRef", "observationId", "source", "evidence"])
        let source = try object.string("source")
        guard ["profile", "operator", "semantic"].contains(source) else {
            throw ShapeFailure.shape("unknown binding source")
        }
        let evidence = try object.array("evidence").map(EvidenceRef.parse)
        guard !evidence.isEmpty else { throw ShapeFailure.shape("evidence required") }
        let binding = Binding(slotId: try object.string("slotId"),
                              targetRef: try object.string("targetRef"),
                              observationId: try object.string("observationId"),
                              source: source,
                              evidence: evidence)
        guard isValidId(binding.slotId), isValidId(binding.targetRef), isValidId(binding.observationId) else {
            throw ShapeFailure.shape("invalid binding id")
        }
        return binding
    }

    var json: [String: Any] {
        ["slotId": slotId, "targetRef": targetRef, "observationId": observationId,
         "source": source, "evidence": evidence.map(\.json)]
    }
}

enum Command: Equatable {
    case setValue(targetRef: String, value: String)
    case invoke(targetRef: String)

    var kind: String {
        switch self {
        case .setValue: return "set_value"
        case .invoke: return "invoke"
        }
    }

    var targetRef: String {
        switch self {
        case .setValue(let ref, _): return ref
        case .invoke(let ref): return ref
        }
    }

    static func parse(_ any: Any) throws -> Command {
        let object = try JSONObject(any)
        let kind = try object.string("kind")
        switch kind {
        case "set_value":
            try object.requireOnly(["kind", "targetRef", "value"])
            try object.require(["kind", "targetRef", "value"])
            let targetRef = try object.string("targetRef")
            let value = try object.string("value")
            guard isValidId(targetRef), value.count <= 65_536 else { throw ShapeFailure.shape("invalid command") }
            return .setValue(targetRef: targetRef, value: value)
        case "invoke":
            try object.requireOnly(["kind", "targetRef"])
            try object.require(["kind", "targetRef"])
            let targetRef = try object.string("targetRef")
            guard isValidId(targetRef) else { throw ShapeFailure.shape("invalid command") }
            return .invoke(targetRef: targetRef)
        default:
            throw ShapeFailure.shape("unknown command kind")
        }
    }

    var json: [String: Any] {
        switch self {
        case .setValue(let ref, let value): return ["kind": "set_value", "targetRef": ref, "value": value]
        case .invoke(let ref): return ["kind": "invoke", "targetRef": ref]
        }
    }
}
