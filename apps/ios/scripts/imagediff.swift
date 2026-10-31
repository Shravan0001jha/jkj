// Pixel diff of two PNG screenshots (the theme work's "Default is unchanged" proof).
//   swift scripts/imagediff.swift a.png b.png [--ignore-top <px>] [--mask out.png]
// Prints "<differing pixels> <total pixels> bbox=x,y,w,h" (bbox "-" when identical) and exits 0
// when identical, 1 when not, 2 on a size mismatch or unreadable file. --ignore-top skips the
// status bar band (the clock); --mask writes the differing pixels in red over a dimmed copy of a.
import AppKit
import CoreGraphics
import Foundation

func rgba(_ path: String) -> (w: Int, h: Int, px: [UInt8])? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
    let w = img.width, h = img.height
    var px = [UInt8](repeating: 0, count: w * h * 4)
    let ok = px.withUnsafeMutableBytes { buf -> Bool in
        guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        return true
    }
    return ok ? (w, h, px) : nil
}

var args = Array(CommandLine.arguments.dropFirst())
var ignoreTop = 0
var maskPath: String?
if let i = args.firstIndex(of: "--ignore-top") { ignoreTop = Int(args[i + 1]) ?? 0; args.removeSubrange(i...(i + 1)) }
if let i = args.firstIndex(of: "--mask") { maskPath = args[i + 1]; args.removeSubrange(i...(i + 1)) }
guard args.count == 2, let a = rgba(args[0]), let b = rgba(args[1]) else { print("unreadable"); exit(2) }
guard a.w == b.w, a.h == b.h else { print("size \(a.w)x\(a.h) vs \(b.w)x\(b.h)"); exit(2) }

var diff = 0
var minX = Int.max, minY = Int.max, maxX = -1, maxY = -1
var mask = a.px
for y in 0..<a.h {
    for x in 0..<a.w {
        let o = (y * a.w + x) * 4
        let same = a.px[o] == b.px[o] && a.px[o + 1] == b.px[o + 1] && a.px[o + 2] == b.px[o + 2] && a.px[o + 3] == b.px[o + 3]
        // CGContext draws with a bottom-left origin, so row 0 of the buffer is the image's top row.
        if !same && y >= ignoreTop {
            diff += 1
            minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
            mask[o] = 255; mask[o + 1] = 0; mask[o + 2] = 0; mask[o + 3] = 255
        } else {
            mask[o] /= 3; mask[o + 1] /= 3; mask[o + 2] /= 3
        }
    }
}
let bbox = diff == 0 ? "-" : "\(minX),\(minY),\(maxX - minX + 1),\(maxY - minY + 1)"
print("\(diff) \(a.w * a.h) bbox=\(bbox)")
if let maskPath, diff > 0 {
    mask.withUnsafeMutableBytes { buf in
        if let ctx = CGContext(data: buf.baseAddress, width: a.w, height: a.h, bitsPerComponent: 8, bytesPerRow: a.w * 4,
                               space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
           let img = ctx.makeImage(), let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: maskPath) as CFURL, "public.png" as CFString, 1, nil) {
            CGImageDestinationAddImage(dest, img, nil)
            CGImageDestinationFinalize(dest)
        }
    }
}
exit(diff == 0 ? 0 : 1)
