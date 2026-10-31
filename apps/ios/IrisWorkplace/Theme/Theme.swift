import SwiftUI
import Observation

// docs/THEMES.md §2. A theme is one value: tokens plus optional chrome. Default's tokens are the
// literals the screens used before themes existed, and it has no chrome, so every themed modifier
// is an identity for it.

enum ThemeID: String, CaseIterable, Identifiable, Codable {
    case `default`, scifi
    var id: String { rawValue }
}

/// Sci-fi CX features (§3). Default has none, so it never builds them.
enum ThemeFeature: String, CaseIterable, Hashable {
    case bridge, decisionQueue, commandPalette, quickReplies, transmission, haptics, boot, heroTransition
}

struct ThemePalette: Equatable {
    var accent: Color
    var accent2: Color
    var accent3: Color
    /// nil: the system's `.primary` / `.secondary` (Default).
    var textPrimary: Color?
    var textSecondary: Color?
}

struct ThemeType: Equatable {
    var sectionHeader: Font
    var sectionHeaderUppercase: Bool
    var sectionHeaderTracking: CGFloat
    /// nil: `.secondary` (Default).
    var sectionHeaderColor: Color?
    var monospacedTimes: Bool
}

struct ThemeRadii: Equatable {
    var card: CGFloat
    var bubble: CGFloat
    var bubbleTight: CGFloat
    var composer: CGFloat
    var quote: CGFloat
    var pillPadding: (h: CGFloat, v: CGFloat)
    var progressHeight: CGFloat

    static func == (a: ThemeRadii, b: ThemeRadii) -> Bool {
        a.card == b.card && a.bubble == b.bubble && a.bubbleTight == b.bubbleTight && a.composer == b.composer
            && a.quote == b.quote && a.pillPadding == b.pillPadding && a.progressHeight == b.progressHeight
    }
}

struct ThemeMotion: Equatable {
    /// Ambient effects (starfield, radar, pings). Off for Default.
    var ambient: Bool
    var spring: Animation
}

struct Theme: Identifiable, Equatable {
    let id: ThemeID
    let name: String
    let palette: ThemePalette
    let type: ThemeType
    let radii: ThemeRadii
    let motion: ThemeMotion
    /// nil: follow the system appearance.
    let colorScheme: ColorScheme?
    /// nil: no `.tint` (the asset AccentColor applies).
    let tint: Color?
    let features: Set<ThemeFeature>
    /// The view-builder hooks for the theme's chrome. nil: system chrome, untouched.
    let chrome: (any ThemeChrome)?

    func has(_ f: ThemeFeature) -> Bool { features.contains(f) }
    var hasChrome: Bool { chrome != nil }

    static func == (a: Theme, b: Theme) -> Bool { a.id == b.id }

    static let all: [Theme] = [.default, .scifi]
    static func with(_ id: ThemeID) -> Theme { all.first { $0.id == id } ?? .default }

    /// Today's look, token for token.
    static let `default` = Theme(
        id: .default, name: "Default",
        palette: ThemePalette(accent: .accentColor, accent2: .accentColor, accent3: .accentColor, textPrimary: nil, textSecondary: nil),
        type: ThemeType(sectionHeader: .subheadline.weight(.semibold), sectionHeaderUppercase: false, sectionHeaderTracking: 0,
                        sectionHeaderColor: nil, monospacedTimes: false),
        radii: ThemeRadii(card: 14, bubble: 18, bubbleTight: 6, composer: 20, quote: 8, pillPadding: (8, 3), progressHeight: 6),
        motion: ThemeMotion(ambient: false, spring: .snappy),
        colorScheme: nil, tint: nil, features: [], chrome: nil)

    static let scifi = Theme(
        id: .scifi, name: "Sci-fi",
        palette: ThemePalette(accent: SciFiPalette.accent.color, accent2: SciFiPalette.accent2.color, accent3: SciFiPalette.accent3.color,
                              textPrimary: SciFiPalette.textPrimary.color, textSecondary: SciFiPalette.textSecondary.color),
        type: ThemeType(sectionHeader: .caption.monospaced().weight(.semibold), sectionHeaderUppercase: true, sectionHeaderTracking: 1.6,
                        sectionHeaderColor: SciFiPalette.accent.color, monospacedTimes: true),
        radii: ThemeRadii(card: 16, bubble: 14, bubbleTight: 3, composer: 12, quote: 4, pillPadding: (8, 3), progressHeight: 6),
        motion: ThemeMotion(ambient: true, spring: .spring(response: 0.42, dampingFraction: 0.78)),
        colorScheme: .dark, tint: SciFiPalette.accent.color, features: Set(ThemeFeature.allCases), chrome: SciFiChrome())
}

// MARK: - Sci-fi palette (explicit sRGB so contrast is testable)

struct RGB: Equatable {
    var r: Double, g: Double, b: Double

    init(r: Double, g: Double, b: Double) { self.r = r; self.g = g; self.b = b }
    init(hex: UInt32) {
        r = Double((hex >> 16) & 0xFF) / 255; g = Double((hex >> 8) & 0xFF) / 255; b = Double(hex & 0xFF) / 255
    }

    var color: Color { Color(.sRGB, red: r, green: g, blue: b) }
    func color(_ opacity: Double) -> Color { Color(.sRGB, red: r, green: g, blue: b, opacity: opacity) }

    /// WCAG relative luminance.
    var luminance: Double {
        func lin(_ c: Double) -> Double { c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    }

    func contrast(with o: RGB) -> Double {
        let (a, b) = (luminance, o.luminance)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    /// This colour at `alpha` over `base`.
    func over(_ base: RGB, alpha: Double) -> RGB {
        RGB(r: r * alpha + base.r * (1 - alpha), g: g * alpha + base.g * (1 - alpha), b: b * alpha + base.b * (1 - alpha))
    }
}

enum SciFiPalette {
    static let backgroundTop = RGB(hex: 0x04060E)
    static let backgroundBottom = RGB(hex: 0x0B1430)
    static let nebulaViolet = RGB(hex: 0x3A1D7A)
    static let nebulaCyan = RGB(hex: 0x0A4D6E)
    static let surface = RGB(hex: 0x12234A)
    static let surfaceAlpha = 0.55
    static let mineBubble = RGB(hex: 0x0E5A78)
    static let mineBubbleAlpha = 0.85
    static let textPrimary = RGB(hex: 0xE8F6FF)
    static let textSecondary = RGB(hex: 0x9FB7CC)
    static let accent = RGB(hex: 0x38E8FF)
    static let accent2 = RGB(hex: 0xB98AFF)
    static let accent3 = RGB(hex: 0xFF6FE0)
    static let grid = RGB(hex: 0x38E8FF)
}

// MARK: - Motion

enum MotionLevel: Int, Comparable {
    case off, reduced, full
    static func < (a: MotionLevel, b: MotionLevel) -> Bool { a.rawValue < b.rawValue }

    /// Reduce Motion → static or a fade; Low Power Mode → effects off; Default → none.
    static func resolve(theme: Theme, reduceMotion: Bool, lowPower: Bool) -> MotionLevel {
        guard theme.motion.ambient, !lowPower else { return .off }
        return reduceMotion ? .reduced : .full
    }
}

/// The motion catalogue (§2.4): what each effect may do at each level.
enum MotionEffect: CaseIterable {
    case starfield, holoShimmer, radar, presencePing, lockIn, transmission, typing, tabSweep, boot

    /// Any animation at all (a fade counts).
    func animates(at level: MotionLevel) -> Bool {
        switch level {
        case .off: return false
        case .full: return true
        case .reduced: return [.lockIn, .transmission, .boot].contains(self)
        }
    }
    /// Repeats forever (ambient).
    func loops(at level: MotionLevel) -> Bool {
        level == .full && [.starfield, .holoShimmer, .radar, .presencePing, .typing].contains(self)
    }
    /// Moves, scales or sweeps (more than a fade).
    func moves(at level: MotionLevel) -> Bool { level == .full }
}

// MARK: - Store

@MainActor @Observable
final class ThemeStore {
    static let key = "iris.theme"
    static let soundsKey = "iris.theme.sounds"

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let overridden: Bool

    var selected: ThemeID {
        didSet { if !overridden { defaults.set(selected.rawValue, forKey: Self.key) } }
    }
    var uiSounds: Bool { didSet { defaults.set(uiSounds, forKey: Self.soundsKey) } }
    var theme: Theme { Theme.with(selected) }

    init(defaults: UserDefaults = .standard, env: [String: String] = ProcessInfo.processInfo.environment) {
        self.defaults = defaults
        var forced: ThemeID?
        #if DEBUG
        // Scripted runs (screenshots, UI tests) pick a theme without changing the owner's choice.
        forced = env["WORKPLACE_THEME"].flatMap(ThemeID.init(rawValue:))
        #endif
        overridden = forced != nil
        selected = forced ?? defaults.string(forKey: Self.key).flatMap(ThemeID.init(rawValue:)) ?? .default
        uiSounds = defaults.bool(forKey: Self.soundsKey)
    }
}

// MARK: - Environment

private struct ThemeKey: EnvironmentKey { static let defaultValue = Theme.default }
private struct MotionKey: EnvironmentKey { static let defaultValue = MotionLevel.off }
private struct ThemeStoreKey: EnvironmentKey { static let defaultValue: ThemeStore? = nil }

extension EnvironmentValues {
    var theme: Theme {
        get { self[ThemeKey.self] }
        set { self[ThemeKey.self] = newValue }
    }
    var motionLevel: MotionLevel {
        get { self[MotionKey.self] }
        set { self[MotionKey.self] = newValue }
    }
    var themeStore: ThemeStore? {
        get { self[ThemeStoreKey.self] }
        set { self[ThemeStoreKey.self] = newValue }
    }
}
