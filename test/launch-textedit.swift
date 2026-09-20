import AppKit
import Foundation

// Harness only. Open precisely the newly created synthetic document supplied by the test.
guard CommandLine.arguments.count == 2 else { exit(2) }
let document = URL(fileURLWithPath: CommandLine.arguments[1])
guard FileManager.default.fileExists(atPath: document.path),
      let application = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.TextEdit") else { exit(2) }
let configuration = NSWorkspace.OpenConfiguration()
configuration.activates = true
NSWorkspace.shared.open([document], withApplicationAt: application, configuration: configuration) { app, error in
    guard error == nil, let app else { exit(3) }
    print(app.processIdentifier)
    fflush(stdout)
    exit(0)
}
RunLoop.main.run()
