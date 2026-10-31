import XCTest
@testable import IrisWorkplace

/// WCAG 2.x AA: body text needs 4.5:1. The Sci-fi palette is checked on every surface it sits on:
/// both stops of the space gradient and the holo-glass card composited over the lighter stop.
final class SciFiContrastTests: XCTestCase {
    func testContrastFormulaMatchesKnownValues() {
        XCTAssertEqual(RGB(hex: 0x000000).contrast(with: RGB(hex: 0xFFFFFF)), 21, accuracy: 0.01)
        XCTAssertEqual(RGB(hex: 0x777777).contrast(with: RGB(hex: 0xFFFFFF)), 4.48, accuracy: 0.02)
        XCTAssertEqual(RGB(hex: 0xFFFFFF).contrast(with: RGB(hex: 0xFFFFFF)), 1, accuracy: 0.001)
    }

    func testCompositeOverIsAlphaBlend() {
        let c = RGB(hex: 0xFFFFFF).over(RGB(hex: 0x000000), alpha: 0.5)
        XCTAssertEqual(c.r, 0.5, accuracy: 0.001)
    }

    func testBodyTextAndAccentReachAAOnEverySciFiSurface() {
        let p = SciFiPalette.self
        let surfaces: [(String, RGB)] = [
            ("background top", p.backgroundTop),
            ("background bottom", p.backgroundBottom),
            ("card over background", p.surface.over(p.backgroundBottom, alpha: p.surfaceAlpha)),
            ("mine bubble", p.mineBubble.over(p.backgroundBottom, alpha: p.mineBubbleAlpha)),
        ]
        let texts: [(String, RGB, Double)] = [
            ("primary text", p.textPrimary, 7.0),     // AAA for body copy
            ("secondary text", p.textSecondary, 4.5),
            ("accent", p.accent, 4.5),
            ("violet", p.accent2, 4.5),
            ("magenta", p.accent3, 4.5),
        ]
        for (sName, s) in surfaces {
            for (tName, t, min) in texts {
                // The bubble only ever carries primary text.
                if sName == "mine bubble" && tName != "primary text" { continue }
                let ratio = t.contrast(with: s)
                XCTAssertGreaterThanOrEqual(ratio, min, "\(tName) on \(sName) is \(String(format: "%.2f", ratio)):1")
            }
        }
    }
}
