import Cocoa
import WebKit

private weak var sharedDelegate: AppDelegate?

private struct PortSelection {
  let port: Int
  let isExplicit: Bool
}

private func resolvePortSelection() -> PortSelection {
  let rawPort = ProcessInfo.processInfo.environment["CODEX_HISTORY_VIEWER_PORT"]?
    .trimmingCharacters(in: .whitespacesAndNewlines)
  if let rawPort, let port = Int(rawPort), (1...65535).contains(port) {
    return PortSelection(port: port, isExplicit: true)
  }

  return PortSelection(port: findAvailablePort() ?? 3999, isExplicit: false)
}

private func findAvailablePort() -> Int? {
  let socketFD = socket(AF_INET, SOCK_STREAM, 0)
  guard socketFD >= 0 else {
    return nil
  }
  defer {
    close(socketFD)
  }

  var address = sockaddr_in()
  address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
  address.sin_family = sa_family_t(AF_INET)
  address.sin_port = 0
  address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

  let bindResult = withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
      bind(socketFD, socketAddress, socklen_t(MemoryLayout<sockaddr_in>.size))
    }
  }
  guard bindResult == 0 else {
    return nil
  }

  var length = socklen_t(MemoryLayout<sockaddr_in>.size)
  let nameResult = withUnsafeMutablePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
      getsockname(socketFD, socketAddress, &length)
    }
  }
  guard nameResult == 0 else {
    return nil
  }

  return Int(UInt16(bigEndian: address.sin_port))
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate {
  private let host = "127.0.0.1"
  private let portSelection = resolvePortSelection()
  private var window: NSWindow?
  private var webView: WKWebView?
  private var serverProcess: Process?
  private var startupOutput = ""
  private let logURL = URL(fileURLWithPath: "/tmp/codex-history-viewer.log")

  private var port: Int {
    portSelection.port
  }

  private var baseURL: URL {
    URL(string: "http://\(host):\(port)")!
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    let portMode = portSelection.isExplicit ? "explicit" : "automatic"
    log("Launching app with \(portMode) port \(port)")
    startServerIfNeeded()
    createWindow()
    loadWhenReady()
  }

  func applicationWillTerminate(_ notification: Notification) {
    stopServer()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  private func createWindow() {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default()

    let webView = WKWebView(frame: .zero, configuration: config)
    webView.allowsBackForwardNavigationGestures = true
    webView.uiDelegate = self
    self.webView = webView

    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1220, height: 820),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "Codex History Viewer"
    window.center()
    window.contentView = webView
    window.makeKeyAndOrderFront(nil)
    self.window = window

    NSApp.activate(ignoringOtherApps: true)
  }

  private func startServerIfNeeded() {
    guard !isServerListening() else {
      log("Server already listening on \(host):\(port)")
      return
    }

    guard let resourceURL = Bundle.main.resourceURL else {
      startupOutput += "Cannot find bundled app resources.\n"
      log("Cannot find bundled app resources")
      return
    }

    let viewerDir = resourceURL.appendingPathComponent("viewer").path
    let bundledNodePath = resourceURL.appendingPathComponent("node/bin/node").path
    guard FileManager.default.fileExists(atPath: viewerDir) else {
      startupOutput += "Cannot find bundled viewer resources.\n"
      log("Cannot find bundled viewer resources")
      return
    }
    log("Starting bundled server from \(viewerDir)")

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/zsh")
    process.arguments = [
      "-lc",
      """
      set -e
      NODE_BIN="${CODEX_HISTORY_VIEWER_NODE:-}"
      if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then
        :
      elif command -v node >/dev/null 2>&1; then
        NODE_BIN="$(command -v node)"
      else
        for candidate in "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
          if [ -x "$candidate" ]; then
            NODE_BIN="$candidate"
            break
          fi
        done
      fi

      if [ -z "$NODE_BIN" ]; then
        echo "Node.js was not found. The bundled Node runtime is missing or not executable."
        exit 127
      fi

      cd "$CODEX_HISTORY_VIEWER_DIR"
      HOST=127.0.0.1 PORT="$CODEX_HISTORY_VIEWER_PORT" "$NODE_BIN" server.mjs &
      CHILD_PID=$!
      cleanup() {
        kill "$CHILD_PID" >/dev/null 2>&1 || true
        wait "$CHILD_PID" >/dev/null 2>&1 || true
      }
      trap cleanup INT TERM EXIT
      wait "$CHILD_PID"
      """
    ]

    var environment = ProcessInfo.processInfo.environment
    environment["CODEX_HISTORY_VIEWER_DIR"] = viewerDir
    environment["CODEX_HISTORY_VIEWER_NODE"] = bundledNodePath
    environment["CODEX_HISTORY_VIEWER_PORT"] = String(port)
    process.environment = environment

    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      guard let self else {
        return
      }
      let data = handle.availableData
      guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else {
        return
      }
      DispatchQueue.main.async {
        self.startupOutput += text
        self.log(text.trimmingCharacters(in: .whitespacesAndNewlines))
        if self.startupOutput.count > 6000 {
          self.startupOutput.removeFirst(self.startupOutput.count - 6000)
        }
      }
    }

    process.terminationHandler = { [weak self] terminatedProcess in
      self?.log("Server process exited with status \(terminatedProcess.terminationStatus)")
    }

    do {
      try process.run()
      serverProcess = process
      log("Server launcher process started with pid \(process.processIdentifier)")
    } catch {
      startupOutput += "Failed to start bundled server: \(error.localizedDescription)\n"
      log("Failed to start bundled server: \(error.localizedDescription)")
    }
  }

  private func loadWhenReady(attempt: Int = 0) {
    checkServerHealth { [weak self] ready in
      guard let self else {
        return
      }

      DispatchQueue.main.async {
        if ready {
          self.webView?.load(URLRequest(url: self.baseURL))
          return
        }

        if attempt < 80 {
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            self.loadWhenReady(attempt: attempt + 1)
          }
          return
        }

        self.showStartupError()
      }
    }
  }

  private func checkServerHealth(completion: @escaping (Bool) -> Void) {
    let url = baseURL.appendingPathComponent("api/health")
    var request = URLRequest(url: url)
    request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    request.timeoutInterval = 1.5

    URLSession.shared.dataTask(with: request) { _, response, _ in
      let status = (response as? HTTPURLResponse)?.statusCode
      completion(status == 200)
    }.resume()
  }

  private func isServerListening() -> Bool {
    let socketFD = socket(AF_INET, SOCK_STREAM, 0)
    guard socketFD >= 0 else {
      return false
    }
    defer {
      close(socketFD)
    }

    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = in_port_t(port).bigEndian
    address.sin_addr = in_addr(s_addr: inet_addr(host))

    let result = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
        connect(socketFD, socketAddress, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }

    return result == 0
  }

  private func showStartupError() {
    let alert = NSAlert()
    alert.alertStyle = .critical
    alert.messageText = "Codex History Viewer 启动失败"
    alert.informativeText = """
    无法连接到 http://127.0.0.1:\(port)。

    请确认应用包内的 Node runtime 存在，或者在项目目录运行 npm start 后重新打开此应用。

    \(startupOutput.trimmingCharacters(in: .whitespacesAndNewlines))
    """
    alert.addButton(withTitle: "退出")
    alert.runModal()
    NSApp.terminate(nil)
  }

  func stopServer() {
    guard let process = serverProcess, process.isRunning else {
      return
    }

    log("Stopping server process \(process.processIdentifier)")
    process.interrupt()
    let deadline = Date().addingTimeInterval(1.0)
    while process.isRunning && Date() < deadline {
      Thread.sleep(forTimeInterval: 0.05)
    }
    if process.isRunning {
      process.terminate()
    }
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptConfirmPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping (Bool) -> Void
  ) {
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "恢复到 Codex App"
    alert.informativeText = message
    alert.addButton(withTitle: "恢复")
    alert.addButton(withTitle: "取消")

    let response = alert.runModal()
    completionHandler(response == .alertFirstButtonReturn)
  }

  private func log(_ message: String) {
    let line = "[\(ISO8601DateFormatter().string(from: Date()))] \(message)\n"
    guard let data = line.data(using: .utf8) else {
      return
    }

    if FileManager.default.fileExists(atPath: logURL.path) {
      if let handle = try? FileHandle(forWritingTo: logURL) {
        defer {
          try? handle.close()
        }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: data)
      }
      return
    }

    try? data.write(to: logURL)
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
sharedDelegate = delegate
signal(SIGINT) { _ in
  sharedDelegate?.stopServer()
  exit(130)
}
signal(SIGTERM) { _ in
  sharedDelegate?.stopServer()
  exit(143)
}
app.delegate = delegate
app.run()
