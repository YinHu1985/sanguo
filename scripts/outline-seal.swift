// Design-time vector export only. The shipped SVG never needs this font or macOS.
// Usage: swift scripts/outline-seal.swift <font-file> <output-svg>
import Foundation
import CoreText
import CoreGraphics

guard CommandLine.arguments.count == 3 else { fatalError("Expected font file and SVG path") }
let fontURL = URL(fileURLWithPath: CommandLine.arguments[1])
let svgURL = URL(fileURLWithPath: CommandLine.arguments[2])
guard let descriptors = CTFontManagerCreateFontDescriptorsFromURL(fontURL as CFURL) as? [CTFontDescriptor],
      let descriptor = descriptors.first else { fatalError("Cannot read font") }
let font = CTFontCreateWithFontDescriptor(descriptor, 46, nil)
func n(_ value: CGFloat) -> String { String(format: "%.2f", Double(value)) }
var marks: [String] = []
for (index, scalar) in "伍贰三国".unicodeScalars.enumerated() {
    var character = UniChar(scalar.value)
    var glyph = CGGlyph()
    guard CTFontGetGlyphsForCharacters(font, &character, &glyph, 1),
          let shape = CTFontCreatePathForGlyph(font, glyph, nil) else { fatalError("Missing seal glyph") }
    let bounds = shape.boundingBoxOfPath
    let centerX: CGFloat = index % 2 == 0 ? 55 : 105
    let centerY: CGFloat = index < 2 ? 56 : 105
    var transform = CGAffineTransform(a: 1, b: 0, c: 0, d: -1,
        tx: centerX - bounds.midX, ty: centerY + bounds.midY)
    let path = shape.copy(using: &transform)!
    var commands: [String] = []
    func point(_ p: CGPoint) -> String { "\(n(p.x)) \(n(p.y))" }
    path.applyWithBlock { pointer in
        let item = pointer.pointee
        switch item.type {
        case .moveToPoint: commands.append("M" + point(item.points[0]))
        case .addLineToPoint: commands.append("L" + point(item.points[0]))
        case .addQuadCurveToPoint: commands.append("Q" + point(item.points[0]) + " " + point(item.points[1]))
        case .addCurveToPoint: commands.append("C" + point(item.points[0]) + " " + point(item.points[1]) + " " + point(item.points[2]))
        case .closeSubpath: commands.append("Z")
        @unknown default: fatalError("Unsupported curve")
        }
    }
    marks.append("  <path id=\"seal-glyph-\(index)\" fill=\"#f4dca6\" d=\"\(commands.joined())\"/>")
}
var svg = try String(contentsOf: svgURL, encoding: .utf8)
let pattern = "(?s)<!-- seal-glyphs:start -->.*?<!-- seal-glyphs:end -->"
let replacement = "<!-- seal-glyphs:start -->\n" + marks.joined(separator: "\n") + "\n  <!-- seal-glyphs:end -->"
guard let range = svg.range(of: pattern, options: .regularExpression) else { fatalError("Missing glyph markers") }
svg.replaceSubrange(range, with: replacement)
try svg.write(to: svgURL, atomically: true, encoding: .utf8)
print("Outlined four seal glyphs; SVG has no font dependency.")
