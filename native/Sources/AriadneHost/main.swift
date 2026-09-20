import Foundation

func fail(_ message: String, code: Int32 = 2) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

var pid: pid_t = 0
var windowTitle: String?
var grantPath: String?
var journalPath: String?
var documentPath: String?
var pageURL: String?

var arguments = Array(CommandLine.arguments.dropFirst())
var index = 0
while index < arguments.count {
    switch arguments[index] {
    case "--pid":
        guard index + 1 < arguments.count, let value = Int32(arguments[index + 1]) else {
            fail("AriadneHost: invalid --pid")
        }
        pid = value
        index += 2
    case "--window-title":
        guard index + 1 < arguments.count else { fail("AriadneHost: missing --window-title") }
        windowTitle = arguments[index + 1]
        index += 2
    case "--grant":
        guard index + 1 < arguments.count else { fail("AriadneHost: missing --grant") }
        grantPath = arguments[index + 1]
        index += 2
    case "--journal":
        guard index + 1 < arguments.count else { fail("AriadneHost: missing --journal") }
        journalPath = arguments[index + 1]
        index += 2
    case "--document":
        guard index + 1 < arguments.count else { fail("AriadneHost: missing --document") }
        documentPath = arguments[index + 1]
        index += 2
    case "--page-url":
        guard index + 1 < arguments.count else { fail("AriadneHost: missing --page-url") }
        pageURL = arguments[index + 1]
        index += 2
    default:
        fail("AriadneHost: unknown argument")
    }
}

guard pid > 0, let windowTitle, let grantPath, let journalPath else {
    fail("usage: AriadneHost --pid POSITIVE_PID --window-title TITLE --grant PATH --journal PATH [--document ABSOLUTE_FILE_PATH] [--page-url URL]")
}

do {
    let grantData = try Data(contentsOf: URL(fileURLWithPath: grantPath))
    let grant = try ScopeGrant.parse(try parseJSONTop(grantData))
    if grant.appId == AppProfile.textEditId, documentPath == nil {
        fail("AriadneHost: --document is required for the TextEdit profile")
    }
    if grant.appId == AppProfile.chromeId {
        // The raw URL (query and fragment included) is pinned exactly as the
        // operator gave it; only its origin is matched against the grant.
        guard let rawPageURL = pageURL, let origin = BrowserURL.origin(rawPageURL),
              grant.pageScope?.origins.contains(origin) == true else {
            fail("AriadneHost: --page-url must be a valid URL whose origin is granted")
        }
    } else if AppProfile.isBrowser(grant.appId) {
        guard let rawPageURL = pageURL, let canonical = AppProfile.canonicalURL(rawPageURL, for: grant.appId) else {
            fail("AriadneHost: --page-url must match the registered browser profile")
        }
        pageURL = canonical
    } else if pageURL != nil {
        fail("AriadneHost: --page-url is only valid for a registered browser profile")
    }
    let control = ControlState()
    let host = try Host(pid: pid, windowTitle: windowTitle, grant: grant,
                        journalPath: journalPath, control: control,
                        documentPath: grant.appId == AppProfile.textEditId ? documentPath : nil,
                        pageURL: AppProfile.isBrowser(grant.appId) ? pageURL : nil)
    Server(host: host).run()
    exit(0)
} catch let error as HostError {
    fail("AriadneHost: \(error.code.rawValue)")
} catch let error as ShapeFailure {
    switch error {
    case .malformed: fail("AriadneHost: grant is not valid JSON")
    case .shape: fail("AriadneHost: grant does not match ScopeGrant")
    }
} catch {
    fail("AriadneHost: startup failed")
}
