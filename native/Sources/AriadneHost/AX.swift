import AppKit
import ApplicationServices
import Foundation

// MARK: - Attribute results

/// Mirrors `Attribute<T>` from src/contracts.ts. Empty strings and false are
/// real values; only an explicit failure maps to a non-available status.
enum AttrValue<T> {
    case available(T)
    case unavailable
    case unsupported
    case redacted
    case error

    func json(_ transform: (T) -> Any) -> [String: Any] {
        switch self {
        case .available(let value): return ["status": "available", "value": transform(value)]
        case .unavailable: return ["status": "unavailable"]
        case .unsupported: return ["status": "unsupported"]
        case .redacted: return ["status": "redacted"]
        case .error: return ["status": "error"]
        }
    }

    var availableValue: T? {
        if case .available(let value) = self { return value }
        return nil
    }
}

/// One step of a node's native lineage. Identity is the host-issued opaque ref,
/// which is stable for a retained AXUIElement; role/name are compared as well so
/// an in-place relabel is detected even when the object is the same.
struct AncestryStep: Equatable {
    var ref: String
    var role: String
    var nativeRole: String
    var nameJSON: String
}

func normalizeRole(_ nativeRole: String) -> String {
    switch nativeRole {
    case "AXApplication": return "application"
    case "AXWindow": return "window"
    case "AXSheet", "AXAlert", "AXDialog": return "dialog"
    case "AXGroup", "AXScrollArea", "AXSplitGroup", "AXBox": return "group"
    case "AXTextField", "AXSearchField", "AXComboBox": return "text_field"
    case "AXTextArea": return "text_area"
    case "AXButton", "AXPopUpButton", "AXMenuButton", "AXCheckBox", "AXRadioButton": return "button"
    case "AXStaticText": return "text"
    case "AXSecureTextField": return "text_field"
    default: return "unknown"
    }
}

func copyAttribute(_ element: AXUIElement, _ name: String) -> (AXError, CFTypeRef?) {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return (error, value)
}

/// CFTypeRef values are checked by type id before they are treated as elements,
/// so a non-element attribute is never force-cast into an AXUIElement.
func asElement(_ raw: CFTypeRef?) -> AXUIElement? {
    guard let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(raw, to: AXUIElement.self)
}

/// CFURL or string attribute (Chrome's `AXURL`).
func readURLAttribute(_ element: AXUIElement, _ name: String) -> String? {
    let (error, raw) = copyAttribute(element, name)
    guard error == .success else { return nil }
    if let url = raw as? URL { return url.absoluteString }
    if let text = raw as? String { return text }
    return nil
}

struct ElementArrayResult {
    var elements: [AXUIElement]
    var hadInvalid: Bool
}

/// Converts a CFArray to elements only after checking each member's CFTypeID.
/// Non-element members are reported instead of being converted blindly.
func asElementArray(_ raw: CFTypeRef?) -> ElementArrayResult? {
    guard let raw, CFGetTypeID(raw) == CFArrayGetTypeID() else { return nil }
    let array = unsafeBitCast(raw, to: CFArray.self)
    var result: [AXUIElement] = []
    var hadInvalid = false
    for index in 0..<CFArrayGetCount(array) {
        guard let pointer = CFArrayGetValueAtIndex(array, index) else {
            hadInvalid = true
            continue
        }
        let value = Unmanaged<AnyObject>.fromOpaque(pointer).takeUnretainedValue()
        if CFGetTypeID(value) == AXUIElementGetTypeID() {
            result.append(unsafeBitCast(value, to: AXUIElement.self))
        } else {
            hadInvalid = true
        }
    }
    return ElementArrayResult(elements: result, hadInvalid: hadInvalid)
}

/// A password control is never read and never advertised as settable.
func isSecureElement(_ element: AXUIElement) -> Bool {
    if readString(element, kAXRoleAttribute).availableValue == "AXSecureTextField" { return true }
    return readString(element, kAXSubroleAttribute).availableValue == "AXSecureTextField"
}

func readString(_ element: AXUIElement, _ name: String) -> AttrValue<String> {
    let (error, raw) = copyAttribute(element, name)
    switch error {
    case .success:
        if let text = raw as? String { return .available(text) }
        if let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
            return .available(number.stringValue)
        }
        // A successful read of an unexpected type is an error, not empty.
        return .error
    case .attributeUnsupported: return .unsupported
    case .noValue: return .unavailable
    default: return .error
    }
}

func readBool(_ element: AXUIElement, _ name: String) -> AttrValue<Bool> {
    let (error, raw) = copyAttribute(element, name)
    switch error {
    case .success:
        guard let number = raw as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
            return .error
        }
        return .available(number.boolValue)
    case .attributeUnsupported: return .unsupported
    case .noValue: return .unavailable
    default: return .error
    }
}

/// Name resolution prefers a non-empty title, then the accessibility label
/// (description). Absence of a readable name is never invented as "".
func readName(_ element: AXUIElement) -> AttrValue<String> {
    let title = readString(element, kAXTitleAttribute)
    if case .available(let value) = title, !value.isEmpty { return .available(value) }
    let description = readString(element, kAXDescriptionAttribute)
    if case .available(let value) = description, !value.isEmpty { return .available(value) }
    if case .available(let value) = title { return .available(value) }
    if case .available(let value) = description { return .available(value) }
    if case .unsupported = title, case .unsupported = description { return .unsupported }
    return .unavailable
}

func nameJSON(_ element: AXUIElement) -> String {
    jsonString(readName(element).json({ $0 }))
}

func readIdentifier(_ element: AXUIElement) -> String? {
    readString(element, "AXIdentifier").availableValue
}

/// `invoke` is advertised only for a registered fixture action that the operator
/// allowed. The identifier itself is never emitted into an Observation.
func readCapabilities(_ element: AXUIElement, allowedInvokeActions: Set<String>) -> [String] {
    if isSecureElement(element) { return [] }
    var capabilities: [String] = []
    if isValueSettable(element) { capabilities.append("set_value") }
    var actionNames: CFArray?
    if AXUIElementCopyActionNames(element, &actionNames) == .success,
       let actions = actionNames as? [String], actions.contains("AXPress"),
       let identifier = readIdentifier(element), allowedInvokeActions.contains(identifier) {
        capabilities.append("invoke")
    }
    return capabilities
}

func isValueSettable(_ element: AXUIElement) -> Bool {
    if isSecureElement(element) { return false }
    var settable = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success
        && settable.boolValue
}

// MARK: - Notification counter

final class EventCounter {
    private let lock = NSLock()
    private var count = 0

    func bump() {
        lock.lock(); defer { lock.unlock() }
        count += 1
    }

    var value: Int {
        lock.lock(); defer { lock.unlock() }
        return count
    }
}

// MARK: - Opaque ref registry

/// Maps retained AXUIElement objects to opaque refs for the lifetime of this
/// host epoch. The same native object yields the same ref across captures; a
/// different native object never inherits an old ref.
final class RefRegistry {
    private let lock = NSLock()
    private var entries: [(ref: String, element: AXUIElement)] = []

    func ref(for element: AXUIElement, preferred: String? = nil) -> String {
        lock.lock(); defer { lock.unlock() }
        if let existing = entries.first(where: { CFEqual($0.element, element) }) { return existing.ref }
        let ref = preferred ?? ("r-" + UUID().uuidString)
        entries.append((ref, element))
        return ref
    }

    func element(for ref: String) -> AXUIElement? {
        lock.lock(); defer { lock.unlock() }
        return entries.first(where: { $0.ref == ref })?.element
    }
}

// MARK: - Captured node

struct CapturedNode {
    var ref: String
    var parentRef: String?
    var role: String
    var nativeRole: String
    var name: [String: Any]
    var value: [String: Any]
    var enabled: [String: Any]
    var capabilities: [String]
    var nameJSON: String
    var enabledJSON: String
    var valueStatus: String
    var ancestors: [AncestryStep]
    var actionId: String?
    var element: AXUIElement

    var json: [String: Any] {
        ["ref": ref, "parentRef": parentRef ?? NSNull(), "role": role, "nativeRole": nativeRole,
         "name": name, "value": value, "enabled": enabled, "capabilities": capabilities]
    }
}

// MARK: - Target application/window

/// Resolves and retains the single granted window. Native identity is held as
/// the AXUIElement itself plus the process launch date; labels and positions are
/// never used as identity.
final class AXTarget {
    let pid: pid_t
    let app: AXUIElement
    let window: AXUIElement
    let windowTitle: String
    let appId: String
    let documentPath: String?
    let pageURL: String?
    let launchDate: Date?
    let counter = EventCounter()
    let registry = RefRegistry()
    /// Registered action IDs the operator allowed; empty disables invoke.
    var invokeActionIds: Set<String> = []
    private var webArea: AXUIElement?
    private var webAreaRef: String?

    private var observer: AXObserver?
    private var observerThread: Thread?

    private init(pid: pid_t, app: AXUIElement, window: AXUIElement, windowTitle: String,
                 documentPath: String?, pageURL: String?, appId: String, launchDate: Date?) {
        self.pid = pid
        self.app = app
        self.window = window
        self.windowTitle = windowTitle
        self.documentPath = documentPath
        self.pageURL = pageURL
        self.appId = appId
        self.launchDate = launchDate
    }

    static func resolve(pid: pid_t, windowTitle: String, appId: String,
                        documentPath: String?, pageURL: String? = nil) throws -> AXTarget {
        guard pid > 0 else { throw HostError(.invalidRequest, "pid must be positive") }
        // The generic read profile uses BrowserReadTarget and never gets a
        // mutation-capable target.
        guard appId != AppProfile.chromeId else {
            throw HostError(.scopeDenied, "generic Chrome profile has no operation target")
        }
        guard let executable = AppProfile.expectedExecutable(for: appId) else {
            throw HostError(.unsupported, "unsupported app profile")
        }
        guard AXIsProcessTrusted() else {
            throw HostError(.scopeDenied, "accessibility permission missing")
        }
        guard let running = NSRunningApplication(processIdentifier: pid), !running.isTerminated else {
            throw HostError(.scopeDenied, "target process is not running")
        }
        guard let url = running.executableURL, url.lastPathComponent == executable else {
            throw HostError(.unsupported, "target executable does not match registered profile")
        }
        let resolvedDocument: String?
        if appId == AppProfile.textEditId {
            guard running.bundleIdentifier == AppProfile.textEditId else {
                throw HostError(.unsupported, "target bundle does not match registered profile")
            }
            guard let documentPath else {
                throw HostError(.unsupported, "TextEdit profile requires --document")
            }
            resolvedDocument = try validateDocumentPath(documentPath)
        } else {
            resolvedDocument = nil
        }
        let resolvedPageURL: String?
        if AppProfile.isBrowser(appId) {
            guard running.bundleIdentifier == AppProfile.chromeBundleId else {
                throw HostError(.unsupported, "target bundle does not match registered profile")
            }
            guard let pageURL, let canonical = AppProfile.canonicalURL(pageURL, for: appId) else {
                throw HostError(.invalidRequest, "Chrome profile requires a canonical --page-url")
            }
            resolvedPageURL = canonical
        } else {
            resolvedPageURL = nil
        }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 2.0)
        let selected = try selectWindow(of: app, title: windowTitle, documentPath: resolvedDocument)
        AXUIElementSetMessagingTimeout(selected, 2.0)
        let target = AXTarget(pid: pid, app: app, window: selected, windowTitle: windowTitle,
                              documentPath: resolvedDocument, pageURL: resolvedPageURL,
                              appId: appId, launchDate: running.launchDate)
        try target.resolveWebArea()
        target.startObserver()
        return target
    }

    /// Boundedly finds exactly one retained `AXWebArea` in the window and checks
    /// its URL. Multiple frames, a missing URL, truncated traversal or a URL
    /// mismatch all fail closed.
    private func resolveWebArea() throws {
        guard let expected = pageURL else { return }
        guard let document = readURLAttribute(window, "AXDocument"), AppProfile.canonicalURL(document, for: appId) == expected else {
            throw HostError(.staleBinding, "browser window document does not match the operator page")
        }
        guard let area = Self.findSingleWebArea(in: window) else {
            throw HostError(.staleBinding, "no unique web area in the target window")
        }
        guard let raw = readURLAttribute(area, "AXURL"), AppProfile.canonicalURL(raw, for: appId) == expected else {
            throw HostError(.staleBinding, "web area URL does not match the operator page")
        }
        webArea = area
        webAreaRef = registry.ref(for: area)
    }

    /// Bounded search for a WebArea. Fails closed (nil) on any unreadable or
    /// partially-converted child array, so an unreadable branch cannot be
    /// treated as if it did not exist. `.attributeUnsupported`/`.noValue` are
    /// the accepted terminal cases for a childless element.
    static func findSingleWebArea(in root: AXUIElement, maxNodes: Int = 2048) -> AXUIElement? {
        var found: [AXUIElement] = []
        var visited: [AXUIElement] = []
        var queue: [AXUIElement] = [root]
        var index = 0
        var truncated = false
        var enqueued = 1
        while index < queue.count {
            if visited.count >= maxNodes || enqueued > maxNodes * 4 {
                truncated = true
                break
            }
            let element = queue[index]
            index += 1
            if visited.contains(where: { CFEqual($0, element) }) { continue }
            visited.append(element)
            if readString(element, kAXRoleAttribute).availableValue == "AXWebArea" {
                found.append(element)
            }
            let (childError, raw) = copyAttribute(element, kAXChildrenAttribute)
            switch childError {
            case .success:
                guard let result = asElementArray(raw), !result.hadInvalid else { return nil }
                for child in result.elements {
                    queue.append(child)
                    enqueued += 1
                }
            case .attributeUnsupported, .noValue:
                // Documented terminal: leaf element with no children.
                break
            default:
                // .cannotComplete, .invalidUIElement, .error, etc.
                return nil
            }
        }
        guard !truncated, found.count == 1 else { return nil }
        return found.first
    }

    var isChromeProfile: Bool { pageURL != nil }

    func isUnderRetainedWebArea(_ element: AXUIElement) -> Bool {
        guard pageURL != nil else { return true }
        guard let retained = webArea else { return false }
        var current: AXUIElement? = element
        var seen: [AXUIElement] = []
        var depth = 0
        while let node = current {
            depth += 1
            if depth > 64 { return false }
            if seen.contains(where: { CFEqual($0, node) }) { return false }
            seen.append(node)
            if CFEqual(node, retained) { return true }
            if CFEqual(node, window) { return false }
            let (error, raw) = copyAttribute(node, "AXParent")
            guard error == .success, let parent = asElement(raw) else { return false }
            current = parent
        }
        return false
    }

    /// An absolute, existing, regular, non-symlink document path.
    static func validateDocumentPath(_ path: String) throws -> String {
        let url = URL(fileURLWithPath: path)
        guard path.hasPrefix("/") else {
            throw HostError(.unsupported, "document path must be absolute")
        }
        let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard values?.isRegularFile == true, values?.isSymbolicLink != true else {
            throw HostError(.unsupported, "document must be an existing regular non-symlink file")
        }
        return url.standardizedFileURL.path
    }

    static func expectedExecutable(for appId: String) -> String? {
        AppProfile.expectedExecutable(for: appId)
    }

    static func windows(of app: AXUIElement, matchingTitle title: String) -> [AXUIElement] {
        let (error, raw) = copyAttribute(app, kAXWindowsAttribute)
        guard error == .success, let result = asElementArray(raw) else { return [] }
        return result.elements.filter { readString($0, kAXTitleAttribute).availableValue == title }
    }

    /// The standardized file path an AX window reports, or nil when the
    /// attribute is absent/unreadable.
    static func documentPath(of window: AXUIElement) -> String? {
        let (error, raw) = copyAttribute(window, "AXDocument")
        guard error == .success else { return nil }
        if let url = raw as? URL { return url.standardizedFileURL.path }
        if let text = raw as? String {
            if let url = URL(string: text), url.isFileURL { return url.standardizedFileURL.path }
            return URL(fileURLWithPath: text).standardizedFileURL.path
        }
        return nil
    }

    private static func selectWindow(of app: AXUIElement, title: String,
                                     documentPath: String?) throws -> AXUIElement {
        let titleMatches = windows(of: app, matchingTitle: title)
        guard let documentPath else {
            guard titleMatches.count == 1, let selected = titleMatches.first else {
                throw HostError(.scopeDenied, "window title does not identify exactly one window")
            }
            return selected
        }
        var readable: [(AXUIElement, String)] = []
        var hadUnreadable = false
        for window in titleMatches {
            if let path = Self.documentPath(of: window) { readable.append((window, path)) } else { hadUnreadable = true }
        }
        let matches = readable.filter { $0.1 == documentPath }.map(\.0)
        guard matches.count == 1, let selected = matches.first else {
            if titleMatches.isEmpty {
                throw HostError(.scopeDenied, "window title does not identify exactly one window")
            }
            if readable.isEmpty, hadUnreadable {
                throw HostError(.unsupported, "document identity is unavailable")
            }
            throw HostError(.scopeDenied, "document does not match the operator document")
        }
        return selected
    }

    /// Re-enumerates the app's windows and confirms the retained native window
    /// is still present under the exact title. A same-name replacement fails.
    /// For the TextEdit profile the document identity is rechecked too.
    func verifyWindowIdentity() throws {
        guard let running = NSRunningApplication(processIdentifier: pid), !running.isTerminated else {
            throw HostError(.scopeDenied, "target process is not running")
        }
        if let expected = launchDate, let actual = running.launchDate, expected != actual {
            throw HostError(.staleBinding, "target process was replaced")
        }
        let matches = AXTarget.windows(of: app, matchingTitle: windowTitle)
        guard matches.count == 1, let current = matches.first, CFEqual(current, window) else {
            throw HostError(.staleBinding, "window identity changed")
        }
        if let documentPath {
            guard AXTarget.documentPath(of: current) == documentPath else {
                throw HostError(.staleBinding, "document identity changed")
            }
        }
        if let expected = pageURL {
            guard let document = readURLAttribute(current, "AXDocument"), AppProfile.canonicalURL(document, for: appId) == expected,
                  let retained = webArea,
                  let area = AXTarget.findSingleWebArea(in: window), CFEqual(area, retained),
                  let raw = readURLAttribute(area, "AXURL"), AppProfile.canonicalURL(raw, for: appId) == expected else {
                throw HostError(.staleBinding, "page web area or URL changed")
            }
        }
    }

    // MARK: Guard reads

    func attributeName(_ element: AXUIElement) -> AttrValue<String> { readName(element) }
    func attributeValue(_ element: AXUIElement) -> AttrValue<String> {
        if isSecureElement(element) { return .redacted }
        return readString(element, kAXValueAttribute)
    }
    func attributeEnabled(_ element: AXUIElement) -> AttrValue<Bool> { readBool(element, kAXEnabledAttribute) }
    func nativeRole(_ element: AXUIElement) -> String {
        readString(element, kAXRoleAttribute).availableValue ?? "unknown"
    }
    func capabilities(_ element: AXUIElement) -> [String] {
        readCapabilities(element, allowedInvokeActions: invokeActionIds)
    }
    func isValueSettable(_ element: AXUIElement) -> Bool { AriadneHost_isValueSettable(element) }

    /// Returns the registered action ID for a button the operator allowed, or nil.
    func registeredInvokeAction(_ element: AXUIElement) -> String? {
        guard let identifier = readIdentifier(element), invokeActionIds.contains(identifier) else { return nil }
        return identifier
    }

    func hasPressAction(_ element: AXUIElement) -> Bool {
        var actionNames: CFArray?
        guard AXUIElementCopyActionNames(element, &actionNames) == .success,
              let actions = actionNames as? [String] else { return false }
        return actions.contains("AXPress")
    }

    func focusedWindow() -> AXUIElement? {
        let (error, raw) = copyAttribute(app, kAXFocusedWindowAttribute)
        guard error == .success, let focused = asElement(raw) else { return nil }
        return focused
    }

    func isFocusedWindowRetained() -> Bool {
        guard let focused = focusedWindow() else { return false }
        return CFEqual(focused, window)
    }

    func modalSheet() -> AXUIElement? {
        let (error, raw) = copyAttribute(window, "AXSheets")
        if error == .success, let result = asElementArray(raw), let sheet = result.elements.first { return sheet }
        // AppKit can expose an attached sheet through AXChildren rather than AXSheets.
        var queue = [window]; var seen: [AXUIElement] = []; var index = 0
        while index < queue.count && index < 2048 {
            let element = queue[index]; index += 1
            if seen.contains(where: { CFEqual($0, element) }) { continue }; seen.append(element)
            let role = nativeRole(element)
            if role == "AXSheet" || role == "AXDialog" || readString(element, "AXSubrole").availableValue == "AXDialog" { return element }
            let (childError, children) = copyAttribute(element, kAXChildrenAttribute)
            if childError == .success, let result = asElementArray(children) { queue.append(contentsOf: result.elements) }
        }
        return nil
    }

    func hasModalSheet() -> Bool { modalSheet() != nil }

    /// Walks the native `AXParent` lineage from the element up to the granted
    /// window, using registry refs for identity. Returns nil when the lineage is
    /// incomplete (detached target, unreadable parent) so callers can stop.
    func liveAncestry(for element: AXUIElement) -> [AncestryStep]? {
        var steps: [AncestryStep] = []
        var current: AXUIElement? = element
        var seen: [AXUIElement] = []
        while let node = current {
            if seen.contains(where: { CFEqual($0, node) }) { return nil }
            seen.append(node)
            let role = nativeRole(node)
            steps.append(AncestryStep(ref: registry.ref(for: node), role: normalizeRole(role),
                                      nativeRole: role, nameJSON: nameJSON(node)))
            if CFEqual(node, window) { return steps }
            let (error, raw) = copyAttribute(node, "AXParent")
            guard error == .success, let parent = asElement(raw) else { return nil }
            current = parent
        }
        return nil
    }

    func setValue(_ element: AXUIElement, _ value: String) -> AXError {
        AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef)
    }

    func performPress(_ element: AXUIElement) -> AXError {
        AXUIElementPerformAction(element, "AXPress" as CFString)
    }

    // MARK: Capture

    func capture(root: AXUIElement, rootRef: String,
                 maxNodes: Int) -> (nodes: [CapturedNode], omitted: Set<String>) {
        var nodes: [CapturedNode] = []
        var omitted = Set<String>()
        var visited: [AXUIElement] = []
        var queue: [(element: AXUIElement, parentRef: String?, parentAncestors: [AncestryStep])] = [(root, nil, [])]
        var index = 0
        while index < queue.count {
            if nodes.count >= maxNodes {
                omitted.insert("budget")
                break
            }
            let (element, parentRef, parentAncestors) = queue[index]
            index += 1
            if visited.contains(where: { CFEqual($0, element) }) { continue }
            visited.append(element)

            let ref = registry.ref(for: element, preferred: parentRef == nil ? rootRef : nil)
            guard !nodes.contains(where: { $0.ref == ref }) else { continue }
            let role = nativeRole(element)
            let name = attributeName(element)
            let value = attributeValue(element)
            let enabled = attributeEnabled(element)
            let step = AncestryStep(ref: ref, role: normalizeRole(role), nativeRole: role,
                                    nameJSON: jsonString(name.json({ $0 })))
            let ancestors = parentAncestors + [step]
            var capabilities = readCapabilities(element, allowedInvokeActions: invokeActionIds)
            if isChromeProfile {
                // Browser chrome, groups and non-field controls keep no write
                // capability; only enabled raw text fields under the retained
                // page web area may advertise set_value.
                let underWebArea = webAreaRef.map { areaRef in
                    ancestors.contains(where: { $0.ref == areaRef })
                } ?? false
                let allowed = underWebArea
                    && ["AXTextField", "AXTextArea"].contains(role)
                    && (enabled.availableValue == true)
                    && !isSecureElement(element)
                    && capabilities.contains("set_value")
                capabilities = allowed ? ["set_value"] : []
            }
            // Chrome can expose an AXScrollArea in AXParent that AXChildren
            // omits. Preserve the visible child tree in Observation, while
            // retaining the actual native parent chain at observation time
            // for the same identity/name comparison in prepare and preflight.
            var guardAncestors = ancestors
            if isChromeProfile {
                if let nativeLineage = liveAncestry(for: element) {
                    guardAncestors = Array(nativeLineage.reversed())
                } else {
                    guardAncestors = []
                    capabilities = []
                    omitted.insert("error")
                }
            }
            let valueStatus: String = {
                switch value {
                case .available: return "available"
                case .unavailable: return "unavailable"
                case .unsupported: return "unsupported"
                case .redacted: return "redacted"
                case .error: return "error"
                }
            }()
            nodes.append(CapturedNode(ref: ref, parentRef: parentRef, role: normalizeRole(role),
                                      nativeRole: role, name: name.json({ $0 }),
                                      value: value.json({ $0 }), enabled: enabled.json({ $0 }),
                                      capabilities: capabilities,
                                      nameJSON: jsonString(name.json({ $0 })),
                                      enabledJSON: jsonString(enabled.json({ $0 })),
                                      valueStatus: valueStatus, ancestors: guardAncestors,
                                      actionId: readIdentifier(element),
                                      element: element))

            let (childError, raw) = copyAttribute(element, kAXChildrenAttribute)
            if childError == .success, let result = asElementArray(raw) {
                if result.hadInvalid { omitted.insert("error") }
                for child in result.elements { queue.append((child, ref, ancestors)) }
            } else if childError != .attributeUnsupported && childError != .noValue {
                omitted.insert("error")
            }
        }
        if index < queue.count { omitted.insert("budget") }
        return (nodes, omitted)
    }

    /// Captures the granted window and, when a modal sheet is present, the sheet
    /// subtree attached beneath the window ref. `rootRef` stays the granted
    /// window ref so ancestor context remains intact.
    func captureIncludingModal(rootRef: String, maxNodes: Int) -> (nodes: [CapturedNode], omitted: Set<String>) {
        var (nodes, omitted) = capture(root: window, rootRef: rootRef, maxNodes: maxNodes)
        guard let sheet = modalSheet() else { return (nodes, omitted) }
        let remaining = max(0, maxNodes - nodes.count)
        guard remaining > 0 else {
            omitted.insert("budget")
            return (nodes, omitted)
        }
        let sheetRootRef = registry.ref(for: sheet)
        var (sheetNodes, sheetOmitted) = capture(root: sheet, rootRef: sheetRootRef, maxNodes: remaining)
        omitted.formUnion(sheetOmitted)
        guard let windowNode = nodes.first(where: { $0.ref == rootRef }), !sheetNodes.isEmpty else {
            return (nodes, omitted)
        }
        for index in sheetNodes.indices {
            sheetNodes[index].ancestors = windowNode.ancestors + sheetNodes[index].ancestors
        }
        sheetNodes[0].parentRef = rootRef
        for node in sheetNodes where !nodes.contains(where: { $0.ref == node.ref }) {
            nodes.append(node)
        }
        return (nodes, omitted)
    }

    // MARK: Observer

    private func startObserver() {
        guard let started = startEventObserver(pid: pid, app: app, counter: counter) else { return }
        observer = started.observer
        observerThread = started.thread
    }
}

/// Counts app-level AX notifications on a dedicated run-loop thread. The
/// counter must outlive the observer; both targets keep it for their lifetime.
/// Notifications are hints only: a zero count is never proof of no change.
func startEventObserver(pid: pid_t, app: AXUIElement,
                        counter: EventCounter) -> (observer: AXObserver, thread: Thread)? {
    var created: AXObserver?
    let refcon = Unmanaged.passUnretained(counter).toOpaque()
    let error = AXObserverCreate(pid, { _, _, _, refcon in
        guard let refcon else { return }
        Unmanaged<EventCounter>.fromOpaque(refcon).takeUnretainedValue().bump()
    }, &created)
    guard error == .success, let observer = created else {
        FileHandle.standardError.write(Data("AriadneHost: AXObserver unavailable; event counters disabled\n".utf8))
        return nil
    }
    let notifications = ["AXValueChanged", "AXUIElementDestroyed", "AXFocusedUIElementChanged",
                         "AXWindowCreated", "AXLayoutChanged"]
    var failures = 0
    for notification in notifications {
        if AXObserverAddNotification(observer, app, notification as CFString, refcon) != .success {
            failures += 1
        }
    }
    if failures > 0 {
        FileHandle.standardError.write(Data("AriadneHost: \(failures) AX notification(s) unsupported\n".utf8))
    }
    let thread = Thread {
        let runLoop = CFRunLoopGetCurrent()
        CFRunLoopAddSource(runLoop, AXObserverGetRunLoopSource(observer), .defaultMode)
        // A cancelled/expired open can drop its local target after observer
        // creation. The callback refcon must remain valid until this loop ends.
        withExtendedLifetime(counter) { CFRunLoopRun() }
    }
    thread.name = "ariadne.host.axobserver"
    thread.start()
    return (observer, thread)
}

/// Free-function indirection avoids a name clash with the `isValueSettable`
/// method of the same name inside the class.
private func AriadneHost_isValueSettable(_ element: AXUIElement) -> Bool { isValueSettable(element) }
