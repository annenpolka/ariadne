import AppKit
import ApplicationServices
import Foundation

// Read only the dedicated process window metadata. Page content is read by AriadneHost.
func emit(_ result: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}
guard CommandLine.arguments.count >= 3,
      let pid = Int32(CommandLine.arguments[1]), pid > 0,
      let app = NSRunningApplication(processIdentifier: pid),
      app.bundleIdentifier == "com.google.Chrome",
      app.executableURL?.path == "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" else {
    emit(["status": "scope_denied"]); exit(2)
}
guard AXIsProcessTrusted() else {
    emit(["status": "accessibility_permission_missing"]); exit(2)
}
let application = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(application, 2)
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
let deadline = Date().addingTimeInterval(5)
let allowedOrigins = Set(CommandLine.arguments.dropFirst(2))
var windowCount = 0
var matchingWindowCount = 0
while Date() < deadline {
    let windows = attribute(application, "AXWindows") as? [AXUIElement] ?? []
    windowCount = windows.count
    // Chrome may expose non-document popovers as separate AXWindows. Select
    // exactly one document in the granted origins; never select by array order.
    var matches: [[String: Any]] = []
    for window in windows.prefix(64) {
        let raw = attribute(window, "AXDocument")
        let url = (raw as? URL)?.absoluteString ?? (raw as? String)
        if let url, let parsed = URLComponents(string: url), let scheme = parsed.scheme, let host = parsed.host {
            let port = parsed.port
            let origin = "\(scheme)://\(host.lowercased())" + ((port == nil || (scheme == "https" && port == 443) || (scheme == "http" && port == 80)) ? "" : ":\(port!)")
            if allowedOrigins.contains(origin), parsed.user == nil, parsed.password == nil,
               let title = attribute(window, "AXTitle") as? String, !title.isEmpty {
                matches.append(["status": "browser_window", "pid": pid, "url": url, "title": title])
            }
        }
    }
    matchingWindowCount = matches.count
    if windows.count <= 64, matches.count == 1 { emit(matches[0]); exit(0) }
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
}
emit(["status": "browser_window_unavailable", "pid": pid, "windowCount": windowCount,
      "matchingWindowCount": matchingWindowCount]); exit(0)
