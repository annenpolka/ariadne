import Darwin
import Foundation

/// Strict, versioned JSONL journal.
///
/// The file descriptor is held open for the process lifetime and guarded with
/// `flock`, so a second host cannot share a journal and a crash releases the
/// lock naturally. Only metadata is stored: task digests, cumulative operation
/// counts and operation receipts. Input strings never reach the journal.
///
/// Durability is fail-closed: any uncertain write or sync marks the journal
/// unusable and every later mutation throws `journal_error`, so no AX side
/// effect can follow an unconfirmed intent.
final class Journal {
    struct TaskRecord {
        var digest: String
        var deadlineWallMs: Int
        var lastWallMs: Int
        var operations: Int
    }

    struct OperationRecord {
        var taskId: String
        var taskRevision: Int
        var scopeRef: String
        var requestDigest: String
        var receipt: [String: Any]
    }

    struct State {
        var epoch: String?
        var tasks: [String: TaskRecord] = [:]
        var operations: [String: OperationRecord] = [:]
    }

    private let fd: Int32
    private let lock = NSLock()
    /// The last state that is known durable on disk. Never mutated before a
    /// successful append and sync.
    private var durableState = State()
    private var sequence = 0
    private var unusable = false
    let path: String

    static func taskKey(_ taskId: String, _ revision: Int) -> String { "\(taskId)#\(revision)" }

    init(path: String) throws {
        self.path = path
        let directory = (path as NSString).deletingLastPathComponent
        let resolvedDirectory = directory.isEmpty ? "." : directory
        do {
            try FileManager.default.createDirectory(atPath: resolvedDirectory, withIntermediateDirectories: true)
        } catch {
            throw HostError(.journalError, "cannot create journal directory")
        }
        let created = !FileManager.default.fileExists(atPath: path)
        let handle = open(path, O_CREAT | O_RDWR | O_APPEND | O_NOFOLLOW, 0o600)
        guard handle >= 0 else { throw HostError(.journalError, "cannot open journal") }
        if flock(handle, LOCK_EX | LOCK_NB) != 0 {
            close(handle)
            throw HostError(.journalError, "journal is locked by another host")
        }
        self.fd = handle
        do {
            try load()
            if created {
                try fsyncFile()
                try fsyncDirectory(resolvedDirectory)
            }
        } catch {
            close(handle)
            throw error
        }
    }

    deinit { close(fd) }

    // MARK: Reading

    private func readAll() throws -> Data {
        lseek(fd, 0, SEEK_SET)
        var data = Data()
        let limit = 16 * 1024 * 1024
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = buffer.withUnsafeMutableBytes { pointer in
                read(fd, pointer.baseAddress, pointer.count)
            }
            if count < 0 {
                if errno == EINTR { continue }
                throw HostError(.journalError, "journal read failed")
            }
            if count == 0 { break }
            data.append(contentsOf: buffer[0..<count])
            if data.count > limit { throw HostError(.journalError, "journal is oversized") }
        }
        return data
    }

    private func load() throws {
        let data = try readAll()
        if data.isEmpty { durableState = State(); return }
        guard data.last == 0x0A else { throw HostError(.journalError, "journal is truncated") }
        var lines = data.split(separator: 0x0A, omittingEmptySubsequences: false)
        // The final newline produces exactly one trailing empty element.
        guard lines.last?.isEmpty == true else { throw HostError(.journalError, "journal is malformed") }
        lines.removeLast()
        var next = State()
        var expected = 0
        for line in lines {
            if line.allSatisfy({ $0 == 0x20 || $0 == 0x09 || $0 == 0x0D }) {
                throw HostError(.journalError, "blank journal record")
            }
            guard let any = try? JSONSerialization.jsonObject(with: Data(line), options: []),
                  let object = any as? [String: Any] else {
                throw HostError(.journalError, "malformed journal record")
            }
            expected += 1
            guard asInt(object["version"]) == 1, asInt(object["sequence"]) == expected,
                  asInt(object["sequence"]) != nil, (asInt(object["sequence"]) ?? -1) >= 1 else {
                throw HostError(.journalError, "unsupported journal version or sequence")
            }
            var event = object
            event.removeValue(forKey: "version")
            event.removeValue(forKey: "sequence")
            try apply(event, to: &next)
            sequence = expected
        }
        durableState = next
    }

    private func isHexDigest(_ value: Any?) -> Bool {
        guard let text = value as? String, text.count == 64 else { return false }
        return text.allSatisfy { ($0 >= "0" && $0 <= "9") || ($0 >= "a" && $0 <= "f") }
    }

    private func apply(_ event: [String: Any], to next: inout State) throws {
        guard let type = event["type"] as? String else { throw HostError(.journalError, "invalid journal record") }
        func fail() -> HostError { HostError(.journalError, "invalid journal record or transition") }
        func rejectExtras(_ allowed: Set<String>) throws {
            for key in event.keys where !allowed.contains(key) { throw fail() }
        }
        switch type {
        case "boot":
            try rejectExtras(["type", "epoch"])
            guard let epoch = event["epoch"] as? String, isValidId(epoch) else { throw fail() }
            next.epoch = epoch
        case "task":
            try rejectExtras(["type", "taskId", "revision", "digest", "deadlineWallMs", "lastWallMs"])
            guard let taskId = event["taskId"] as? String, isValidId(taskId),
                  let revision = asInt(event["revision"]), revision >= 1,
                  isHexDigest(event["digest"]),
                  let digest = event["digest"] as? String,
                  let deadline = asInt(event["deadlineWallMs"]), deadline >= 0,
                  let lastWall = asInt(event["lastWallMs"]), lastWall >= 0 else { throw fail() }
            let key = Journal.taskKey(taskId, revision)
            if let prior = next.tasks[key] {
                guard prior.digest == digest, deadline <= prior.deadlineWallMs, lastWall >= prior.lastWallMs else {
                    throw fail()
                }
            }
            next.tasks[key] = TaskRecord(digest: digest, deadlineWallMs: deadline,
                                         lastWallMs: lastWall, operations: next.tasks[key]?.operations ?? 0)
        case "intent":
            try rejectExtras(["type", "taskId", "taskRevision", "scopeRef", "operationId",
                              "requestDigest", "receipt"])
            guard let operationId = event["operationId"] as? String, isValidId(operationId),
                  let scopeRef = event["scopeRef"] as? String, isValidId(scopeRef),
                  isHexDigest(event["requestDigest"]),
                  let taskId = event["taskId"] as? String, isValidId(taskId),
                  let revision = asInt(event["taskRevision"]), revision >= 1,
                  let receipt = event["receipt"] as? [String: Any] else { throw fail() }
            let key = Journal.taskKey(taskId, revision)
            guard var task = next.tasks[key], next.operations[operationId] == nil else { throw fail() }
            try validateReceipt(receipt)
            guard receipt["operationId"] as? String == operationId,
                  receipt["status"] as? String == "dispatch_intent",
                  receipt["sessionEpoch"] as? String == next.epoch else { throw fail() }
            task.operations += 1
            next.tasks[key] = task
            next.operations[operationId] = OperationRecord(taskId: taskId, taskRevision: revision,
                                                            scopeRef: scopeRef,
                                                            requestDigest: event["requestDigest"] as! String,
                                                            receipt: receipt)
        case "receipt":
            try rejectExtras(["type", "operationId", "receipt"])
            guard let operationId = event["operationId"] as? String,
                  var operation = next.operations[operationId],
                  let receipt = event["receipt"] as? [String: Any] else { throw fail() }
            try validateReceipt(receipt)
            guard receipt["operationId"] as? String == operationId,
                  let receiptEpoch = receipt["sessionEpoch"] as? String,
                  let intentEpoch = operation.receipt["sessionEpoch"] as? String,
                  receiptEpoch == intentEpoch,
                  let previous = operation.receipt["status"] as? String,
                  let status = receipt["status"] as? String else { throw fail() }
            // No transition may clear an unknown outcome or rewrite an
            // attempted dispatch. Unknown stays unknown.
            let transitionAllowed: Bool
            switch (previous, status) {
            case ("dispatch_intent", "attempted"), ("dispatch_intent", "outcome_unknown"):
                transitionAllowed = true
            case ("outcome_unknown", "outcome_unknown"):
                transitionAllowed = true
            default:
                transitionAllowed = false
            }
            guard transitionAllowed else { throw fail() }
            operation.receipt = receipt
            next.operations[operationId] = operation
        default:
            throw fail()
        }
    }

    private func validateReceipt(_ receipt: [String: Any]) throws {
        let allowed: Set<String> = ["kind", "schemaVersion", "operationId", "sessionEpoch",
                                    "eventSeq", "status", "reason"]
        for key in receipt.keys where !allowed.contains(key) {
            throw HostError(.journalError, "invalid receipt record")
        }
        guard receipt["kind"] as? String == "host_receipt",
              receipt["schemaVersion"] as? String == "0.1",
              let operationId = receipt["operationId"] as? String, isValidId(operationId),
              let sessionEpoch = receipt["sessionEpoch"] as? String, isValidId(sessionEpoch),
              let eventSeq = asInt(receipt["eventSeq"]), eventSeq >= 0,
              let status = receipt["status"] as? String,
              ["prepared", "dispatch_intent", "attempted", "not_dispatched", "expired", "outcome_unknown"].contains(status),
              let reason = receipt["reason"] as? String,
              ["none", "precondition_changed", "scope_denied", "cancelled_before_dispatch", "host_lost",
               "driver_timeout", "driver_error", "journal_error", "expired"].contains(reason) else {
            throw HostError(.journalError, "invalid receipt record")
        }
    }

    // MARK: Writing

    func currentState() -> State {
        lock.lock(); defer { lock.unlock() }
        return durableState
    }

    /// Validates the event against a copy of the last durable state, then
    /// appends and fsyncs it. Any uncertainty marks the journal unusable.
    func append(_ event: [String: Any]) throws {
        lock.lock(); defer { lock.unlock() }
        guard !unusable else { throw HostError(.journalError, "journal is unusable after a failed sync") }
        var next = durableState
        // Validation errors propagate without poisoning the journal.
        try apply(event, to: &next)
        var record = event
        record["version"] = 1
        record["sequence"] = sequence + 1
        let payload = jsonData(record) + Data([0x0A])
        do {
            try writeAll(payload)
        } catch {
            // Any uncertain append or sync makes the journal permanently
            // unusable so no later mutation can continue.
            unusable = true
            if let hostError = error as? HostError, hostError.code == .journalError { throw hostError }
            throw HostError(.journalError, "journal append failed")
        }
        durableState = next
        sequence += 1
    }

    private func writeAll(_ data: Data) throws {
        var offset = 0
        try data.withUnsafeBytes { raw in
            while offset < raw.count {
                let written = write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if written < 0 {
                    if errno == EINTR { continue }
                    throw HostError(.journalError, "journal write failed")
                }
                // A zero-byte write is never treated as success.
                if written == 0 { throw HostError(.journalError, "journal write made no progress") }
                offset += written
            }
        }
        try fsyncFile()
    }

    private func fsyncFile() throws {
        if fcntl(fd, F_FULLFSYNC) == -1 {
            if fsync(fd) != 0 { throw HostError(.journalError, "journal sync failed") }
        }
    }

    private func fsyncDirectory(_ directory: String) throws {
        let dir = open(directory, O_RDONLY)
        guard dir >= 0 else { throw HostError(.journalError, "journal directory open failed") }
        defer { close(dir) }
        if fsync(dir) != 0 { throw HostError(.journalError, "journal directory sync failed") }
    }
}
