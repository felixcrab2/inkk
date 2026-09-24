// inkk-helper — the few things the companion needs from macOS that Node can't
// reach: which window is in front, the words in a picture (Vision), and the
// text and metadata of a PDF (PDFKit). One command per run, JSON on stdout.
//
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
// Everything stays on this Mac. The helper runs as a child of the companion, so
// macOS attributes its permissions (Screen Recording, Accessibility) to inkk.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import PDFKit
import Vision

func emit(_ value: Any) {
    let data = (try? JSONSerialization.data(withJSONObject: value, options: [])) ?? Data("null".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

// The frontmost app's frontmost ordinary window (layer 0), front to back.
func frontWindow() {
    guard let app = NSWorkspace.shared.frontmostApplication else { emit(NSNull()); return }
    let pid = app.processIdentifier
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { emit(NSNull()); return }
    for w in list {
        guard (w[kCGWindowOwnerPID as String] as? Int32) == pid,
              (w[kCGWindowLayer as String] as? Int) == 0,
              let id = w[kCGWindowNumber as String] as? Int,
              let b = w[kCGWindowBounds as String] as? [String: Any] else { continue }
        let width = (b["Width"] as? Double) ?? 0, height = (b["Height"] as? Double) ?? 0
        if width < 80 || height < 60 { continue }
        if let alpha = w[kCGWindowAlpha as String] as? Double, alpha <= 0 { continue }
        emit([
            "id": id,
            "pid": Int(pid),
            "owner": (w[kCGWindowOwnerName as String] as? String) ?? (app.localizedName ?? ""),
            "bundleId": app.bundleIdentifier ?? "",
            "title": (w[kCGWindowName as String] as? String) ?? "",
            "bounds": ["x": (b["X"] as? Double) ?? 0, "y": (b["Y"] as? Double) ?? 0, "w": width, "h": height],
        ])
        return
    }
    emit(NSNull())
}

func cgImage(at path: String) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

// Lines of text in an image, top to bottom, with their boxes in pixels.
func ocr(_ path: String) {
    guard let image = cgImage(at: path) else { fail("unreadable image") }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.recognitionLanguages = ["en-GB", "en-US"]
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do { try handler.perform([request]) } catch { fail("ocr failed: \(error.localizedDescription)") }
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
    emit(lines)
}

func openPDF(_ path: String) -> PDFDocument {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else { fail("unreadable pdf") }
    if doc.isLocked { fail("locked pdf") }
    return doc
}

func pdfText(_ path: String) {
    let doc = openPDF(path)
    var pages: [String] = []
    for i in 0..<doc.pageCount { if let s = doc.page(at: i)?.string { pages.append(s) } }
    emit(["text": pages.joined(separator: "\n\n"), "pages": doc.pageCount])
}

func keywordsOf(_ doc: PDFDocument) -> [String] {
    let v = doc.documentAttributes?[PDFDocumentAttribute.keywordsAttribute]
    if let a = v as? [String] { return a }
    if let s = v as? String { return s.split(whereSeparator: { $0 == "," || $0 == ";" }).map { $0.trimmingCharacters(in: .whitespaces) } }
    return []
}

func pdfMeta(_ path: String) {
    let doc = openPDF(path)
    let attrs = doc.documentAttributes ?? [:]
    emit([
        "keywords": keywordsOf(doc),
        "subject": (attrs[PDFDocumentAttribute.subjectAttribute] as? String) ?? "",
        "title": (attrs[PDFDocumentAttribute.titleAttribute] as? String) ?? "",
        "author": (attrs[PDFDocumentAttribute.authorAttribute] as? String) ?? "",
        "pages": doc.pageCount,
    ])
}

// Adds "inkk:<CODE>" and the seal link to the PDF's keywords. Written to a
// temporary file first and only swapped in when it opens again with the same
// pages, so a PDF is never left half-written.
func pdfStamp(_ path: String, _ code: String, _ seal: String) {
    let url = URL(fileURLWithPath: path)
    let doc = openPDF(path)
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
    guard doc.write(to: tmp) else { emit(["ok": false, "error": "write failed"]); return }
    guard let check = PDFDocument(url: tmp), check.pageCount == pages,
          keywordsOf(check).contains("inkk:\(code)") else {
        try? fm.removeItem(at: tmp)
        emit(["ok": false, "error": "stamped copy did not verify"]); return
    }
    let before = try? fm.attributesOfItem(atPath: path)
    do {
        _ = try fm.replaceItemAt(url, withItemAt: tmp)
    } catch {
        try? fm.removeItem(at: tmp)
        emit(["ok": false, "error": "replace failed: \(error.localizedDescription)"]); return
    }
    if let before = before {
        var keep: [FileAttributeKey: Any] = [:]
        if let p = before[.posixPermissions] { keep[.posixPermissions] = p }
        if let m = before[.modificationDate] { keep[.modificationDate] = m }
        try? fm.setAttributes(keep, ofItemAtPath: path)
    }
    emit(["ok": true])
}

// A plain one-column PDF of a text file, for the tests.
func makePDF(_ textPath: String, _ outPath: String) {
    guard let text = try? String(contentsOfFile: textPath, encoding: .utf8) else { fail("unreadable text") }
    var box = CGRect(x: 0, y: 0, width: 595, height: 842)
    guard let ctx = CGContext(URL(fileURLWithPath: outPath) as CFURL, mediaBox: &box, nil) else { fail("cannot create pdf") }
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
    emit(["ok": true])
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

func axApp(_ pidArg: String) -> AXUIElement? {
    guard AXIsProcessTrusted() else { emit(["error": "not trusted"]); return nil }
    guard let pid = Int32(pidArg) else { fail("bad pid") }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1.0)
    // Chromium and Electron apps build their accessibility tree only when asked.
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    return app
}

let readAttrs = ["AXRole", "AXValue", "AXTitle", "AXDescription", "AXURL", "AXHelp", "AXChildren"] as CFArray

// Breadth-first over the window, bounded in elements and time so a huge page
// can't stall the companion. Returns text in reading order, links, and image
// descriptions (a signed email's picture carries its seal in its description).
func collect(_ root: AXUIElement, maxNodes: Int, maxSeconds: Double) -> (texts: [String], links: [String], images: [String], truncated: Bool) {
    var texts: [String] = [], links: [String] = [], images: [String] = []
    var queue: [AXUIElement] = [root]
    var head = 0, seen = 0
    let deadline = Date().addingTimeInterval(maxSeconds)
    var truncated = false
    while head < queue.count {
        if seen >= maxNodes || Date() > deadline { truncated = true; break }
        let el = queue[head]; head += 1; seen += 1
        var values: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(el, readAttrs, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
              let v = values as? [AnyObject], v.count == 7 else { continue }
        let role = (v[0] as? String) ?? ""
        let value = axString(v[1]), title = axString(v[2]), desc = axString(v[3]), url = axString(v[4])
        if role == "AXImage" {
            for s in [desc, title, axString(v[5])] { if let s = s, !s.isEmpty { images.append(s) } }
        } else {
            if let s = value, !s.isEmpty, role != "AXScrollBar", role != "AXSlider" { texts.append(s) }
            else if let s = title, !s.isEmpty, role == "AXStaticText" || role == "AXLink" || role == "AXHeading" { texts.append(s) }
            if let s = desc, !s.isEmpty, role == "AXLink" || role == "AXStaticText" || role == "AXGroup" { texts.append(s) }
        }
        if let u = url, !u.isEmpty { links.append(u) }
        if let kids = v[6] as? [AXUIElement] { queue.append(contentsOf: kids) }
    }
    return (texts, links, images, truncated)
}

func axWindow(_ pidArg: String) {
    guard let app = axApp(pidArg) else { return }
    guard let win = (axAttr(app, "AXFocusedWindow") ?? axAttr(app, "AXMainWindow")) else { emit(["error": "no window"]); return }
    let w = win as! AXUIElement
    let r = collect(w, maxNodes: 8000, maxSeconds: 1.5)
    emit([
        "title": axString(axAttr(w, "AXTitle")) ?? "",
        "document": axString(axAttr(w, "AXDocument")) ?? "",
        "text": r.texts.joined(separator: "\n"),
        "links": Array(Set(r.links)),
        "images": r.images,
        "truncated": r.truncated,
    ])
}

func axDoc(_ pidArg: String) {
    guard let app = axApp(pidArg) else { return }
    guard let win = (axAttr(app, "AXFocusedWindow") ?? axAttr(app, "AXMainWindow")) else { emit(["error": "no window"]); return }
    let w = win as! AXUIElement
    emit(["title": axString(axAttr(w, "AXTitle")) ?? "", "document": axString(axAttr(w, "AXDocument")) ?? ""])
}

func axFocused(_ pidArg: String) {
    guard let app = axApp(pidArg) else { return }
    guard let f = axAttr(app, "AXFocusedUIElement") else { emit(["text": ""]); return }
    let el = f as! AXUIElement
    if let s = axString(axAttr(el, "AXValue")), s.count >= 1 { emit(["text": s, "via": "value"]); return }
    // A rich editor (an email being written in a web view) keeps its words in
    // its children rather than its own value.
    let r = collect(el, maxNodes: 6000, maxSeconds: 1.5)
    emit(["text": r.texts.joined(separator: "\n"), "via": "children"])
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: inkk-helper <command> …") }
switch args[1] {
case "front-window": frontWindow()
case "ax-window" where args.count >= 3: axWindow(args[2])
case "ax-focused" where args.count >= 3: axFocused(args[2])
case "ax-doc" where args.count >= 3: axDoc(args[2])
case "ocr" where args.count >= 3: ocr(args[2])
case "pdf-text" where args.count >= 3: pdfText(args[2])
case "pdf-meta" where args.count >= 3: pdfMeta(args[2])
case "pdf-stamp" where args.count >= 5: pdfStamp(args[2], args[3], args[4])
case "make-pdf" where args.count >= 4: makePDF(args[2], args[3])
default: fail("unknown command \(args[1])")
}
