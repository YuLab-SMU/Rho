import AppKit

// A vector-drawn local preview icon, rendered only during assembly.
if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--write-icon" {
    let directory = URL(fileURLWithPath: CommandLine.arguments[2])
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    for size in [16, 32, 128, 256, 512] {
        for scale in [1, 2] {
            let pixels = size * scale
            let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
            NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
            let n = CGFloat(pixels), inset = n * 0.07
            let shape = NSBezierPath(roundedRect: NSRect(x: inset, y: inset, width: n - 2 * inset, height: n - 2 * inset), xRadius: n * 0.2, yRadius: n * 0.2)
            NSGradient(starting: NSColor(red: 0.10, green: 0.35, blue: 0.40, alpha: 1), ending: NSColor(red: 0.08, green: 0.16, blue: 0.25, alpha: 1))!.draw(in: shape, angle: -80)
            let attributes: [NSAttributedString.Key: Any] = [.font: NSFont(name: "TimesNewRomanPS-ItalicMT", size: n * 0.82)!, .foregroundColor: NSColor.white]
            let mark = "ρ" as NSString, bounds = mark.size(withAttributes: attributes)
            mark.draw(at: NSPoint(x: (n - bounds.width) / 2, y: (n - bounds.height) / 2 + n * 0.09), withAttributes: attributes)
            NSGraphicsContext.restoreGraphicsState()
            let name = "icon_\(size)x\(size)" + (scale == 2 ? "@2x" : "") + ".png"
            try bitmap.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent(name))
        }
    }
    exit(0)
}

final class PreviewApp: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var detail: NSTextField!
    private var progress: NSProgressIndicator!
    private var openButton: NSButton!
    private var retryButton: NSButton!
    private var worker: Process?
    private var input: Pipe?
    private var buffer = Data()
    private var address: URL?
    private var statePath: String?
    private var projectPath: String?
    private var terminating = false
    private var ready = false
    private var hasError = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "Open Workspace", action: #selector(openWorkspace), keyEquivalent: "o").target = self
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit Rho", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 310), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Rho Preview"; window.delegate = self; window.center()
        let title = NSTextField(labelWithString: "Your scientific workspace")
        title.font = .systemFont(ofSize: 24, weight: .semibold)
        detail = NSTextField(wrappingLabelWithString: "Preparing Rho…")
        detail.font = .systemFont(ofSize: 14); detail.textColor = .secondaryLabelColor
        detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        progress = NSProgressIndicator(); progress.style = .spinning; progress.controlSize = .small; progress.startAnimation(nil)
        openButton = NSButton(title: "Open Workspace", target: self, action: #selector(openWorkspace)); openButton.isEnabled = false
        openButton.bezelStyle = .rounded; openButton.keyEquivalent = "\r"
        retryButton = NSButton(title: "Retry", target: self, action: #selector(retry)); retryButton.isHidden = true
        let project = NSButton(title: "Show Project", target: self, action: #selector(showProject))
        let logs = NSButton(title: "Show Logs", target: self, action: #selector(showLogs))
        let quit = NSButton(title: "Quit Rho", target: NSApp, action: #selector(NSApplication.terminate(_:)))
        let row = NSStackView(views: [openButton, retryButton, project, logs, quit]); row.orientation = .horizontal; row.spacing = 8
        let stack = NSStackView(views: [title, detail, progress, row]); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 22
        stack.translatesAutoresizingMaskIntoConstraints = false; window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -28),
            stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 32)])
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        launch()
    }
    private func launch(stopOnly: Bool = false) {
        guard let resources = Bundle.main.resourceURL else { return }
        hasError = false
        let process = Process(), output = Pipe(), stdin = Pipe()
        process.executableURL = resources.appendingPathComponent("node")
        process.arguments = [resources.appendingPathComponent("service.mjs").path] + (stopOnly ? ["--stop"] : [])
        process.standardInput = stdin; process.standardOutput = output; process.standardError = output
        process.currentDirectoryURL = resources
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let bytes = handle.availableData
            if bytes.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.consume(bytes) }
        }
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if process.terminationStatus != 0 && !self.terminating && !self.hasError { self.failed("The preview launcher stopped. Open logs for details, then retry.") }
            }
        }
        worker = process; input = stdin
        do {try process.run()} catch {failed(error.localizedDescription)}
    }
    private func consume(_ bytes: Data) {
        buffer.append(bytes)
        while let range = buffer.range(of: Data([10])) {
            let line = buffer.subdata(in: 0..<range.lowerBound); buffer.removeSubrange(0...range.lowerBound)
            guard let value = try? JSONSerialization.jsonObject(with: line) as? [String: Any], let type = value["type"] as? String else { continue }
            statePath = value["state"] as? String ?? statePath; projectPath = value["project"] as? String ?? projectPath
            switch type {
            case "status": detail.stringValue = value["message"] as? String ?? "Preparing Rho…"; progress.startAnimation(nil)
            case "ready":
                guard let text = value["url"] as? String, let url = URL(string: text), url.host == "127.0.0.1" else { failed("Rho returned an invalid local address."); continue }
                address = url; ready = true; openButton.isEnabled = true; retryButton.isHidden = true; progress.stopAnimation(nil)
                detail.stringValue = "Your demo is ready in the browser. Click Start R in Console, then Save and Run in the open demo script. Reopening this app returns to the same workspace."
                openWorkspace()
            case "error": failed(value["message"] as? String ?? "Rho could not start.")
            case "blocked":
                failed(value["message"] as? String ?? "Rho cannot quit while work is active.")
                if terminating {terminating = false; NSApp.reply(toApplicationShouldTerminate: false)}
            case "stopped":
                if terminating {NSApp.reply(toApplicationShouldTerminate: true)}
                else {detail.stringValue = "Rho is stopped."; openButton.isEnabled = false; progress.stopAnimation(nil)}
            default: break
            }
        }
    }
    private func failed(_ message: String) {hasError = true; detail.stringValue = message; progress.stopAnimation(nil); retryButton.isHidden = false; window.makeKeyAndOrderFront(nil)}
    @objc func retry() {
        retryButton.isHidden = true; progress.startAnimation(nil)
        if worker?.isRunning == true {input?.fileHandleForWriting.write(Data("retry\n".utf8))} else {launch()}
    }
    @objc func openWorkspace() {if let address = address {NSWorkspace.shared.open(address)}}
    @objc func showProject() {if let projectPath = projectPath {NSWorkspace.shared.open(URL(fileURLWithPath: projectPath))}}
    @objc func showLogs() {
        let fallback = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Rho/Preview").path
        NSWorkspace.shared.open(URL(fileURLWithPath: statePath ?? fallback))
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil); if ready {openWorkspace()}; return true
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {false}
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminating {return .terminateLater}
        if ready {
            let alert = NSAlert(); alert.messageText = "Quit Rho?"
            alert.informativeText = "Save your files before quitting. R session memory will end; saved files and synchronized drafts remain available next time."
            alert.addButton(withTitle: "Keep Working"); alert.addButton(withTitle: "Quit Rho")
            if alert.runModal() != .alertSecondButtonReturn {return .terminateCancel}
        }
        terminating = true
        if worker?.isRunning == true {input?.fileHandleForWriting.write(Data("quit\n".utf8))} else {launch(stopOnly: true)}
        return .terminateLater
    }
}

let app = NSApplication.shared
let delegate = PreviewApp()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
