import Foundation

// MARK: - Error taxonomy

/// Host error codes mirror `HostError.code` in src/contracts.ts.
enum HostErrorCode: String {
    case scopeDenied = "scope_denied"
    case invalidRequest = "invalid_request"
    case staleSession = "stale_session"
    case staleBinding = "stale_binding"
    case unsupported
    case cancelled
    case outcomeUnknown = "outcome_unknown"
    case journalError = "journal_error"
    case closed
}

struct HostError: Error {
    let code: HostErrorCode
    let message: String
    init(_ code: HostErrorCode, _ message: String) {
        self.code = code
        self.message = message
    }
}

/// JSON shape failures are reported as JSON-RPC -32602 without echoing input.
enum ShapeFailure: Error {
    case malformed
    case shape(String)
}

enum RPCCode: Int {
    case parseError = -32700
    case invalidRequest = -32600
    case methodNotFound = -32601
    case invalidParams = -32602
    case internalError = -32603
    case host = -32000
}

// MARK: - Strict JSON reading

func parseJSONTop(_ data: Data) throws -> Any {
    do {
        return try JSONSerialization.jsonObject(with: data, options: [])
    } catch {
        throw ShapeFailure.malformed
    }
}

/// Converts an arbitrary JSON scalar to Int only when it is a true integer.
/// Floats and booleans are rejected so "1.0" is not silently accepted as 1.
func asInt(_ value: Any?) -> Int? {
    guard let value else { return nil }
    guard let number = value as? NSNumber else { return nil }
    if CFGetTypeID(number) == CFBooleanGetTypeID() { return nil }
    let objCType = String(cString: number.objCType)
    if objCType == "d" || objCType == "f" { return nil }
    let double = number.doubleValue
    guard double.isFinite, double.rounded() == double,
          double >= -9_007_199_254_740_992, double <= 9_007_199_254_740_992 else { return nil }
    return Int(double)
}

/// A checked JSON object. Every accessor validates presence and type, so a
/// missing field is never treated as empty and extra fields can be rejected.
struct JSONObject {
    let raw: [String: Any]

    init(_ any: Any) throws {
        guard let dict = any as? [String: Any] else { throw ShapeFailure.shape("expected object") }
        self.raw = dict
    }

    func requireOnly(_ allowed: Set<String>) throws {
        for key in raw.keys where !allowed.contains(key) {
            throw ShapeFailure.shape("unexpected field")
        }
    }

    func require(_ keys: [String]) throws {
        for key in keys where raw[key] == nil {
            throw ShapeFailure.shape("missing field")
        }
    }

    func has(_ key: String) -> Bool { raw[key] != nil && !(raw[key] is NSNull) }

    func string(_ key: String) throws -> String {
        guard let value = raw[key] as? String else { throw ShapeFailure.shape("expected string") }
        return value
    }

    func bool(_ key: String) throws -> Bool {
        // A JSON boolean must be a CFBoolean. A numeric 0/1 is not a boolean.
        guard let value = raw[key] as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else {
            throw ShapeFailure.shape("expected bool")
        }
        return value.boolValue
    }

    func int(_ key: String) throws -> Int {
        guard let value = asInt(raw[key]) else { throw ShapeFailure.shape("expected integer") }
        return value
    }

    func object(_ key: String) throws -> JSONObject {
        guard let value = raw[key] else { throw ShapeFailure.shape("missing field") }
        return try JSONObject(value)
    }

    func array(_ key: String) throws -> [Any] {
        guard let value = raw[key] as? [Any] else { throw ShapeFailure.shape("expected array") }
        return value
    }

    func stringArray(_ key: String) throws -> [String] {
        try array(key).map {
            guard let value = $0 as? String else { throw ShapeFailure.shape("expected string array") }
            return value
        }
    }
}

/// Identifier grammar shared by the JSON contracts. Matches the schema ASCII
/// grammar exactly: `^[A-Za-z0-9][A-Za-z0-9_.:-]*$`, 1..128 characters.
func isValidId(_ value: String) -> Bool {
    let scalars = Array(value.unicodeScalars)
    guard (1...128).contains(scalars.count) else { return false }
    func isASCIIAlphanumeric(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 48...57, 65...90, 97...122: return true
        default: return false
        }
    }
    func isAllowedBody(_ scalar: Unicode.Scalar) -> Bool {
        isASCIIAlphanumeric(scalar) || scalar == "_" || scalar == "." || scalar == ":" || scalar == "-"
    }
    guard let first = scalars.first, isASCIIAlphanumeric(first) else { return false }
    return scalars.dropFirst().allSatisfy(isAllowedBody)
}

func jsonData(_ object: [String: Any]) -> Data {
    (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
}

func jsonString(_ object: [String: Any]) -> String {
    String(data: jsonData(object), encoding: .utf8) ?? "{}"
}

// MARK: - Control generation

/// Cancellation/close state lives behind its own lock so a control reader can
/// bump the generation while AX work is still pending on the serial worker.
final class ControlState {
    private let lock = NSLock()
    private var generationValue = 0
    private var cancelled = false
    private var closed = false

    func snapshot() -> (generation: Int, cancelled: Bool, closed: Bool) {
        lock.lock(); defer { lock.unlock() }
        return (generationValue, cancelled, closed)
    }

    var generation: Int { snapshot().generation }
    var isCancelled: Bool { snapshot().cancelled }
    var isClosed: Bool { snapshot().closed }

    @discardableResult
    func bump() -> Int {
        lock.lock(); defer { lock.unlock() }
        generationValue += 1
        return generationValue
    }

    func cancel() {
        lock.lock(); defer { lock.unlock() }
        cancelled = true
        generationValue += 1
    }

    /// A new explicit session makes the control generation move and clears cancel.
    @discardableResult
    func reopen(expectedGeneration: Int) throws -> Int {
        lock.lock(); defer { lock.unlock() }
        guard generationValue == expectedGeneration else { throw HostError(.cancelled, "open request predates cancellation") }
        cancelled = false
        generationValue += 1
        return generationValue
    }

    func close() {
        lock.lock(); defer { lock.unlock() }
        closed = true
        cancelled = true
        generationValue += 1
    }
}

// MARK: - Serialized stdout

final class LineWriter {
    private let lock = NSLock()
    private let handle = FileHandle.standardOutput

    func send(result: Any, id: Any) {
        write(["jsonrpc": "2.0", "id": id, "result": result])
    }

    func send(error code: Int, message: String, id: Any, hostCode: HostErrorCode? = nil) {
        var errorObject: [String: Any] = ["code": code, "message": message]
        if let hostCode { errorObject["data"] = ["code": hostCode.rawValue] }
        write(["jsonrpc": "2.0", "id": id, "error": errorObject])
    }

    func write(_ object: [String: Any]) {
        let data = jsonData(object)
        lock.lock(); defer { lock.unlock() }
        handle.write(data)
        handle.write(Data([0x0A]))
    }
}

// MARK: - Serial worker

/// A tiny serial queue so every non-control dispatch runs one at a time without
/// relying on Foundation DispatchQueue capture rules. `drainAndStop` waits for
/// queued work to finish so EOF does not drop pending replies.
final class SerialWorker {
    private let condition = NSCondition()
    private var pending: [() -> Void] = []
    private var stopping = false
    private var busy = false
    private var thread: Thread?
    private var started = false
    /// Bounds queued work so a blocked worker cannot grow memory without limit.
    private let maxPending = 256

    func start() {
        condition.lock()
        if started { condition.unlock(); return }
        started = true
        condition.unlock()
        let thread = Thread { [weak self] in self?.loop() }
        thread.name = "ariadne.host.worker"
        self.thread = thread
        thread.start()
    }

    func enqueue(_ work: @escaping () -> Void) -> Bool {
        condition.lock(); defer { condition.unlock() }
        if pending.count >= maxPending { return false }
        pending.append(work)
        condition.broadcast()
        return true
    }

    /// Stops accepting work and blocks until the queue is empty.
    func drainAndStop() {
        condition.lock()
        stopping = true
        condition.broadcast()
        while !pending.isEmpty || busy {
            condition.wait()
        }
        condition.unlock()
    }

    private func loop() {
        while true {
            condition.lock()
            while pending.isEmpty && !stopping { condition.wait() }
            if pending.isEmpty {
                busy = false
                condition.broadcast()
                condition.unlock()
                return
            }
            let work = pending.removeFirst()
            busy = true
            condition.unlock()

            work()

            condition.lock()
            busy = false
            condition.broadcast()
            condition.unlock()
        }
    }
}
