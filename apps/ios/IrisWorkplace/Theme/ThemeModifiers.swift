import SwiftUI
import AudioToolbox

// docs/THEMES.md §2.2 — the only theming API the screens use. For a theme without chrome
// (Default) each modifier is an identity: it passes SwiftUI's own default value or the exact call
// it replaces, so Default renders as it did before themes existed.

/// The view-builder hooks a theme supplies for its chrome. A new theme conforms once; no screen changes.
protocol ThemeChrome {
    /// Behind every list and scroll view.
    func backdrop(motion: MotionLevel, live: Bool) -> AnyView
    /// Behind each list row.
    func rowBackground() -> AnyView
    /// A card (question box, COO note, banner) of the given corner radius.
    func card(radius: CGFloat, accent: Color?) -> AnyView
    /// A bar (connection strip, composer, segmented header).
    func bar() -> AnyView
    /// A chat bubble's fill and its edge.
    func bubbleFill(mine: Bool) -> AnyShapeStyle
    func bubbleEdge(mine: Bool) -> AnyShapeStyle
    /// The chat background.
    func wallpaper(motion: MotionLevel, live: Bool) -> AnyView
    /// Over the tab bar: the dock glow and its selection indicator.
    func tabChrome(index: Int, count: Int, motion: MotionLevel) -> AnyView
    /// The launch micro-animation (never blocks; tap-through).
    func boot(motion: MotionLevel) -> AnyView
    /// The separator tint for list rows.
    var separator: Color { get }
}

// MARK: - Root

extension View {
    /// Injects the theme, the motion level and the store; applies the theme's scheme and tint.
    func themeRoot(_ store: ThemeStore, boot: Bool = true) -> some View { modifier(ThemeRoot(store: store, boot: boot)) }
}

struct ThemeRoot: ViewModifier {
    let store: ThemeStore
    let boot: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled

    func body(content: Content) -> some View {
        let theme = store.theme
        let motion = MotionLevel.resolve(theme: theme, reduceMotion: reduceMotion, lowPower: lowPower)
        content
            .environment(\.theme, theme)
            .environment(\.motionLevel, motion)
            .environment(\.themeStore, store)
            .tint(theme.tint)
            .preferredColorScheme(theme.colorScheme)
            .overlay {
                if boot, theme.has(.boot), let chrome = theme.chrome, !BootOnce.done {
                    chrome.boot(motion: motion).allowsHitTesting(false).accessibilityHidden(true)
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)) { _ in
                lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
            }
    }
}

/// The boot animation plays once per process (a cold launch), never on a theme switch.
@MainActor enum BootOnce { static var done = false }

// MARK: - Lists, rows, cards, bars

extension View {
    /// A List or ScrollView: the theme's backdrop behind it.
    func themedList(live: Bool = true) -> some View { modifier(ThemedList(live: live)) }
    /// A full screen that is not a list (sign-in, offline states): the backdrop, edge to edge.
    func themedScreen() -> some View { modifier(ThemedScreen()) }
    /// List content (a Section, a ForEach or a Group of them): the theme's row background.
    func themedRows() -> some View { modifier(ThemedRows()) }
    /// Replaces `.background(fill, in: RoundedRectangle(cornerRadius: radius))`.
    func themedCard<S: ShapeStyle>(radius: CGFloat, fill: S, accent: Color? = nil) -> some View {
        modifier(ThemedCard(radius: radius, fill: fill, accent: accent))
    }
    /// Replaces `.background(fill)` on a bar.
    func themedBar<S: ShapeStyle>(_ fill: S) -> some View { modifier(ThemedBar(fill: fill)) }
    /// A time or count: monospaced where the theme says so.
    func themedTime() -> some View { modifier(ThemedTime()) }
    /// Replaces `.buttonStyle(.borderedProminent)`: on a bright neon tint the label turns dark (contrast).
    func themedProminent() -> some View { modifier(ThemedProminent()) }
    /// A neon glow when `on`; otherwise the view untouched.
    func glow(_ on: Bool, _ color: Color, radius: CGFloat = 6) -> some View { modifier(Glow(on: on, color: color, radius: radius)) }
    /// Haptic feedback, only for themes with the haptics feature.
    func themedHaptic<T: Equatable>(_ feedback: SensoryFeedback, trigger: T) -> some View {
        modifier(ThemedHaptic(feedback: feedback, trigger: trigger))
    }
}

struct ThemedList: ViewModifier {
    let live: Bool
    @Environment(\.theme) private var theme
    @Environment(\.motionLevel) private var motion

    func body(content: Content) -> some View {
        content
            .scrollContentBackground(theme.hasChrome ? .hidden : .automatic)
            .background { if let c = theme.chrome { c.backdrop(motion: motion, live: live) } }
    }
}

struct ThemedScreen: ViewModifier {
    @Environment(\.theme) private var theme
    @Environment(\.motionLevel) private var motion
    func body(content: Content) -> some View {
        if let c = theme.chrome {
            content.frame(maxWidth: .infinity, maxHeight: .infinity).background { c.backdrop(motion: motion, live: true) }
        } else {
            content
        }
    }
}

struct ThemedRows: ViewModifier {
    @Environment(\.theme) private var theme
    func body(content: Content) -> some View {
        if let c = theme.chrome {
            content.listRowBackground(c.rowBackground()).listRowSeparatorTint(c.separator)
        } else {
            content
        }
    }
}

struct ThemedCard<S: ShapeStyle>: ViewModifier {
    let radius: CGFloat
    let fill: S
    let accent: Color?
    @Environment(\.theme) private var theme
    func body(content: Content) -> some View {
        if let c = theme.chrome {
            content.background { c.card(radius: radius, accent: accent) }
        } else {
            content.background(fill, in: RoundedRectangle(cornerRadius: radius))
        }
    }
}

struct ThemedBar<S: ShapeStyle>: ViewModifier {
    let fill: S
    @Environment(\.theme) private var theme
    func body(content: Content) -> some View {
        if let c = theme.chrome { content.background { c.bar() } } else { content.background(fill) }
    }
}

struct ThemedProminent: ViewModifier {
    @Environment(\.theme) private var theme
    func body(content: Content) -> some View {
        if theme.hasChrome {
            content.buttonStyle(.borderedProminent).foregroundStyle(SciFiPalette.backgroundTop.color)
        } else {
            content.buttonStyle(.borderedProminent)
        }
    }
}

struct Glow: ViewModifier {
    let on: Bool
    let color: Color
    let radius: CGFloat
    func body(content: Content) -> some View {
        if on { content.shadow(color: color.opacity(0.8), radius: radius) } else { content }
    }
}

struct ThemedTime: ViewModifier {
    @Environment(\.theme) private var theme
    func body(content: Content) -> some View {
        if theme.type.monospacedTimes { content.monospaced() } else { content }
    }
}

struct ThemedHaptic<T: Equatable>: ViewModifier {
    let feedback: SensoryFeedback
    let trigger: T
    @Environment(\.theme) private var theme
    func body(content: Content) -> some View {
        content.sensoryFeedback(feedback, trigger: trigger) { _, _ in theme.has(.haptics) }
    }
}

/// Interface sounds: off unless the owner turned them on (Settings → Appearance).
enum ThemeSound {
    @MainActor static func play(_ store: ThemeStore?, _ id: SystemSoundID = 1104) {
        guard let store, store.uiSounds, store.theme.hasChrome else { return }
        AudioServicesPlaySystemSound(id)
    }
}

// MARK: - Tab chrome

extension View {
    func themedTabChrome(index: Int, count: Int) -> some View { modifier(ThemedTabChrome(index: index, count: count)) }
}

struct ThemedTabChrome: ViewModifier {
    let index: Int
    let count: Int
    @Environment(\.theme) private var theme
    @Environment(\.motionLevel) private var motion
    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottom) {
                if let c = theme.chrome {
                    c.tabChrome(index: index, count: count, motion: motion)
                        .allowsHitTesting(false).accessibilityHidden(true)
                }
            }
            .themedHaptic(.selection, trigger: index)
    }
}
