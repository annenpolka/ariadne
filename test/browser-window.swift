import AppKit
import ApplicationServices
import Foundation

// Harness only: select the window of our newly spawned Chrome process using
// the exact local URL, then supply its actual title to the unchanged Host gate.
guard CommandLine.arguments.count == 3,
      let pid = Int32(CommandLine.arguments[1]), pid > 0,
      let app = NSRunningApplication(processIdentifier: pid),
      app.bundleIdentifier == "com.google.Chrome", AXIsProcessTrusted() else { exit(2) }
let expectedURL = CommandLine.arguments[2]
let application = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(application, 2)
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func documentURL(_ element: AXUIElement) -> String? {
    let value = attribute(element, "AXDocument")
    if let url = value as? URL { return url.absoluteString }
    return value as? String
}
app.activate(options: [.activateAllWindows])
let deadline = Date().addingTimeInterval(5)
while Date() < deadline {
    let windows = attribute(application, "AXWindows") as? [AXUIElement] ?? []
    let matches = windows.filter { documentURL($0) == expectedURL }
    if matches.count == 1, let window = matches.first,
       let title = attribute(window, "AXTitle") as? String, !title.isEmpty {
        let data = try! JSONSerialization.data(withJSONObject: ["pid": pid, "title": title, "url": expectedURL])
        FileHandle.standardOutput.write(data)
        exit(0)
    }
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
}
exit(3)
