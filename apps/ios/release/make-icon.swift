// Draws the Iris Workplace app icon and writes every size the asset catalog needs.
//
//   DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift release/make-icon.swift
//
// One master (1024 x 1024, opaque, no alpha) is drawn with CoreGraphics; every other size is a
// high-quality downscale of that master. Output goes to
// IrisWorkplace/Resources/Assets.xcassets/AppIcon.appiconset/ together with its Contents.json.
//
// The mark: the Workplace's three tiles (two desks and the floor: the app's Office grid) in the
// Iris palette, the same night navy and sky blue as the Iris app icon, so the two sit as a family
// on the home screen. No text, no gradients that bleed at 40 px, no transparency.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let scriptDir = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
let iosDir = scriptDir.deletingLastPathComponent()
let outDir = iosDir.appendingPathComponent("IrisWorkplace/Resources/Assets.xcassets/AppIcon.appiconset")

func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> CGColor {
    CGColor(colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, components: [r / 255, g / 255, b / 255, 1])!
}

// Palette (from the Iris app icon: night navy field, sky-blue body, pale-blue belly).
let navyTop = rgb(19, 26, 44)
let navyBottom = rgb(10, 14, 27)
let skyTop = rgb(126, 214, 255)
let skyBottom = rgb(84, 184, 255)
let paleTop = rgb(226, 244, 255)
let paleBottom = rgb(180, 226, 255)
let glow = rgb(84, 184, 255)

func drawMaster(size: CGFloat) -> CGImage {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: Int(size), height: Int(size), bitsPerComponent: 8, bytesPerRow: 0,
                        space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    let s = size / 1024

    // Field: vertical navy gradient.
    let field = CGGradient(colorsSpace: space, colors: [navyTop, navyBottom] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(field, start: CGPoint(x: 0, y: size), end: CGPoint(x: 0, y: 0), options: [])

    // Soft sky-blue halo behind the tiles, like the Iris icon's glow.
    let halo = CGGradient(colorsSpace: space,
                          colors: [glow.copy(alpha: 0.28)!, glow.copy(alpha: 0.0)!] as CFArray,
                          locations: [0, 1])!
    ctx.drawRadialGradient(halo, startCenter: CGPoint(x: size / 2, y: size / 2), startRadius: 0,
                           endCenter: CGPoint(x: size / 2, y: size / 2), endRadius: 470 * s, options: [])

    // Tiles. Coordinates in the 1024 master space; CoreGraphics' origin is bottom-left.
    func tile(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ top: CGColor, _ bottom: CGColor) {
        let r = CGRect(x: x * s, y: (1024 - y - h) * s, width: w * s, height: h * s)
        let path = CGPath(roundedRect: r, cornerWidth: 64 * s, cornerHeight: 64 * s, transform: nil)
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -10 * s), blur: 28 * s,
                      color: CGColor(colorSpace: space, components: [0, 0, 0, 0.35]))
        ctx.addPath(path)
        ctx.setFillColor(top)
        ctx.fillPath()
        ctx.restoreGState()
        ctx.saveGState()
        ctx.addPath(path)
        ctx.clip()
        let g = CGGradient(colorsSpace: space, colors: [top, bottom] as CFArray, locations: [0, 1])!
        ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: r.maxY), end: CGPoint(x: 0, y: r.minY), options: [])
        ctx.restoreGState()
    }
    let m: CGFloat = 232, gap: CGFloat = 40
    let half = (1024 - 2 * m - gap) / 2          // 260
    tile(m, m, half, half, paleTop, paleBottom)  // the owner's desk: pale, like the belly
    tile(m + half + gap, m, half, half, skyTop, skyBottom)
    tile(m, m + half + gap, 1024 - 2 * m, half, skyTop, skyBottom)

    return ctx.makeImage()!
}

func scaled(_ master: CGImage, to px: Int) -> CGImage {
    if master.width == px { return master }
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0,
                        space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.interpolationQuality = .high
    ctx.draw(master, in: CGRect(x: 0, y: 0, width: px, height: px))
    return ctx.makeImage()!
}

func writePNG(_ image: CGImage, to url: URL) {
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("could not write \(url.path)") }
}

// (idiom, points, scale). Every slot the iOS icon set lists, plus the App Store marketing icon.
let slots: [(String, String, Int)] = [
    ("iphone", "20x20", 2), ("iphone", "20x20", 3),
    ("iphone", "29x29", 2), ("iphone", "29x29", 3),
    ("iphone", "40x40", 2), ("iphone", "40x40", 3),
    ("iphone", "60x60", 2), ("iphone", "60x60", 3),
    ("ipad", "20x20", 1), ("ipad", "20x20", 2),
    ("ipad", "29x29", 1), ("ipad", "29x29", 2),
    ("ipad", "40x40", 1), ("ipad", "40x40", 2),
    ("ipad", "76x76", 1), ("ipad", "76x76", 2),
    ("ipad", "83.5x83.5", 2),
    ("ios-marketing", "1024x1024", 1),
]

let fm = FileManager.default
try? fm.removeItem(at: outDir)
try fm.createDirectory(at: outDir, withIntermediateDirectories: true)
let master = drawMaster(size: 1024)

var images: [[String: String]] = []
var written = Set<String>()
for (idiom, size, scale) in slots {
    let points = Double(size.split(separator: "x")[0])!
    let px = Int((points * Double(scale)).rounded())
    let name = idiom == "ios-marketing" ? "icon-1024.png" : "icon-\(size)@\(scale)x.png"
    if !written.contains(name) {
        writePNG(scaled(master, to: px), to: outDir.appendingPathComponent(name))
        written.insert(name)
    }
    images.append(["filename": name, "idiom": idiom, "scale": "\(scale)x", "size": size])
}
let contents: [String: Any] = ["images": images, "info": ["author": "release/make-icon.swift", "version": 1]]
let json = try JSONSerialization.data(withJSONObject: contents, options: [.prettyPrinted, .sortedKeys])
try json.write(to: outDir.appendingPathComponent("Contents.json"))
print("wrote \(written.count) icons to \(outDir.path)")
