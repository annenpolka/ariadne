import Foundation
import Darwin

/// Line-oriented JSON-RPC 2.0 over stdio. stdout carries protocol frames only;
/// diagnostics go to stderr. Reads are bounded before and after newline.
final class Server {
    private static let maxLineBytes = 1024 * 1024
    private let host: Host
    private let writer = LineWriter()
    private let worker = SerialWorker()

    init(host: Host) { self.host = host }

    func run() {
        worker.start()
        var buffer = Data()
        var skippingOversizedLine = false
        var inputBytes = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            // FileHandle.read(upToCount:) can wait for the full count/EOF on a pipe.
            // POSIX read returns available bytes, keeping request/reply interactive.
            let count = inputBytes.withUnsafeMutableBytes { read(STDIN_FILENO, $0.baseAddress, $0.count) }
            if count < 0 { if errno == EINTR { continue }; break }
            if count == 0 { break }
            buffer.append(contentsOf: inputBytes[0..<count])
            while let newline = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<newline)
                buffer.removeSubrange(buffer.startIndex...newline)
                if skippingOversizedLine {
                    skippingOversizedLine = false
                    continue
                }
                if line.isEmpty { continue }
                // The limit applies to the complete frame, including one that
                // arrives together with its newline.
                if line.count > Server.maxLineBytes {
                    writer.send(error: RPCCode.invalidRequest.rawValue, message: "invalid request", id: NSNull())
                    continue
                }
                handleLine(line)
            }
            if !skippingOversizedLine && buffer.count > Server.maxLineBytes {
                writer.send(error: RPCCode.invalidRequest.rawValue, message: "invalid request", id: NSNull())
                buffer.removeAll(keepingCapacity: true)
                skippingOversizedLine = true
            }
        }
        worker.drainAndStop()
    }

    // MARK: Line handling

    private func handleLine(_ data: Data) {
        let parsed: Any
        do {
            parsed = try parseJSONTop(data)
        } catch {
            writer.send(error: RPCCode.parseError.rawValue, message: "parse error", id: NSNull())
            return
        }
        guard let object = parsed as? [String: Any] else {
            // Arrays are batch requests; the protocol does not implement them.
            writer.send(error: RPCCode.invalidRequest.rawValue, message: "invalid request", id: NSNull())
            return
        }
        let id: Any = object["id"] ?? NSNull()
        guard object["jsonrpc"] as? String == "2.0",
              let method = object["method"] as? String,
              (object["id"] as? String) != nil || asInt(object["id"]) != nil else {
            writer.send(error: RPCCode.invalidRequest.rawValue, message: "invalid request", id: id)
            return
        }
        for key in object.keys where !["jsonrpc", "id", "method", "params"].contains(key) {
            writer.send(error: RPCCode.invalidParams.rawValue, message: "invalid params", id: id)
            return
        }
        let params: JSONObject
        do {
            if let raw = object["params"] {
                params = try JSONObject(raw)
            } else {
                params = try JSONObject([String: Any]())
            }
        } catch {
            writer.send(error: RPCCode.invalidParams.rawValue, message: "invalid params", id: id)
            return
        }

        // Control methods run on the reader so they can bump the generation
        // while a serial AX dispatch is still pending.
        if method == "session.cancel" || method == "session.close" {
            handleControl(method: method, params: params, id: id)
            return
        }
        let admittedGeneration = host.control.generation
        let accepted = worker.enqueue { [weak self] in
            self?.handleOnWorker(method: method, params: params, id: id, admittedGeneration: admittedGeneration)
        }
        if !accepted {
            writer.send(error: RPCCode.invalidRequest.rawValue, message: "invalid request", id: id)
        }
    }

    private func handleControl(method: String, params: JSONObject, id: Any) {
        do {
            try params.requireOnly([])
            if method == "session.cancel" { host.cancel() } else { host.close() }
            writer.send(result: NSNull(), id: id)
        } catch {
            writer.send(error: RPCCode.invalidParams.rawValue, message: "invalid params", id: id)
        }
    }

    private func handleOnWorker(method: String, params: JSONObject, id: Any, admittedGeneration: Int) {
        do {
            switch method {
            case "host.hello":
                try params.requireOnly([])
                writer.send(result: host.hello(), id: id)
            case "session.open":
                try params.requireOnly(["task"])
                try params.require(["task"])
                let task = try params.object("task")
                writer.send(result: try host.openSession(task, admittedGeneration: admittedGeneration), id: id)
            case "session.openRead":
                try params.requireOnly(["spec"])
                try params.require(["spec"])
                let spec = try params.object("spec")
                writer.send(result: try host.openReadSession(spec, admittedGeneration: admittedGeneration), id: id)
            case "page.refresh":
                try params.requireOnly([])
                writer.send(result: try host.refreshPage(admittedGeneration: admittedGeneration), id: id)
            case "observation.read":
                writer.send(result: try host.readObservation(params, admittedGeneration: admittedGeneration), id: id)
            case "observation.capture":
                try params.requireOnly(["query"])
                let query = params.has("query") ? try params.string("query") : "editable_fields"
                writer.send(result: try host.capture(query), id: id)
            case "operation.prepare":
                writer.send(result: try host.prepare(params), id: id)
            case "operation.commit":
                try params.requireOnly(["preparedId"])
                try params.require(["preparedId"])
                let preparedId = try params.string("preparedId")
                let (receipt, suppress) = try host.commit(preparedId)
                if !suppress { writer.send(result: receipt, id: id) }
            case "operation.status":
                try params.requireOnly(["operationId"])
                try params.require(["operationId"])
                let operationId = try params.string("operationId")
                writer.send(result: try host.status(operationId), id: id)
            default:
                writer.send(error: RPCCode.methodNotFound.rawValue, message: "method not found", id: id)
            }
        } catch let error as HostError {
            if [AppProfile.fixtureId, AppProfile.chromeFixtureId].contains(host.grant.appId)
                && ProcessInfo.processInfo.environment["ARIADNE_DEBUG"] == "1" {
                FileHandle.standardError.write(Data(("AriadneHost diagnostic: " + error.message + "\n").utf8))
            }
            writer.send(error: RPCCode.host.rawValue, message: message(for: error.code),
                        id: id, hostCode: error.code)
        } catch is ShapeFailure {
            writer.send(error: RPCCode.invalidParams.rawValue, message: "invalid params", id: id)
        } catch {
            writer.send(error: RPCCode.internalError.rawValue, message: "internal error", id: id)
        }
    }

    /// Error text is fixed per code and never echoes request content.
    private func message(for code: HostErrorCode) -> String {
        switch code {
        case .scopeDenied: return "scope denied"
        case .invalidRequest: return "invalid request"
        case .staleSession: return "stale session"
        case .staleBinding: return "stale binding"
        case .unsupported: return "unsupported operation"
        case .cancelled: return "session cancelled"
        case .outcomeUnknown: return "outcome unknown"
        case .journalError: return "journal error"
        case .closed: return "host closed"
        }
    }
}
