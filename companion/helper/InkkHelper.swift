// inkk-helper — the few things the companion needs from macOS that Node can't
// reach: which app and document are in front, the words in a picture (Vision),
// and the text and metadata of a PDF (PDFKit).
//
//   inkk-helper serve                  stays running: one JSON request per line on
//                                      stdin, one JSON answer per line on stdout
//   inkk-helper front-doc              the app in front, its window title and document
//   inkk-helper front-window
//   inkk-helper ax-window <pid>        text, links and image descriptions in the front window
//   inkk-helper ax-focused <pid>       the text of the focused editor (certify)
//   inkk-helper ax-doc <pid>           the front window's title and document
//   inkk-helper ocr <image>
//   inkk-helper pdf-text <pdf>
//   inkk-helper pdf-meta <pdf>
//   inkk-helper pdf-stamp <pdf> <code> <seal-url>
//   inkk-helper make-pdf <text-file> <out.pdf>      (tests only)
//
// Run with a command, it answers once and exits (JSON on stdout, or a message
// on stderr and exit status 1). `serve` answers the same commands for as long
// as the companion keeps its stdin open, so the front document can be asked
// about every 750 ms without starting a process each time:
//
//   → {"id": 7, "cmd": "front-doc", "args": []}
//   ← {"id": 7, "ok": true, "result": {…}}      or {"id": 7, "ok": false, "error": "…"}
//
// Everything stays on this Mac. The helper runs as a child of the companion, so
// macOS attributes its permissions (Screen Recording, Accessibility) to inkk.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import PDFKit
import Vision

// A command that could not answer. One-shot mode prints it and exits 1; serve
// mode sends it back as the request's error.
struct HelperError: Error { let message: String }

func failure(_ message: String) -> HelperError { HelperError(message: message) }

// JSON for one answer. NaN or infinity anywhere would make JSONSerialization
// raise rather than throw, so the value is checked first.
func jsonData(_ value: Any) -> Data? {
    guard JSONSerialization.isValidJSONObject([value]) else { return nil }
    return try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
}

// The frontmost app's frontmost ordinary window (layer 0), front to back.
func frontWindow() -> Any {
    guard let app = NSWorkspace.shared.frontmostApplication else { return NSNull() }
    let pid = app.processIdentifier
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return NSNull() }
    for w in list {
        guard (w[kCGWindowOwnerPID as String] as? Int32) == pid,
              (w[kCGWindowLayer as String] as? Int) == 0,
              let id = w[kCGWindowNumber as String] as? Int,
              let b = w[kCGWindowBounds as String] as? [String: Any] else { continue }
        let width = (b["Width"] as? Double) ?? 0, height = (b["Height"] as? Double) ?? 0
        if width < 80 || height < 60 { continue }
        if let alpha = w[kCGWindowAlpha as String] as? Double, alpha <= 0 { continue }
        return [
            "id": id,
            "pid": Int(pid),
            "owner": (w[kCGWindowOwnerName as String] as? String) ?? (app.localizedName ?? ""),
            "bundleId": app.bundleIdentifier ?? "",
            "title": (w[kCGWindowName as String] as? String) ?? "",
            "bounds": ["x": (b["X"] as? Double) ?? 0, "y": (b["Y"] as? Double) ?? 0, "w": width, "h": height],
        ] as [String: Any]
    }
    return NSNull()
}

func cgImage(at path: String) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

// Lines of text in an image, top to bottom, with their boxes in pixels.
func ocr(_ path: String) throws -> Any {
    guard let image = cgImage(at: path) else { throw failure("unreadable image") }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.recognitionLanguages = ["en-GB", "en-US"]
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do { try handler.perform([request]) } catch { throw failure("ocr failed: \(error.localizedDescription)") }
    let w = Double(image.width), h = Double(image.height)
    let lines: [[String: Any]] = (request.results ?? []).compactMap { obs in
        guard let top = obs.topCandidates(1).first else { return nil }
        let r = obs.boundingBox
        return ["text": top.string, "confidence": Double(top.confidence),
                "box": ["x": r.minX * w, "y": (1 - r.maxY) * h, "w": r.width * w, "h": r.height * h]]
    }.sorted { a, b in
        let ya = ((a["box"] as? [String: Double])?["y"]) ?? 0, yb = ((b["box"] as? [String: Double])?["y"]) ?? 0
        return ya < yb
    }
    return lines
}

func openPDF(_ path: String) throws -> PDFDocument {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else { throw failure("unreadable pdf") }
    if doc.isLocked { throw failure("locked pdf") }
    return doc
}

func pdfText(_ path: String) throws -> Any {
    let doc = try openPDF(path)
    var pages: [String] = []
    for i in 0..<doc.pageCount { if let s = doc.page(at: i)?.string { pages.append(s) } }
    return ["text": pages.joined(separator: "\n\n"), "pages": doc.pageCount] as [String: Any]
}

func keywordsOf(_ doc: PDFDocument) -> [String] {
    let v = doc.documentAttributes?[PDFDocumentAttribute.keywordsAttribute]
    if let a = v as? [String] { return a }
    if let s = v as? String { return s.split(whereSeparator: { $0 == "," || $0 == ";" }).map { $0.trimmingCharacters(in: .whitespaces) } }
    return []
}

func pdfMeta(_ path: String) throws -> Any {
    let doc = try openPDF(path)
    let attrs = doc.documentAttributes ?? [:]
    return [
        "keywords": keywordsOf(doc),
        "subject": (attrs[PDFDocumentAttribute.subjectAttribute] as? String) ?? "",
        "title": (attrs[PDFDocumentAttribute.titleAttribute] as? String) ?? "",
        "author": (attrs[PDFDocumentAttribute.authorAttribute] as? String) ?? "",
        "pages": doc.pageCount,
    ] as [String: Any]
}

// Adds "inkk:<CODE>" and the seal link to the PDF's keywords. Written to a
// temporary file first and only swapped in when it opens again with the same
// pages, so a PDF is never left half-written.
func pdfStamp(_ path: String, _ code: String, _ seal: String) throws -> Any {
    let url = URL(fileURLWithPath: path)
    let doc = try openPDF(path)
    let pages = doc.pageCount
    var keywords = keywordsOf(doc).filter { !$0.lowercased().hasPrefix("inkk:") && !$0.contains("inkk.site/v/") }
    keywords.append("inkk:\(code)")
    keywords.append(seal)
    var attrs = doc.documentAttributes ?? [:]
    attrs[PDFDocumentAttribute.keywordsAttribute] = keywords
    doc.documentAttributes = attrs

    let fm = FileManager.default
    let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).inkk-\(getpid()).tmp")
    try? fm.removeItem(at: tmp)
    guard doc.write(to: tmp) else { return ["ok": false, "error": "write failed"] }
    guard let check = PDFDocument(url: tmp), check.pageCount == pages,
          keywordsOf(check).contains("inkk:\(code)") else {
        try? fm.removeItem(at: tmp)
        return ["ok": false, "error": "stamped copy did not verify"]
    }
    let before = try? fm.attributesOfItem(atPath: path)
    do {
        _ = try fm.replaceItemAt(url, withItemAt: tmp)
    } catch {
        try? fm.removeItem(at: tmp)
        return ["ok": false, "error": "replace failed: \(error.localizedDescription)"]
    }
    if let before = before {
        var keep: [FileAttributeKey: Any] = [:]
        if let p = before[.posixPermissions] { keep[.posixPermissions] = p }
        if let m = before[.modificationDate] { keep[.modificationDate] = m }
        try? fm.setAttributes(keep, ofItemAtPath: path)
    }
    return ["ok": true]
}

// A plain one-column PDF of a text file, for the tests.
func makePDF(_ textPath: String, _ outPath: String) throws -> Any {
    guard let text = try? String(contentsOfFile: textPath, encoding: .utf8) else { throw failure("unreadable text") }
    var box = CGRect(x: 0, y: 0, width: 595, height: 842)
    guard let ctx = CGContext(URL(fileURLWithPath: outPath) as CFURL, mediaBox: &box, nil) else { throw failure("cannot create pdf") }
    let font = CTFontCreateWithName("Times-Roman" as CFString, 12, nil)
    let attr = NSAttributedString(string: text, attributes: [.font: font])
    let setter = CTFramesetterCreateWithAttributedString(attr)
    var start = 0
    let length = attr.length
    repeat {
        ctx.beginPDFPage(nil)
        let path = CGPath(rect: box.insetBy(dx: 60, dy: 60), transform: nil)
        let frame = CTFramesetterCreateFrame(setter, CFRange(location: start, length: 0), path, nil)
        CTFrameDraw(frame, ctx)
        let visible = CTFrameGetVisibleStringRange(frame)
        start += max(visible.length, 1)
        ctx.endPDFPage()
    } while start < length
    ctx.closePDF()
    return ["ok": true]
}

// ── Accessibility ───────────────────────────────────────────────────────────
// Reading another app's window goes through the Accessibility grant inkk
// already holds. Never prompts: without the grant these commands say so.

func axAttr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func axString(_ v: AnyObject?) -> String? {
    if let s = v as? String { return s }
    if let a = v as? NSAttributedString { return a.string }
    if let u = v as? URL { return u.absoluteString }
    if let u = v as? NSURL { return u.absoluteString }
    return nil
}

func axElement(_ v: AnyObject?) -> AXUIElement? {
    guard let v = v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}

func axBool(_ v: AnyObject?) -> Bool? {
    guard let v = v, CFGetTypeID(v) == CFBooleanGetTypeID() else { return nil }
    return CFBooleanGetValue((v as! CFBoolean))
}

func axWindowOf(_ app: AXUIElement) -> AXUIElement? {
    axElement(axAttr(app, "AXFocusedWindow")) ?? axElement(axAttr(app, "AXMainWindow"))
}

func axApp(_ pidArg: String) throws -> AXUIElement? {
    guard AXIsProcessTrusted() else { return nil }
    guard let pid = Int32(pidArg) else { throw failure("bad pid") }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1.0)
    // Chromium and Electron apps build their accessibility tree only when asked.
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    return app
}

let notTrusted: [String: Any] = ["error": "not trusted"]

// Whether an Accessibility error means "there is nothing there" (no such
// value, an attribute the element doesn't have, an app without Accessibility
// support, no grant) rather than "the app didn't answer in time" or "the
// element went away while we asked", which say nothing about the document.
func axNothing(_ e: AXError) -> Bool {
    e == .noValue || e == .attributeUnsupported || e == .notImplemented || e == .apiDisabled
}

// One attribute, telling a missing value apart from a failed ask.
func axAsk(_ el: AXUIElement, _ name: String) -> (value: AnyObject?, failed: Bool) {
    var v: CFTypeRef?
    let e = AXUIElementCopyAttributeValue(el, name as CFString, &v)
    return e == .success ? (v, false) : (nil, !axNothing(e))
}

// In a multiple-attribute answer, an attribute that could not be read comes
// back as an AXValue holding its error.
func axErrorIn(_ v: AnyObject) -> AXError? {
    guard CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    let value = v as! AXValue
    guard AXValueGetType(value) == .axError else { return nil }
    var e = AXError.success
    return AXValueGetValue(value, .axError, &e) ? e : nil
}

// The front app and its focused window, for the poll that decides which
// document a keystroke belongs to. NSWorkspace needs no permission; the title
// and document need Accessibility and are "" without it, or when there is no
// window, title or file. When the window could not be asked (a busy app lets
// the short timeout pass) both are null: not knowing is not the same as a
// window with no name, and the poll keeps the document it knew. Three quick
// Accessibility calls at most, and none that wake a web view.
func frontDoc() -> Any {
    guard let app = NSWorkspace.shared.frontmostApplication else { return NSNull() }
    let pid = app.processIdentifier
    var title: Any = "", document: Any = ""
    if AXIsProcessTrusted() {
        let el = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(el, 0.25)
        var failed = false
        let focused = axAsk(el, "AXFocusedWindow")
        var window = axElement(focused.value)
        if window == nil {
            let main = axAsk(el, "AXMainWindow")
            window = axElement(main.value)
            failed = window == nil && (focused.failed || main.failed)
        }
        if let w = window {
            var values: CFArray?
            let e = AXUIElementCopyMultipleAttributeValues(w, ["AXTitle", "AXDocument"] as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
            let unread = { (a: AnyObject) -> Bool in axErrorIn(a).map { !axNothing($0) } ?? false }
            if e == .success, let v = values as? [AnyObject], v.count == 2, !v.contains(where: unread) {
                title = axString(v[0]) ?? ""
                document = axString(v[1]) ?? ""
            } else if !axNothing(e) {
                failed = true
            }
        }
        if failed { title = NSNull(); document = NSNull() }
    }
    return [
        "pid": Int(pid),
        "bundleId": app.bundleIdentifier ?? "",
        "name": app.localizedName ?? "",
        "title": title,
        "document": document,
    ] as [String: Any]
}

// Chromium browsers, and apps built on Electron, keep a page's accessibility
// tree switched off until something asks for it, then build it in the
// background. The browsers answer to AXEnhancedUserInterface; Electron apps to
// AXManualAccessibility (set in axApp).
let chromiumBrowsers: Set<String> = [
    "com.google.Chrome", "com.google.Chrome.canary", "com.google.Chrome.beta", "com.google.Chrome.dev",
    "com.brave.Browser", "com.brave.Browser.beta", "com.brave.Browser.nightly",
    "com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.microsoft.edgemac.Dev", "com.microsoft.edgemac.Canary",
    "company.thebrowser.Browser", "com.vivaldi.Vivaldi", "com.operasoftware.Opera", "com.operasoftware.OperaGX",
    "org.chromium.Chromium",
]

enum WebKind { case chromium, electron, other }

func webKind(_ pid: pid_t) -> WebKind {
    guard let app = NSRunningApplication(processIdentifier: pid) else { return .other }
    if let b = app.bundleIdentifier, chromiumBrowsers.contains(b) { return .chromium }
    if let url = app.bundleURL,
       FileManager.default.fileExists(atPath: url.appendingPathComponent("Contents/Frameworks/Electron Framework.framework").path) {
        return .electron
    }
    return .other
}

// Runs `read` with the page's tree switched on. A tree that is still being
// built reads as empty, so the read is repeated for up to half a second. A
// browser's AXEnhancedUserInterface goes back to what it was afterwards:
// left on, it slows the browser's window animations.
func withWebTree<T>(_ app: AXUIElement, _ pidArg: String, empty: (T) -> Bool, _ read: () -> T) -> T {
    let kind = webKind(Int32(pidArg) ?? 0)
    var restore = false
    if kind == .chromium, axBool(axAttr(app, "AXEnhancedUserInterface")) != true {
        restore = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue) == .success
    }
    defer { if restore { AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanFalse) } }
    var r = read()
    if kind != .other {
        let deadline = Date().addingTimeInterval(0.5)
        while empty(r) && Date() < deadline {
            usleep(50_000)
            r = read()
        }
    }
    return r
}

let readAttrs = ["AXRole", "AXValue", "AXTitle", "AXDescription", "AXURL", "AXHelp", "AXChildren"] as CFArray

struct Collected {
    var texts: [String] = [], links: [String] = [], images: [String] = []
    var truncated = false
    var webContent = false        // met a web page that has something in it
}

// Breadth-first over the window, bounded in elements and time so a huge page
// can't stall the companion. Returns text in reading order, links, and image
// descriptions (a signed email's picture carries its seal in its description).
func collect(_ root: AXUIElement, maxNodes: Int, maxSeconds: Double) -> Collected {
    var out = Collected()
    var queue: [AXUIElement] = [root]
    var head = 0, seen = 0
    let deadline = Date().addingTimeInterval(maxSeconds)
    while head < queue.count {
        if seen >= maxNodes || Date() > deadline { out.truncated = true; break }
        let el = queue[head]; head += 1; seen += 1
        var values: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(el, readAttrs, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
              let v = values as? [AnyObject], v.count == 7 else { continue }
        let role = (v[0] as? String) ?? ""
        let value = axString(v[1]), title = axString(v[2]), desc = axString(v[3]), url = axString(v[4])
        if role == "AXImage" {
            for s in [desc, title, axString(v[5])] { if let s = s, !s.isEmpty { out.images.append(s) } }
        } else {
            if let s = value, !s.isEmpty, role != "AXScrollBar", role != "AXSlider" { out.texts.append(s) }
            else if let s = title, !s.isEmpty, role == "AXStaticText" || role == "AXLink" || role == "AXHeading" { out.texts.append(s) }
            if let s = desc, !s.isEmpty, role == "AXLink" || role == "AXStaticText" || role == "AXGroup" { out.texts.append(s) }
        }
        if let u = url, !u.isEmpty { out.links.append(u) }
        if let kids = v[6] as? [AXUIElement] {
            if role == "AXWebArea" && !kids.isEmpty { out.webContent = true }
            queue.append(contentsOf: kids)
        }
    }
    return out
}

func axWindow(_ pidArg: String) throws -> Any {
    guard let app = try axApp(pidArg) else { return notTrusted }
    let r: (win: AXUIElement, c: Collected)? = withWebTree(app, pidArg, empty: { r in
        guard let r = r else { return true }
        return !r.c.webContent || (r.c.texts.isEmpty && r.c.links.isEmpty && r.c.images.isEmpty)
    }) {
        guard let w = axWindowOf(app) else { return nil }
        return (w, collect(w, maxNodes: 8000, maxSeconds: 1.5))
    }
    guard let (w, c) = r else { return ["error": "no window"] }
    return [
        "title": axString(axAttr(w, "AXTitle")) ?? "",
        "document": axString(axAttr(w, "AXDocument")) ?? "",
        "text": c.texts.joined(separator: "\n"),
        "links": Array(Set(c.links)),
        "images": c.images,
        "truncated": c.truncated,
    ] as [String: Any]
}

func axDoc(_ pidArg: String) throws -> Any {
    guard let app = try axApp(pidArg) else { return notTrusted }
    guard let w = axWindowOf(app) else { return ["error": "no window"] }
    return ["title": axString(axAttr(w, "AXTitle")) ?? "", "document": axString(axAttr(w, "AXDocument")) ?? ""]
}

let editorRoles: Set<String> = ["AXTextArea", "AXGroup"]

func isEditable(_ el: AXUIElement, role: String) -> Bool {
    if role == "AXTextArea" { return true }
    if axBool(axAttr(el, "AXEditable")) == true { return true }
    var settable: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(el, "AXValue" as CFString, &settable) == .success && settable.boolValue
}

// The whole editor a caret sits in, when the focus is somewhere inside a rich
// text editor on a web page (a mail compose box is a contenteditable, and the
// focus can land on one paragraph of it). Web engines name that editor
// directly; otherwise it is the highest text area or group in the unbroken run
// of editable elements above the focus. Nil outside a web page, or when the
// focused element is the editor itself.
func editableRoot(_ el: AXUIElement) -> AXUIElement? {
    var chain: [(el: AXUIElement, role: String)] = []
    var inPage = false
    var cur = axElement(axAttr(el, "AXParent"))
    while let c = cur, chain.count < 64 {
        let role = axString(axAttr(c, "AXRole")) ?? ""
        if role == "AXWebArea" { inPage = true; break }
        if role == "AXWindow" || role == "AXApplication" { break }
        chain.append((c, role))
        cur = axElement(axAttr(c, "AXParent"))
    }
    guard inPage else { return nil }
    for name in ["AXHighestEditableAncestor", "AXEditableAncestor"] {
        if let named = axElement(axAttr(el, name)), !CFEqual(named, el),
           chain.contains(where: { CFEqual($0.el, named) }) { return named }
    }
    var root: AXUIElement? = nil
    for (a, role) in chain {
        if isEditable(a, role: role) {
            if editorRoles.contains(role) { root = a }
        } else if root != nil {
            break
        }
    }
    return root
}

func focusedText(_ app: AXUIElement) -> [String: Any] {
    guard let el = axElement(axAttr(app, "AXFocusedUIElement")) else { return ["text": ""] }
    if let s = axString(axAttr(el, "AXValue")), !s.isEmpty { return ["text": s, "via": "value"] }
    if let root = editableRoot(el) {
        if let s = axString(axAttr(root, "AXValue")), !s.isEmpty { return ["text": s, "via": "editable-root"] }
        let r = collect(root, maxNodes: 6000, maxSeconds: 1.5)
        if !r.texts.isEmpty { return ["text": r.texts.joined(separator: "\n"), "via": "editable-root"] }
    }
    // A rich editor (an email being written in a web view) keeps its words in
    // its children rather than its own value.
    let r = collect(el, maxNodes: 6000, maxSeconds: 1.5)
    return ["text": r.texts.joined(separator: "\n"), "via": "children"]
}

func axFocused(_ pidArg: String) throws -> Any {
    guard let app = try axApp(pidArg) else { return notTrusted }
    return withWebTree(app, pidArg, empty: { (($0["text"] as? String) ?? "").isEmpty }) { focusedText(app) }
}

// ── Commands ────────────────────────────────────────────────────────────────

let usage: [String: (count: Int, hint: String)] = [
    "front-doc": (0, ""), "front-window": (0, ""),
    "ax-window": (1, "<pid>"), "ax-focused": (1, "<pid>"), "ax-doc": (1, "<pid>"),
    "ocr": (1, "<image>"), "pdf-text": (1, "<pdf>"), "pdf-meta": (1, "<pdf>"),
    "pdf-stamp": (3, "<pdf> <code> <seal-url>"), "make-pdf": (2, "<text-file> <out.pdf>"),
]

func handle(_ cmd: String, _ a: [String]) throws -> Any {
    guard let u = usage[cmd] else { throw failure("unknown command \(cmd)") }
    guard a.count >= u.count else { throw failure("usage: inkk-helper \(cmd) \(u.hint)") }
    switch cmd {
    case "front-doc": return frontDoc()
    case "front-window": return frontWindow()
    case "ax-window": return try axWindow(a[0])
    case "ax-focused": return try axFocused(a[0])
    case "ax-doc": return try axDoc(a[0])
    case "ocr": return try ocr(a[0])
    case "pdf-text": return try pdfText(a[0])
    case "pdf-meta": return try pdfMeta(a[0])
    case "pdf-stamp": return try pdfStamp(a[0], a[1], a[2])
    default: return try makePDF(a[0], a[1])
    }
}

// ── serve ───────────────────────────────────────────────────────────────────
// Three lanes, each taking its requests in the order they arrive:
//   main   the front app and window. NSWorkspace only learns that another app
//          came to the front while the main run loop turns, so this lane is
//          the main queue and the run loop keeps turning between requests.
//   ax     reading a window's words, which can take a second or two.
//   files  pictures and PDFs, which can take longer still.
// So the 750 ms front-document poll is never stuck behind an OCR or a long
// page. Answers carry their request's id and may overtake one another across
// lanes, never within one.

let axLane = DispatchQueue(label: "site.inkk.helper.ax")
let filesLane = DispatchQueue(label: "site.inkk.helper.files")
let writeLock = NSLock()

func send(_ answer: [String: Any]) {
    var data = jsonData(answer)
    if data == nil {
        data = jsonData(["id": answer["id"] ?? NSNull(), "ok": false, "error": "answer is not JSON"] as [String: Any])
    }
    guard var line = data else { return }
    line.append(0x0A)
    writeLock.lock()
    FileHandle.standardOutput.write(line)
    writeLock.unlock()
}

func answer(_ id: Any, _ cmd: String, _ args: [String]) {
    autoreleasepool {
        do {
            send(["id": id, "ok": true, "result": try handle(cmd, args)])
        } catch let e as HelperError {
            send(["id": id, "ok": false, "error": e.message])
        } catch {
            send(["id": id, "ok": false, "error": "\(error)"])
        }
    }
}

func laneFor(_ cmd: String) -> DispatchQueue {
    switch cmd {
    case "front-doc", "front-window": return .main
    case "ax-window", "ax-focused", "ax-doc": return axLane
    default: return filesLane
    }
}

func dispatchRequest(_ line: String) {
    guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { return }
    guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)), let req = obj as? [String: Any] else {
        send(["id": NSNull(), "ok": false, "error": "bad request"]); return
    }
    let id = req["id"] ?? NSNull()
    guard let cmd = req["cmd"] as? String else { send(["id": id, "ok": false, "error": "no cmd"]); return }
    let args: [String] = ((req["args"] as? [Any]) ?? []).map { a in
        if let s = a as? String { return s }
        if let n = a as? NSNumber { return n.stringValue }
        return "\(a)"
    }
    guard usage[cmd] != nil else { send(["id": id, "ok": false, "error": "unknown command \(cmd)"]); return }
    laneFor(cmd).async { answer(id, cmd, args) }
}

func serve() -> Never {
    let reader = Thread {
        while let line = readLine(strippingNewline: true) { dispatchRequest(line) }
        // stdin closed: finish what was asked, then leave.
        let group = DispatchGroup()
        axLane.async(group: group) {}
        filesLane.async(group: group) {}
        group.notify(queue: .main) { exit(0) }
    }
    reader.start()
    RunLoop.main.add(Port(), forMode: .default)     // keeps the run loop turning with nothing to do
    while true { RunLoop.main.run(mode: .default, before: .distantFuture) }
}

// ── one shot ────────────────────────────────────────────────────────────────

let argv = CommandLine.arguments
guard argv.count >= 2 else {
    FileHandle.standardError.write(Data("usage: inkk-helper <command> …\n".utf8)); exit(1)
}
if argv[1] == "serve" { serve() }
do {
    let result = try handle(argv[1], Array(argv.dropFirst(2)))
    guard var data = jsonData(result) else { throw failure("answer is not JSON") }
    data.append(0x0A)
    FileHandle.standardOutput.write(data)
} catch let e as HelperError {
    FileHandle.standardError.write(Data((e.message + "\n").utf8)); exit(1)
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8)); exit(1)
}
