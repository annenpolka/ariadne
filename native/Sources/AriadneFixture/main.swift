import AppKit
import Foundation

@MainActor
final class FixtureField: NSTextField {
    var onAXSet: (() -> Void)?
    var readDelay: (() -> Int)?
    override func accessibilityValue() -> String? {
        if let milliseconds = readDelay?(), milliseconds > 0 { Thread.sleep(forTimeInterval: Double(milliseconds) / 1000) }
        return super.accessibilityValue()
    }
    override func setAccessibilityValue(_ value: Any?) {
        super.setAccessibilityValue(value)
        // The fixture's setter is an explicit test seam with a separate oracle.
        // Keep the AppKit text model in sync when overriding the accessibility setter.
        if let text = value as? String { stringValue = text }
        onAXSet?()
    }
}

@MainActor
final class FixtureDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var contact: NSTextField!
    private var shipping: NSTextField!
    private var container: NSStackView!
    private var actions: NSStackView!
    private var submissions = 0
    private var generation = 1
    private var axSets = 0
    private var readDelayPath: String?
    private var delayedReads = 0
    private var oracleURL: URL?
    private var timer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let arguments = CommandLine.arguments
        if let i = arguments.firstIndex(of: "--read-delay-file"), arguments.indices.contains(i + 1) { readDelayPath = arguments[i + 1] }
        if let i = arguments.firstIndex(of: "--oracle"), arguments.indices.contains(i + 1) {
            oracleURL = URL(fileURLWithPath: arguments[i + 1])
        }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 540, height: 360), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Ariadne Fixture"
        container = NSStackView()
        container.orientation = .vertical
        container.alignment = .leading
        container.spacing = 18
        container.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        contact = field(label: "メール", region: "連絡先", value: "")
        shipping = field(label: "メール", region: "配送通知先", value: "")
        let disabled = field(label: "Disabled", region: "Reference", value: "read only")
        disabled.isEnabled = false
        actions = NSStackView()
        actions.spacing = 10
        for (title, selector, identifier) in [("Replace field", #selector(replaceField), "fixture.replace_field"), ("Show modal", #selector(showModal), "fixture.show_modal"), ("Submit", #selector(submit), "fixture.submit")] {
            let button = NSButton(title: title, target: self, action: selector)
            button.setAccessibilityIdentifier(identifier)
            actions.addArrangedSubview(button)
        }
        container.addArrangedSubview(actions)
        window.contentView = container
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        // Oracle is a test-only file; its location and business IDs are never AX attributes.
        writeOracle()
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.writeOracle() }
        }
        if let i = arguments.firstIndex(of: "--exit-after"), arguments.indices.contains(i + 1), let seconds = Double(arguments[i + 1]) {
            _ = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { _ in
                MainActor.assumeIsolated { NSApp.terminate(nil) }
            }
        }
    }

    private func field(label: String, region: String, value: String) -> NSTextField {
        let box = NSBox()
        box.title = region
        box.setAccessibilityLabel(region)
        let input = FixtureField(string: value)
        input.onAXSet = { [weak self] in self?.axSets += 1 }
        input.readDelay = { [weak self] in self?.nextReadDelay() ?? 0 }
        input.setAccessibilityLabel(label)
        input.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(input)
        NSLayoutConstraint.activate([
            input.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 8),
            input.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -8),
            input.topAnchor.constraint(equalTo: content.topAnchor, constant: 8),
            input.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -8),
            input.widthAnchor.constraint(equalToConstant: 420),
        ])
        box.contentView = content
        container.addArrangedSubview(box)
        return input
    }

    @objc private func replaceField() {
        guard let parent = contact.superview else { return }
        let replacement = FixtureField(frame: contact.frame)
        replacement.onAXSet = { [weak self] in self?.axSets += 1 }
        replacement.readDelay = { [weak self] in self?.nextReadDelay() ?? 0 }
        replacement.setAccessibilityLabel("メール")
        replacement.autoresizingMask = [.width]
        contact.removeFromSuperview()
        parent.addSubview(replacement)
        contact = replacement
        generation += 1
        writeOracle()
    }
    @objc private func showModal() {
        let alert = NSAlert()
        alert.messageText = "Fixture modal"
        alert.addButton(withTitle: "Close")
        alert.beginSheetModal(for: window)
    }
    @objc private func submit() { submissions += 1; writeOracle() }
    private func nextReadDelay() -> Int {
        guard let path = readDelayPath, let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Int],
              let ordinal = object["delayOnRead"], let milliseconds = object["milliseconds"] else { return 0 }
        delayedReads += 1
        if delayedReads == ordinal { try? Data("AX getter entered\n".utf8).write(to: URL(fileURLWithPath: path + ".entered"), options: .atomic) }
        return delayedReads == ordinal ? min(1000, max(0, milliseconds)) : 0
    }
    private func writeOracle() {
        guard let url = oracleURL else { return }
        let state: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "contactEmail": contact.stringValue, "shippingEmail": shipping.stringValue, "submissions": submissions, "generation": generation, "axSets": axSets]
        do { try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]).write(to: url, options: .atomic) }
        catch { FileHandle.standardError.write(Data("fixture oracle write failed\n".utf8)) }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = FixtureDelegate()
app.delegate = delegate
app.run()
