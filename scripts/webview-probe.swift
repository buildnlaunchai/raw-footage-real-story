// Run a page in WKWebView and print what it produces.
//
// This exists because the captions are drawn by the app's own webview, and on
// macOS that is WKWebView — not Chrome, and not CoreText's text API either.
// Both of those were measured and both were right, and the captions still came
// out wrong, because the thing that actually draws them had never been asked.
//
//   swift scripts/webview-probe.swift <page.html> [seconds]
//
// The page puts whatever it wants to report into `window.__result` as a
// string; this prints it. A page that never sets it times out and says so,
// which is a failure rather than an empty pass.
import AppKit
import WebKit

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("usage: webview-probe <page.html> [seconds]\n".data(using: .utf8)!)
    exit(2)
}
// Symlinks resolved: a temp directory on macOS is reached through /var, which
// is a link to /private/var, and WKWebView compares the resolved path when it
// decides whether the page may read the folder it sits in. Unresolved, the
// page loads and every fetch beside it is refused — silently, so it presents
// as a page that simply never finishes.
let page = URL(fileURLWithPath: args[1]).resolvingSymlinksInPath()
let timeout = args.count > 2 ? Double(args[2]) ?? 20 : 20

final class Probe: NSObject, WKNavigationDelegate {
    let web: WKWebView
    var done = false

    override init() {
        let config = WKWebViewConfiguration()
        // The page reads its own font file off disk, as the app reads the font
        // it ships with.
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800), configuration: config)
        super.init()
        web.navigationDelegate = self
    }

    func webView(_ web: WKWebView, didFinish _: WKNavigation!) {
        poll()
    }

    // Load failures reported rather than left to look like a page that is
    // merely slow. A probe that goes quiet teaches nothing.
    func webView(_: WKWebView, didFail _: WKNavigation!, withError error: Error) {
        fail("navigation failed: \(error.localizedDescription)")
    }

    func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError error: Error) {
        fail("could not load the page: \(error.localizedDescription)")
    }

    func fail(_ message: String) {
        FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
        exit(1)
    }

    /// Wait for the page to set `window.__result`, then print it.
    func poll() {
        web.evaluateJavaScript("window.__result || ''") { value, _ in
            if let s = value as? String, !s.isEmpty {
                print(s)
                self.done = true
                exit(0)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.poll() }
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let probe = Probe()
probe.web.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())

DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
    if !probe.done {
        FileHandle.standardError.write("the page never reported a result\n".data(using: .utf8)!)
        exit(1)
    }
}
app.run()
