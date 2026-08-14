// Draw text with CoreText, so the app's own shaper can be measured.
//
// The captions are drawn by the app's webview, and on macOS that webview is
// WebKit, which shapes with CoreText. Chrome shapes with HarfBuzz. Both are
// expected to be right, but "expected to be right" is exactly what was believed
// about the two renderers that turned out to be wrong, so this draws the same
// probes through CoreText itself and lets the measurement decide.
//
//   swift scripts/coretext-probe.swift <font.ttf> <out-dir> <text> [text...]
//
// Each string is written twice: shaped, and with every character laid out one
// after another with no reordering, which is the control.
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 4 else {
    FileHandle.standardError.write("usage: coretext-probe <font.ttf> <out-dir> <text>...\n".data(using: .utf8)!)
    exit(2)
}
let fontPath = args[1]
let outDir = args[2]
let strings = Array(args[3...])

let fontSize: CGFloat = 96
let height = Int(fontSize * 2)
let baseline = fontSize * 0.7
let leftPad: CGFloat = 40

guard let data = FileManager.default.contents(atPath: fontPath),
      let provider = CGDataProvider(data: data as CFData),
      let cgFont = CGFont(provider) else {
    FileHandle.standardError.write("could not load \(fontPath)\n".data(using: .utf8)!)
    exit(1)
}
let font = CTFontCreateWithGraphicsFont(cgFont, fontSize, nil, nil)

func line(_ s: String) -> CTLine {
    let attrs: [NSAttributedString.Key: Any] = [kCTFontAttributeName as NSAttributedString.Key: font]
    return CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: attrs))
}

func draw(_ text: String, unshaped: Bool, to path: String) {
    let width: Int
    if unshaped {
        var w: CGFloat = 0
        // Unicode scalars, not Characters: Swift's Character is a grapheme
        // cluster, so "কে" is one of them and looping over it would shape the
        // whole cluster — producing the correct output and a control that
        // never tests anything.
        for ch in text.unicodeScalars {
            w += CGFloat(CTLineGetTypographicBounds(line(String(ch)), nil, nil, nil))
        }
        width = Int(w + leftPad * 2)
    } else {
        width = Int(CGFloat(CTLineGetTypographicBounds(line(text), nil, nil, nil)) + leftPad * 2)
    }

    guard let ctx = CGContext(
        data: nil, width: max(width, 1), height: height, bitsPerComponent: 8,
        bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return }

    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))

    if unshaped {
        // One character at a time, each placed after the last: nothing is
        // reordered and no mark is repositioned. What a renderer with no
        // shaper produces.
        var x = leftPad
        for ch in text.unicodeScalars {
            let l = line(String(ch))
            ctx.textPosition = CGPoint(x: x, y: baseline)
            CTLineDraw(l, ctx)
            x += CGFloat(CTLineGetTypographicBounds(l, nil, nil, nil))
        }
    } else {
        ctx.textPosition = CGPoint(x: leftPad, y: baseline)
        CTLineDraw(line(text), ctx)
    }

    guard let image = ctx.makeImage(),
          let dest = CGImageDestinationCreateWithURL(
              URL(fileURLToPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil
          ) else { return }
    CGImageDestinationAddImage(dest, image, nil)
    CGImageDestinationFinalize(dest)
}

extension URL {
    init(fileURLToPath path: String) { self.init(fileURLWithPath: path) }
}

var written: [String: String] = [:]
for s in strings {
    for unshaped in [false, true] {
        let key = (unshaped ? "raw:" : "ok:") + s
        let path = outDir + "/" + Data(key.utf8).map { String(format: "%02x", $0) }.joined() + ".png"
        draw(s, unshaped: unshaped, to: path)
        written[key] = path
    }
}
let json = try! JSONSerialization.data(withJSONObject: written)
FileHandle.standardOutput.write(json)
