import ApplicationServices
import Foundation

func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}
func attribute(_ element: AXUIElement, _ name: String) -> (AXError, CFTypeRef?) {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return (error, value)
}
func string(_ element: AXUIElement, _ name: String) -> String? {
    let (error, value) = attribute(element, name)
    return error == .success ? value as? String : nil
}

let args = CommandLine.arguments
if args.contains("--trust") {
    emit(["trusted": AXIsProcessTrusted(), "prompted": false])
} else if args.count == 3, args[1] == "--pid", let pid = Int32(args[2]), pid > 0 {
    guard AXIsProcessTrusted() else {
        emit(["status": "scope_denied", "reason": "accessibility_permission_missing", "prompted": false])
        exit(2)
    }
    let application = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(application, 2.0)
    var queue: [(AXUIElement, Int?)] = [(application, nil)]
    var visited: [AXUIElement] = []
    var nodes: [[String: Any]] = []
    var omitted = false
    var index = 0
    while index < queue.count && nodes.count < 512 {
        let (element, parent) = queue[index]
        index += 1
        if visited.contains(where: { CFEqual($0, element) }) { continue }
        visited.append(element)
        var settable = DarwinBoolean(false)
        let canSet = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
        var actionNames: CFArray?
        let actionError = AXUIElementCopyActionNames(element, &actionNames)
        let actions = actionError == .success ? (actionNames as? [String] ?? []) : []
        let nodeIndex = nodes.count
        var node: [String: Any] = ["index": nodeIndex, "parent": parent.map { $0 as Any } ?? NSNull(), "role": string(element, kAXRoleAttribute) ?? "unknown", "valueSettable": canSet == .success && settable.boolValue, "actions": actions]
        if let title = string(element, kAXTitleAttribute) { node["title"] = title }
        if let description = string(element, kAXDescriptionAttribute) { node["description"] = description }
        // Probe omits field values: capability/shape inspection does not need user content.
        nodes.append(node)
        let (childError, children) = attribute(element, kAXChildrenAttribute)
        if childError == .success, let children = children as? [AXUIElement] {
            for child in children { queue.append((child, nodeIndex)) }
        } else if childError != .attributeUnsupported { omitted = true }
    }
    if index < queue.count { omitted = true }
    emit(["status": "observed", "pid": pid, "coverage": omitted ? "partial" : "provider_exhausted", "nodes": nodes])
} else {
    FileHandle.standardError.write(Data("Usage: AriadneAXProbe --trust | --pid PID\n".utf8))
    exit(64)
}
