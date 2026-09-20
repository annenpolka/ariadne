import Foundation

struct BrowserActionTask {
    struct Step { let id: String; let kind: String; let inputRef: String? }
    let raw: [String: Any]
    let taskId: String
    let revision: Int
    let scopeRef: String
    let inputs: [String: String]
    let steps: [Step]
    let limits: ReadLimits

    static func parse(_ any: Any) throws -> BrowserActionTask {
        let o = try JSONObject(any)
        let fields: Set<String> = ["kind", "schemaVersion", "recipeId", "taskId", "revision", "scopeRef", "goal", "inputs", "steps", "requiredChecks", "limits"]
        try o.requireOnly(fields); try o.require(Array(fields))
        guard try o.string("kind") == "browser_action_task", try o.string("schemaVersion") == "0.1",
              try o.string("recipeId") == "browser-actions.v1" else { throw ShapeFailure.shape("invalid action task") }
        let taskId = try o.string("taskId"), scopeRef = try o.string("scopeRef"), revision = try o.int("revision"), goal = try o.string("goal")
        guard isValidId(taskId), isValidId(scopeRef), revision > 0, !goal.isEmpty, goal.utf16.count <= 4096 else { throw ShapeFailure.shape("invalid task identity") }
        let inputObject = try o.object("inputs")
        guard inputObject.raw.count <= 32 else { throw ShapeFailure.shape("too many inputs") }
        var inputs: [String: String] = [:]
        for (key, value) in inputObject.raw {
            guard isValidId(key), let text = value as? String, text.utf16.count <= 65536 else { throw ShapeFailure.shape("invalid input") }
            inputs[key] = text
        }
        let rawSteps = try o.array("steps")
        guard (1...100).contains(rawSteps.count) else { throw ShapeFailure.shape("invalid steps") }
        var steps: [Step] = []
        for raw in rawSteps {
            let s = try JSONObject(raw), kind = try s.string("kind"), id = try s.string("id"), purpose = try s.string("purpose")
            let keys: Set<String> = kind == "set_value" ? ["id", "purpose", "kind", "inputRef"] : ["id", "purpose", "kind"]
            try s.requireOnly(keys); try s.require(Array(keys))
            guard ["set_value", "invoke"].contains(kind), isValidId(id), !purpose.isEmpty, purpose.utf16.count <= 4096,
                  !steps.contains(where: { $0.id == id }) else { throw ShapeFailure.shape("invalid step") }
            let input = kind == "set_value" ? try s.string("inputRef") : nil
            if let input, inputs[input] == nil { throw ShapeFailure.shape("unknown input") }
            steps.append(Step(id: id, kind: kind, inputRef: input))
        }
        let checks = try o.array("requiredChecks")
        guard (1...16).contains(checks.count) else { throw ShapeFailure.shape("invalid checks") }
        var ids = Set<String>()
        for raw in checks {
            let c = try JSONObject(raw)
            try c.requireOnly(["id", "attribute", "text", "match"]); try c.require(["id", "attribute", "text", "match"])
            let id = try c.string("id"), text = try c.string("text")
            guard isValidId(id), ids.insert(id).inserted, !text.isEmpty, text.utf16.count <= 4096,
                  try ["name", "value"].contains(c.string("attribute")), try ["equals", "contains"].contains(c.string("match")) else { throw ShapeFailure.shape("invalid check") }
        }
        return BrowserActionTask(raw: o.raw, taskId: taskId, revision: revision, scopeRef: scopeRef, inputs: inputs,
                                 steps: steps, limits: try ReadLimits.parse(o.object("limits")))
    }

    func operationId(_ step: Step) -> String {
        "a-" + sha256Hex(Data("\(taskId)#\(revision)#\(step.id)".utf8))
    }
}

struct BrowserActionPolicy {
    static let setRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox"]
    static let pressRoles: Set<String> = ["AXButton", "AXPopUpButton", "AXMenuButton", "AXMenuItem", "AXCheckBox", "AXRadioButton", "AXLink", "AXDisclosureTriangle"]
    let task: BrowserActionTask
    let setValueRoles: Set<String>
    let invokeRoles: Set<String>
    static func parse(_ any: Any) throws -> BrowserActionPolicy {
        let o = try JSONObject(any)
        try o.requireOnly(["task", "setValueRoles", "invokeRoles"]); try o.require(["task", "setValueRoles", "invokeRoles"])
        let set = try o.stringArray("setValueRoles"), press = try o.stringArray("invokeRoles")
        guard Set(set).count == set.count, Set(press).count == press.count,
              Set(set).isSubset(of: setRoles), Set(press).isSubset(of: pressRoles) else { throw ShapeFailure.shape("unsupported browser action role") }
        return BrowserActionPolicy(task: try BrowserActionTask.parse(o.object("task").raw), setValueRoles: Set(set), invokeRoles: Set(press))
    }
}
