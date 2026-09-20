import AppKit
import ApplicationServices
import Foundation
import Darwin

/// Directly launched independent Chrome processes may have no AppKit launchDate.
/// Kernel process start time still supplies a PID-generation identity.
struct ProcessStart: Equatable {
    let seconds: UInt64
    let microseconds: UInt64

    static func read(_ pid: pid_t) -> ProcessStart? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
              info.pbi_start_tvsec > 0 else { return nil }
        return ProcessStart(seconds: info.pbi_start_tvsec, microseconds: info.pbi_start_tvusec)
    }
}

// MARK: - Generic URL policy

/// Generic URL rules shared by startup and grant policy. Nothing here knows a
/// site: an https origin is scheme + lowercased ASCII DNS host + non-default
/// port, and plain http is limited to the 127.0.0.1 loopback. Query and
/// fragment are legal and stay part of the raw full-URL identity; only the
/// origin is derived. Ambiguous spellings are rejected, never rewritten.
enum BrowserURL {
    static let maxURLBytes = 8192

    /// The canonical origin of an accepted raw URL, or nil.
    static func origin(_ raw: String) -> String? {
        guard !raw.isEmpty, raw.utf8.count <= maxURLBytes else { return nil }
        for scalar in raw.unicodeScalars {
            if scalar == "\\" || scalar.value == 0xFEFF { return nil }
            if scalar.properties.isWhitespace || scalar.properties.generalCategory == .control { return nil }
        }
        let bytes = Array(raw.utf8)
        guard hasWellFormedEscapes(bytes) else { return nil }
        let secure: Bool
        let start: Int
        if bytes.starts(with: Array("https://".utf8)) {
            secure = true
            start = 8
        } else if bytes.starts(with: Array("http://".utf8)) {
            secure = false
            start = 7
        } else {
            return nil
        }
        var end = start
        while end < bytes.count, bytes[end] != 0x2F, bytes[end] != 0x3F, bytes[end] != 0x23 { end += 1 }
        let authority = bytes[start..<end]
        // "@" in the authority is userinfo; it is never accepted.
        guard !authority.isEmpty, !authority.contains(0x40) else { return nil }
        var hostBytes = authority
        var port: Int?
        if let colon = authority.lastIndex(of: 0x3A) {
            hostBytes = authority[authority.startIndex..<colon]
            let digits = authority[(colon + 1)...]
            // Decimal without leading zeros, so one port has one spelling.
            guard (1...5).contains(digits.count), digits.allSatisfy({ (0x30...0x39).contains($0) }),
                  digits.first != 0x30,
                  let value = Int(String(decoding: digits, as: UTF8.self)),
                  (1...65_535).contains(value) else { return nil }
            port = value
        }
        guard !hostBytes.isEmpty, hostBytes.allSatisfy(isHostByte) else { return nil }
        let host = String(decoding: hostBytes, as: UTF8.self).lowercased()
        if !secure, host != "127.0.0.1" { return nil }
        let defaultPort = secure ? 443 : 80
        let scheme = secure ? "https" : "http"
        if let port, port != defaultPort { return "\(scheme)://\(host):\(port)" }
        return "\(scheme)://\(host)"
    }

    /// Grant origins must already equal the canonical serialization: no
    /// trailing slash, uppercase host or spelled-out default port.
    static func isCanonicalOrigin(_ raw: String) -> Bool { origin(raw) == raw }

    private static func isHostByte(_ byte: UInt8) -> Bool {
        switch byte {
        case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x2D, 0x2E: return true
        default: return false
        }
    }

    private static func isHexByte(_ byte: UInt8) -> Bool {
        switch byte {
        case 0x30...0x39, 0x41...0x46, 0x61...0x66: return true
        default: return false
        }
    }

    private static func hasWellFormedEscapes(_ bytes: [UInt8]) -> Bool {
        var index = 0
        while index < bytes.count {
            if bytes[index] == 0x25 {
                guard index + 2 < bytes.count, isHexByte(bytes[index + 1]), isHexByte(bytes[index + 2]) else {
                    return false
                }
                index += 3
            } else {
                index += 1
            }
        }
        return true
    }
}

// MARK: - Bounded AX helpers

/// A monotonic budget for a run of AX calls. `arm` refuses once the budget is
/// spent and otherwise shortens the element's messaging timeout to the time
/// left (0.1–1.0 s). A single AX call can still overshoot by its timeout; this
/// is a pre/post check, not hard interruption.
struct AXClock {
    let endMonoMs: Int

    var remainingMs: Int { endMonoMs - monoNowMs() }

    func arm(_ element: AXUIElement) -> Bool {
        let left = remainingMs
        guard left > 0 else { return false }
        AXUIElementSetMessagingTimeout(element, Float(min(1.0, max(0.1, Double(left) / 1000.0))))
        return true
    }
}

/// Native-identity set. CFHash buckets keep duplicate detection cheap; CFEqual
/// decides identity.
struct ElementSet {
    private var buckets: [CFHashCode: [AXUIElement]] = [:]

    /// Returns false when the element was already present.
    mutating func insert(_ element: AXUIElement) -> Bool {
        let hash = CFHash(element)
        if buckets[hash]?.contains(where: { CFEqual($0, element) }) == true { return false }
        buckets[hash, default: []].append(element)
        return true
    }
}

enum ChildFetch {
    case leaf
    case failed
    /// `invalid` counts non-element members; `truncated` means the provider
    /// reported more children than were fetched.
    case children([AXUIElement], invalid: Int, truncated: Bool)
}

/// nil when the child count itself is unreadable.
func hasChildren(_ element: AXUIElement) -> Bool? {
    var count: CFIndex = 0
    switch AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count) {
    case .success: return count > 0
    case .attributeUnsupported, .noValue: return false
    default: return nil
    }
}

typealias ChildCountReader = (AXUIElement, CFString) -> (AXError, Int)
typealias ChildRangeReader = (AXUIElement, CFString, Int, Int) -> (AXError, CFArray?)
private func nativeChildCount(_ element: AXUIElement, _ attribute: CFString) -> (AXError, Int) {
    var count: CFIndex = 0
    let error = AXUIElementGetAttributeValueCount(element, attribute, &count)
    return (error, count)
}
private func nativeChildRange(_ element: AXUIElement, _ attribute: CFString, _ index: Int, _ count: Int) -> (AXError, CFArray?) {
    var values: CFArray?
    let error = AXUIElementCopyAttributeValues(element, attribute, index, count, &values)
    return (error, values)
}
/// Reads at most `limit` children in batches of at most 512. Injected readers
/// exercise short/empty provider responses without requiring desktop permissions.
func boundedChildren(of element: AXUIElement, limit: Int, clock: AXClock,
                     countReader: ChildCountReader = nativeChildCount,
                     rangeReader: ChildRangeReader = nativeChildRange) -> ChildFetch {
    guard clock.arm(element) else { return .children([], invalid: 0, truncated: true) }
    let attribute = kAXChildrenAttribute as CFString
    let (countError, count) = countReader(element, attribute)
    switch countError {
    case .success: break
    case .attributeUnsupported, .noValue: return .leaf
    default: return .failed
    }
    guard count > 0 else { return .leaf }
    let wanted = min(count, max(0, limit))
    var truncated = count > wanted
    var elements: [AXUIElement] = []
    var invalid = 0
    var index = 0
    while index < wanted {
        guard clock.arm(element) else {
            truncated = true
            break
        }
        // Large sibling lists make repeated cross-process range reads expensive.
        // Keep each call bounded while amortizing the per-call AX/provider cost.
        let chunk = min(512, wanted - index)
        let (error, rawValues) = rangeReader(element, attribute, index, chunk)
        guard error == .success, let values = rawValues, let part = asElementArray(values) else {
            // Some providers lack the ranged call. A plain read is acceptable
            // only when the reported count is small, so it stays bounded.
            let rangedUnsupported: [AXError] = [.attributeUnsupported, .parameterizedAttributeUnsupported,
                                                .notImplemented, .illegalArgument, .failure]
            guard index == 0, count <= 512, rangedUnsupported.contains(error) else { return .failed }
            guard clock.arm(element) else { return .children([], invalid: 0, truncated: true) }
            let (plainError, raw) = copyAttribute(element, kAXChildrenAttribute)
            guard plainError == .success, let all = asElementArray(raw) else { return .failed }
            let kept = Array(all.elements.prefix(wanted))
            return .children(kept, invalid: all.hadInvalid ? 1 : 0,
                             truncated: truncated || all.elements.count > kept.count)
        }
        let fetched = CFArrayGetCount(values)
        guard fetched <= chunk else { return .failed }
        if fetched == 0 { truncated = true; break }
        elements.append(contentsOf: part.elements)
        invalid += fetched - part.elements.count
        index += fetched
    }
    return .children(elements, invalid: invalid, truncated: truncated)
}

// MARK: - Per-document ref registry

/// Opaque node refs of one document generation. The registry is dropped with
/// its document, so a ref can never outlive a refresh or a detected drift.
final class DocumentRefs {
    private var byRef: [String: AXUIElement] = [:]
    private var buckets: [CFHashCode: [(ref: String, element: AXUIElement)]] = [:]

    var count: Int { byRef.count }

    func ref(for element: AXUIElement, preferred: String? = nil) -> String {
        let hash = CFHash(element)
        if let existing = buckets[hash]?.first(where: { CFEqual($0.element, element) }) { return existing.ref }
        let ref = preferred ?? ("r-" + UUID().uuidString)
        byRef[ref] = element
        buckets[hash, default: []].append((ref, element))
        return ref
    }

    func element(for ref: String) -> AXUIElement? { byRef[ref] }

    func remove(_ ref: String) {
        guard let element = byRef.removeValue(forKey: ref) else { return }
        buckets[CFHash(element)]?.removeAll(where: { $0.ref == ref })
    }

    /// Forgets everything except the listed refs, which keep their tokens.
    func compact(keeping refs: [String]) {
        let kept = refs.compactMap { ref in byRef[ref].map { (ref, $0) } }
        byRef.removeAll()
        buckets.removeAll()
        for (ref, element) in kept { _ = self.ref(for: element, preferred: ref) }
    }
}

// MARK: - Read-only browser target

/// The generic read target: one Chrome process, one retained window and the
/// currently selected top-level web area. It is separate from the mutation
/// `AXTarget` and has no way to set a value or perform an action.
///
/// The selected document is sampled before and after every capture (app
/// identity, retained window, exact raw URL, top-level web area identity). A
/// detected change drops the document and all refs; only an explicit refresh
/// selects a new page. Sampling cannot rule out a navigation that returned to
/// the same URL and element between two samples.
final class BrowserReadTarget {
    struct Document {
        let ref: String
        let generation: Int
        let webArea: AXUIElement
        let url: String
        let rootRef: String
        let refs: DocumentRefs
    }

    struct Capture {
        var nodes: [[String: Any]]
        var rootRef: String
        var omitted: Set<String>
    }

    private static let discoveryBudgetMs = 2_000
    private static let maxAttributeUnits = 65_536
    private static let maxRegisteredRefs = BrowserReadBudget.maxNodes.upperBound * 4

    let pid: pid_t
    let app: AXUIElement
    let window: AXUIElement
    let executablePath: String
    let processStart: ProcessStart
    let allowedOrigins: Set<String>
    let counter = EventCounter()

    private var generation = 0
    private var document: Document?
    private var observer: AXObserver?
    private var observerThread: Thread?

    private init(pid: pid_t, app: AXUIElement, window: AXUIElement, executablePath: String,
                 processStart: ProcessStart, allowedOrigins: Set<String>) {
        self.pid = pid
        self.app = app
        self.window = window
        self.executablePath = executablePath
        self.processStart = processStart
        self.allowedOrigins = allowedOrigins
    }

    /// Pins the operator's exact window title and raw page URL. The title only
    /// selects the window once; afterwards the retained native window is the
    /// identity and its title may change.
    static func resolve(pid: pid_t, windowTitle: String, pageURL: String,
                        allowedOrigins: [String]) throws -> BrowserReadTarget {
        guard pid > 0 else { throw HostError(.invalidRequest, "pid must be positive") }
        guard AXIsProcessTrusted() else { throw HostError(.scopeDenied, "accessibility permission missing") }
        guard let origin = BrowserURL.origin(pageURL), allowedOrigins.contains(origin) else {
            throw HostError(.scopeDenied, "page origin is not granted")
        }
        guard let running = NSRunningApplication(processIdentifier: pid), !running.isTerminated else {
            throw HostError(.scopeDenied, "target process is not running")
        }
        guard running.bundleIdentifier == AppProfile.chromeBundleId,
              let executable = running.executableURL,
              executable.path == "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
              let processStart = ProcessStart.read(pid) else {
            throw HostError(.unsupported, "target does not match the registered browser")
        }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 2.0)
        let matches = AXTarget.windows(of: app, matchingTitle: windowTitle)
        guard matches.count == 1, let window = matches.first else {
            throw HostError(.scopeDenied, "window title does not identify exactly one window")
        }
        let target = BrowserReadTarget(pid: pid, app: app, window: window,
                                       executablePath: executable.path, processStart: processStart,
                                       allowedOrigins: Set(allowedOrigins))
        try target.select(pinnedURL: pageURL)
        if let started = startEventObserver(pid: pid, app: app, counter: target.counter) {
            target.observer = started.observer
            target.observerThread = started.thread
        }
        return target
    }

    func stamp(sessionEpoch: String) -> DocumentStamp? {
        document.map { DocumentStamp(sessionEpoch: sessionEpoch, ref: $0.ref, generation: $0.generation) }
    }

    /// Drops the document and every ref issued under it.
    func invalidate() { document = nil }

    /// Re-selects the active top-level web area of the same retained window.
    /// Old refs are gone whether or not this succeeds.
    func refresh() throws { try select(pinnedURL: nil) }

    // MARK: Selection and identity

    private func select(pinnedURL: String?) throws {
        document = nil
        generation += 1
        try verifyApplication()
        try verifyWindowPresent()
        let clock = AXClock(endMonoMs: monoNowMs() + Self.discoveryBudgetMs)
        guard let area = Self.discoverTopLevelWebArea(in: window, clock: clock) else {
            throw HostError(.staleBinding, "no unique top-level web area in the retained window")
        }
        guard clock.arm(area), let raw = readURLAttribute(area, "AXURL") else {
            throw HostError(.staleBinding, "web area URL is unreadable")
        }
        if let pinnedURL, raw != pinnedURL {
            throw HostError(.staleBinding, "web area URL does not match the operator page")
        }
        guard let origin = BrowserURL.origin(raw), allowedOrigins.contains(origin) else {
            throw HostError(.scopeDenied, "page origin is not granted")
        }
        guard clock.arm(window), readURLAttribute(window, "AXDocument") == raw else {
            throw HostError(.staleBinding, "window document does not match the web area")
        }
        let refs = DocumentRefs()
        let rootRef = refs.ref(for: area)
        document = Document(ref: "d-" + UUID().uuidString, generation: generation,
                            webArea: area, url: raw, rootRef: rootRef, refs: refs)
    }

    private func verifyApplication() throws {
        guard let running = NSRunningApplication(processIdentifier: pid), !running.isTerminated else {
            throw HostError(.scopeDenied, "target process is not running")
        }
        guard ProcessStart.read(pid) == processStart,
              running.bundleIdentifier == AppProfile.chromeBundleId,
              running.executableURL?.path == executablePath else {
            throw HostError(.staleBinding, "target process was replaced")
        }
    }

    private func verifyWindowPresent(clock: AXClock? = nil) throws {
        if let clock {
            guard clock.arm(app) else { throw HostError(.scopeDenied, "identity budget exhausted") }
        } else { AXUIElementSetMessagingTimeout(app, 2.0) }
        let (error, raw) = copyAttribute(app, kAXWindowsAttribute)
        guard error == .success, let windows = asElementArray(raw),
              windows.elements.contains(where: { CFEqual($0, window) }) else {
            throw HostError(.staleBinding, "retained window is gone")
        }
    }

    /// One identity sample: same process, same retained window, exact raw URL
    /// on window and web area, and the same single top-level web area.
    private func verify(_ current: Document, clock: AXClock) throws {
        try verifyApplication()
        try verifyWindowPresent(clock: clock)
        guard clock.arm(window), readURLAttribute(window, "AXDocument") == current.url,
              let area = Self.discoverTopLevelWebArea(in: window, clock: clock),
              CFEqual(area, current.webArea),
              clock.arm(area), readURLAttribute(area, "AXURL") == current.url else {
            throw HostError(.staleBinding, "page web area or URL changed")
        }
    }

    /// Bounded walk of the browser's own (non-content) window structure. It
    /// stops descending at every web area, so page size cannot break discovery,
    /// and requires exactly one. Anything unreadable or truncated fails closed.
    /// Frames nested inside a web area are not discovered by this pass.
    static func discoverTopLevelWebArea(in window: AXUIElement, clock: AXClock,
                                        maxNodes: Int = 512, maxDepth: Int = 32) -> AXUIElement? {
        var found: AXUIElement?
        var visited = ElementSet()
        var visitedCount = 0
        var queue: [(element: AXUIElement, depth: Int)] = [(window, 0)]
        var index = 0
        while index < queue.count {
            let (element, depth) = queue[index]
            index += 1
            guard clock.arm(element) else { return nil }
            guard visited.insert(element) else { continue }
            visitedCount += 1
            guard visitedCount <= maxNodes else { return nil }
            switch readString(element, kAXRoleAttribute) {
            case .available(let role) where role == "AXWebArea":
                guard found == nil else { return nil }
                found = element
                continue
            case .error:
                return nil
            default:
                break
            }
            guard depth < maxDepth else {
                if hasChildren(element) != false { return nil }
                continue
            }
            let allowance = maxNodes - visitedCount - (queue.count - index)
            switch boundedChildren(of: element, limit: allowance, clock: clock) {
            case .leaf:
                break
            case .failed:
                return nil
            case .children(let elements, let invalid, let truncated):
                guard invalid == 0, !truncated else { return nil }
                for child in elements { queue.append((child, depth + 1)) }
            }
        }
        return found
    }

    /// True when the AXParent chain reaches the selected web area without
    /// passing through any other web area (a frame boundary).
    private func isInside(_ current: Document, _ element: AXUIElement, clock: AXClock) -> Bool {
        var node = element
        var seen = ElementSet()
        // Include the web-area node itself after the deepest admitted descendant.
        for _ in 0...BrowserReadBudget.maxDepth.upperBound {
            if CFEqual(node, current.webArea) { return true }
            if CFEqual(node, window) { return false }
            guard seen.insert(node), clock.arm(node),
                  let role = readString(node, kAXRoleAttribute).availableValue, role != "AXWebArea" else {
                return false
            }
            let (error, raw) = copyAttribute(node, kAXParentAttribute)
            guard error == .success, let parent = asElement(raw) else { return false }
            node = parent
        }
        return false
    }

    // MARK: Capture

    /// Captures the selected document, or a previously captured region of it,
    /// within the given budgets. `overheadBytes` is the serialized size of the
    /// Observation without nodes, so the byte budget covers metadata too.
    func capture(stamp: DocumentStamp, rootRef: String?, limits: ReadLimits, overheadBytes: Int,
                 captureBudgetMs: Int, shouldStop: () -> Bool) throws -> Capture {
        // One capture clock includes identity/region checks. Reserve a slice for
        // the final identity sample so timed traversal can return a safe partial.
        let clock = AXClock(endMonoMs: monoNowMs() + captureBudgetMs)
        guard let current = document, current.ref == stamp.ref, current.generation == stamp.generation else {
            throw HostError(.staleBinding, "document stamp is not current")
        }
        do {
            try verify(current, clock: clock)
        } catch {
            invalidate()
            throw error
        }
        var root = current.webArea
        if let rootRef, rootRef != current.rootRef {
            guard let element = current.refs.element(for: rootRef) else {
                throw HostError(.staleBinding, "root ref is not from this document generation")
            }
            guard isInside(current, element, clock: clock) else {
                current.refs.remove(rootRef)
                throw HostError(.staleBinding, "root ref is no longer inside the document")
            }
            root = element
        }
        // Keep the registry bounded across many captures. Refs dropped here
        // fail later as stale_binding rather than resolving to anything else.
        if current.refs.count + limits.maxNodes > Self.maxRegisteredRefs {
            current.refs.compact(keeping: [current.rootRef, rootRef].compactMap { $0 })
        }
        if shouldStop() { throw HostError(.cancelled, "capture cancelled") }

        let contentClock = AXClock(endMonoMs: clock.endMonoMs - min(100, max(10, captureBudgetMs / 4)))
        let result = try traverse(root: root, in: current, limits: limits, overheadBytes: overheadBytes,
                                  clock: contentClock, shouldStop: shouldStop)
        do {
            try verify(current, clock: clock)
            guard clock.remainingMs >= 0 else { throw HostError(.scopeDenied, "capture budget exhausted") }
        } catch {
            invalidate()
            throw error
        }
        return result
    }

    private func traverse(root: AXUIElement, in current: Document, limits: ReadLimits, overheadBytes: Int,
                          clock: AXClock, shouldStop: () -> Bool) throws -> Capture {
        var nodes: [[String: Any]] = []
        var omitted = Set<String>()
        var visited = ElementSet()
        var queue: [(element: AXUIElement, parentRef: String?, depth: Int)] = [(root, nil, 0)]
        var index = 0
        // Every dequeued or invalid member is an attempt, so duplicates,
        // skipped frames and unreadable members cannot evade the budgets.
        var attempts = 0
        let maxAttempts = limits.maxNodes * 2 + 64
        var usedBytes = overheadBytes
        var rootRef = ""

        while index < queue.count {
            if shouldStop() { throw HostError(.cancelled, "capture cancelled") }
            let (element, parentRef, depth) = queue[index]
            index += 1
            let isRoot = index == 1
            attempts += 1
            if nodes.count >= limits.maxNodes || attempts > maxAttempts {
                omitted.insert("budget")
                break
            }
            guard clock.arm(element) else {
                if isRoot { throw HostError(.scopeDenied, "capture time ended before a safe root was read") }
                omitted.insert("budget")
                break
            }
            guard visited.insert(element) else { continue }

            // Role is the only attribute read before the frame decision.
            guard var nativeRole = readString(element, kAXRoleAttribute).availableValue else {
                if isRoot {
                    if clock.remainingMs <= 0 {
                        throw HostError(.scopeDenied, "capture time ended before a safe root was read")
                    }
                    throw HostError(.staleBinding, "capture root is unreadable")
                }
                // Cannot tell a frame from content: skip the whole subtree.
                omitted.insert("error")
                continue
            }
            if isRoot {
                guard (nativeRole == "AXWebArea") == CFEqual(element, current.webArea) else {
                    throw HostError(.staleBinding, "capture root changed role")
                }
            } else if nativeRole == "AXWebArea" {
                // Nested frame: name, value, URL and children stay unread.
                omitted.insert("frame")
                continue
            }
            if nativeRole.isEmpty || nativeRole.utf16.count > 256 {
                nativeRole = "unknown"
                omitted.insert("error")
            }

            var attributes = readAttributes(element, nativeRole: nativeRole, clock: clock)
            guard attributes.complete || isRoot else {
                omitted.insert("budget")
                break
            }
            if !attributes.complete { omitted.insert("budget") }

            let ref = current.refs.ref(for: element)
            if isRoot { rootRef = ref }
            func nodeJSON() -> [String: Any] {
                ["ref": ref, "parentRef": parentRef ?? NSNull(), "role": normalizeRole(nativeRole),
                 "nativeRole": nativeRole, "name": attributes.name.json({ $0 }),
                 "value": attributes.value.json({ $0 }), "enabled": attributes.enabled.json({ $0 }),
                 "capabilities": [String]()]
            }
            // At the byte limit, redact the large attributes before giving up
            // the node. The root is always kept.
            var node = nodeJSON()
            var size = jsonData(node).count + 1
            if usedBytes + size > limits.maxBytes, attributes.value.availableValue != nil {
                attributes.value = .redacted
                node = nodeJSON()
                size = jsonData(node).count + 1
            }
            if usedBytes + size > limits.maxBytes, attributes.name.availableValue != nil {
                attributes.name = .redacted
                node = nodeJSON()
                size = jsonData(node).count + 1
            }
            if usedBytes + size > limits.maxBytes, !isRoot {
                omitted.insert("budget")
                break
            }
            for status in [attributes.name.statusName, attributes.value.statusName, attributes.enabled.statusName] {
                if status == "redacted" || status == "error" { omitted.insert(status) }
            }
            usedBytes += size
            nodes.append(node)

            if depth >= limits.maxDepth {
                guard clock.arm(element) else {
                    omitted.insert("budget")
                    break
                }
                switch hasChildren(element) {
                case .some(true): omitted.insert("budget")
                case .some(false): break
                case .none: omitted.insert("error")
                }
                continue
            }
            let allowance = maxAttempts - attempts - (queue.count - index)
            switch boundedChildren(of: element, limit: allowance, clock: clock) {
            case .leaf:
                break
            case .failed:
                omitted.insert("error")
            case .children(let elements, let invalid, let truncated):
                if invalid > 0 {
                    omitted.insert("error")
                    attempts += invalid
                }
                if truncated { omitted.insert("budget") }
                for child in elements { queue.append((child, ref, depth + 1)) }
            }
        }
        if index < queue.count { omitted.insert("budget") }
        guard !nodes.isEmpty else { throw HostError(.staleBinding, "capture root is unavailable") }
        return Capture(nodes: nodes, rootRef: rootRef, omitted: omitted)
    }

    private struct NodeAttributes {
        var name: AttrValue<String> = .unavailable
        var value: AttrValue<String> = .unavailable
        var enabled: AttrValue<Bool> = .unavailable
        /// False when the time budget ended first; unread fields stay
        /// `unavailable` and are never invented.
        var complete = false
    }

    private func readAttributes(_ element: AXUIElement, nativeRole: String, clock: AXClock) -> NodeAttributes {
        var attributes = NodeAttributes()
        func bounded(_ value: AttrValue<String>) -> AttrValue<String> {
            if let text = value.availableValue, text.utf16.count > Self.maxAttributeUnits { return .redacted }
            return value
        }
        read: do {
            guard clock.arm(element) else { break read }
            let title = readString(element, kAXTitleAttribute)
            if let text = title.availableValue, !text.isEmpty {
                attributes.name = bounded(title)
            } else {
                guard clock.arm(element) else { break read }
                let description = readString(element, kAXDescriptionAttribute)
                if let text = description.availableValue, !text.isEmpty { attributes.name = bounded(description) }
                else if title.availableValue != nil { attributes.name = bounded(title) }
                else if description.availableValue != nil { attributes.name = bounded(description) }
                else if title.statusName == "error" || description.statusName == "error" { attributes.name = .error }
                else if title.statusName == "unsupported" && description.statusName == "unsupported" { attributes.name = .unsupported }
            }
            guard clock.arm(element) else { break read }
            // A password control is never read. An unreadable subrole cannot
            // rule one out, so the value is withheld as well.
            if nativeRole == "AXSecureTextField" {
                attributes.value = .redacted
            } else {
                switch readString(element, kAXSubroleAttribute) {
                case .available(let subrole) where subrole == "AXSecureTextField":
                    attributes.value = .redacted
                case .error:
                    attributes.value = .redacted
                default:
                    guard clock.arm(element) else { break read }
                    attributes.value = bounded(readString(element, kAXValueAttribute))
                }
            }
            guard clock.arm(element) else { break read }
            attributes.enabled = readBool(element, kAXEnabledAttribute)
            attributes.complete = true
        }
        return attributes
    }

    /// Mechanical evidence for the separately authorized action session. This
    /// object still exposes no mutation method and read captures stay capability-free.
    struct ActionGuard {
        let element: AXUIElement
        let stamp: DocumentStamp
        let node: [String: Any]
        let nodes: [String: [String: Any]]
        let kind: String
        let fingerprint: String
    }

    private func actionName(_ element: AXUIElement, clock: AXClock) -> AttrValue<String> {
        guard clock.arm(element) else { return .unavailable }
        let title = readString(element, kAXTitleAttribute)
        if let text = title.availableValue, !text.isEmpty { return text.utf16.count <= Self.maxAttributeUnits ? title : .redacted }
        guard clock.arm(element) else { return .unavailable }
        let description = readString(element, kAXDescriptionAttribute)
        if let text = description.availableValue, !text.isEmpty { return text.utf16.count <= Self.maxAttributeUnits ? description : .redacted }
        if title.availableValue != nil { return title }
        if description.availableValue != nil { return description }
        if title.statusName == "error" || description.statusName == "error" { return .error }
        return title.statusName == "unsupported" && description.statusName == "unsupported" ? .unsupported : .unavailable
    }

    func guardAction(stamp: DocumentStamp, node: [String: Any], nodes: [String: [String: Any]],
                     kind: String, policy: BrowserActionPolicy) throws -> ActionGuard {
        let clock = AXClock(endMonoMs: monoNowMs() + 3000)
        guard let current = document, current.ref == stamp.ref, current.generation == stamp.generation,
              let ref = node["ref"] as? String, let element = current.refs.element(for: ref) else {
            throw HostError(.staleBinding, "action reference expired")
        }
        do { try verify(current, clock: clock) } catch { invalidate(); throw error }
        guard isInside(current, element, clock: clock), clock.arm(app),
              let focusedWindow = asElement(copyAttribute(app, kAXFocusedWindowAttribute).1),
              CFEqual(focusedWindow, window) else { throw HostError(.staleBinding, "action is outside focused page") }
        // Native modal sheets belong to another surface. HTML dialogs remain in
        // the document and are fenced by the focused element plus observed lineage.
        if let sheets = asElementArray(copyAttribute(window, "AXSheets").1), !sheets.elements.isEmpty {
            throw HostError(.staleBinding, "native modal present")
        }
        guard let role = node["nativeRole"] as? String,
              (kind == "set_value" ? policy.setValueRoles : policy.invokeRoles).contains(role),
              !isSecureElement(element) else { throw HostError(.unsupported, "role is not an authorized action control") }
        let attrs = readAttributes(element, nativeRole: role, clock: clock)
        guard attrs.complete, attrs.enabled.availableValue == true, attrs.value.statusName != "redacted",
              NSDictionary(dictionary: attrs.name.json({ $0 })).isEqual(node["name"]),
              NSDictionary(dictionary: attrs.value.json({ $0 })).isEqual(node["value"]),
              NSDictionary(dictionary: attrs.enabled.json({ $0 })).isEqual(node["enabled"]) else {
            throw HostError(.staleBinding, "action attributes changed")
        }
        var lineage: [[String: Any]] = []
        var next = element
        var seen = ElementSet()
        for _ in 0...BrowserReadBudget.maxDepth.upperBound {
            guard seen.insert(next), clock.arm(next) else { throw HostError(.staleBinding, "incomplete action lineage") }
            let nextRef = current.refs.ref(for: next)
            guard let observed = nodes[nextRef], let nativeRole = readString(next, kAXRoleAttribute).availableValue,
                  nativeRole == observed["nativeRole"] as? String else { throw HostError(.staleBinding, "action lineage changed") }
            let liveName = actionName(next, clock: clock).json({ $0 })
            guard NSDictionary(dictionary: liveName).isEqual(observed["name"]) else { throw HostError(.staleBinding, "action lineage name changed") }
            lineage.append(["ref": nextRef, "role": nativeRole, "name": liveName])
            if CFEqual(next, current.webArea) { break }
            guard nativeRole != "AXWebArea", let parent = asElement(copyAttribute(next, kAXParentAttribute).1),
                  let expected = observed["parentRef"] as? String,
                  let parentElement = current.refs.element(for: expected), CFEqual(parent, parentElement) else {
                throw HostError(.staleBinding, "action parent changed")
            }
            next = parent
        }
        guard CFEqual(next, current.webArea), clock.remainingMs > 0 else { throw HostError(.staleBinding, "action lineage outside document") }
        if kind == "set_value" {
            var settable = DarwinBoolean(false)
            guard attrs.value.availableValue != nil,
                  AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success,
                  settable.boolValue else { throw HostError(.unsupported, "AXValue is not settable") }
        } else {
            var actions: CFArray?
            guard AXUIElementCopyActionNames(element, &actions) == .success,
                  (actions as? [String])?.contains(kAXPressAction) == true else { throw HostError(.unsupported, "AXPress is not available") }
        }
        guard clock.arm(app) else { throw HostError(.staleBinding, "focus budget exhausted") }
        let focused = asElement(copyAttribute(app, kAXFocusedUIElementAttribute).1)
        let fingerprint = digestJSON(["lineage": lineage, "focused": focused.map { current.refs.ref(for: $0) } ?? "none",
                                      "value": attrs.value.json({ $0 }), "enabled": attrs.enabled.json({ $0 })])
        return ActionGuard(element: element, stamp: stamp, node: node, nodes: nodes, kind: kind, fingerprint: fingerprint)
    }

    func validateAction(_ guardInfo: ActionGuard, policy: BrowserActionPolicy) throws {
        let live = try guardAction(stamp: guardInfo.stamp, node: guardInfo.node, nodes: guardInfo.nodes,
                                   kind: guardInfo.kind, policy: policy)
        guard CFEqual(live.element, guardInfo.element), live.fingerprint == guardInfo.fingerprint else {
            throw HostError(.staleBinding, "prepared action context changed")
        }
    }
}

extension AttrValue {
    var statusName: String {
        switch self {
        case .available: return "available"
        case .unavailable: return "unavailable"
        case .unsupported: return "unsupported"
        case .redacted: return "redacted"
        case .error: return "error"
        }
    }
}
