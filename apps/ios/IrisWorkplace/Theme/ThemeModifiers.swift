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
            // The boot plays on a cold launch only: a later switch to Sci-fi never replays it.
            .task { try? await Task.sleep(for: .seconds(2)); BootOnce.done = true }
            .onReceive(NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)) { _ in
                lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
            }
    }
}

/// The boot animation plays once per process (a cold launch), never on a theme switch.
@MainActor enum BootOnce {
    static var done = false
    /// When the process started (set by the app at launch). A boot whose first frame comes later
    /// than `lateAfter` is skipped, so a slow cold start never stacks a second wait on top.
    static var launchedAt = Date()
    static let lateAfter: TimeInterval = 1.2
}

// MARK: - Lists, rows, cards, bars

extension View {
    /// A List or ScrollView: the theme's backdrop behind it.
    func themedList(live: Bool = true) -> some View { modifier(ThemedList(live: live)) }
    /// A full screen that is not a list (sign-in, offline states): the backdrop, edge to edge.
    func themedScreen() -> some View { modifier(ThemedScreen()) }
    /// List content (a Section, a ForEach or a Group of them): the theme's row background.
    func themedRows() -> some View { modifier(ThemedRows()) }
    /// Replaces `.background(fill, in: RoundedRectangle(cornerRadius: radius, style: style))`.
    func themedCard<S: ShapeStyle>(radius: CGFloat, fill: S, accent: Color? = nil, style: RoundedCornerStyle = .circular) -> some View {
        modifier(ThemedCard(radius: radius, fill: fill, accent: accent, style: style))
    }
    /// Replaces `.background(fill)` behind a whole screen.
    func themedBackground<S: ShapeStyle>(_ fill: S) -> some View { modifier(ThemedBackground(fill: fill)) }
    /// A section title: HUD type under a theme with chrome.
    func themedHeading() -> some View { modifier(ThemedHeading()) }
    /// Replaces `.background(fill)` on a bar.
    func themedBar<S: ShapeStyle>(_ fill: S) -> some View { modifier(ThemedBar(fill: fill)) }
    /// A time or count: monospaced where the theme says so.
    func themedTime() -> some View { modifier(ThemedTime()) }
    /// Replaces `.buttonStyle(.borderedProminent)`: on a bright neon tint the label turns dark (contrast).
    func themedProminent() -> some View { modifier(ThemedProminent()) }
    /// Replaces `.textFieldStyle(.roundedBorder)` on a composer field.
    func themedField() -> some View { modifier(ThemedField()) }
    /// A title that should read as primary text (Sci-fi: its bright text colour).
    func themedTitle() -> some View { modifier(ThemedTitle()) }
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
            .background { if let c = theme.chrome, !AmbientDebug.off.contains("backdrop") { c.backdrop(motion: motion, live: live) } }
            .modifier(AmbientScrollPause())
    }
}

/// Ambient effects hold still while the scroll view moves (iOS 18+; on iOS 17 they keep going).
struct AmbientScrollPause: ViewModifier {
    @State private var scrolling = false
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
                .onScrollPhaseChange { _, phase in scrolling = phase.isScrolling }
                .environment(\.ambientPaused, scrolling)
        } else {
            content
        }
    }
}

/// Time for an ambient effect that only advances while it runs, so a pause (scrolling, off screen)
/// resumes where it stopped instead of jumping.
final class AmbientClock {
    private var acc: TimeInterval = 0
    private var since: Date?
    func set(running: Bool, now: Date = Date()) {
        if running { if since == nil { since = now } }
        else if let s = since { acc += now.timeIntervalSince(s); since = nil }
    }
    func time(_ now: Date) -> TimeInterval { acc + (since.map { max(0, now.timeIntervalSince($0)) } ?? 0) }
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
        if let c = theme.chrome, !AmbientDebug.off.contains("rows") {
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
    let style: RoundedCornerStyle
    @Environment(\.theme) private var theme
    func body(content: Content) -> some View {
        if let c = theme.chrome {
            content.background { c.card(radius: radius, accent: accent) }
        } else {
            content.background(fill, in: RoundedRectangle(cornerRadius: radius, style: style))
        }
    }
}

struct ThemedBackground<S: ShapeStyle>: ViewModifier {
    let fill: S
    @Environment(\.theme) private var theme
    @Environment(\.motionLevel) private var motion
    func body(content: Content) -> some View {
        if let c = theme.chrome { content.background { c.backdrop(motion: motion, live: true) } } else { content.background(fill) }
    }
}

struct ThemedHeading: ViewModifier {
    @Environment(\.theme) private var theme
    func body(content: Content) -> some View {
        if let color = theme.type.sectionHeaderColor {
            content.font(theme.type.sectionHeader).tracking(theme.type.sectionHeaderTracking).textCase(.uppercase).foregroundStyle(color)
        } else {
            content
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

struct ThemedField: ViewModifier {
    @Environment(\.theme) private var theme
    func body(content: Content) -> some View {
        if theme.hasChrome {
            content.textFieldStyle(.plain)
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(SciFiPalette.surface.color(0.8), in: RoundedRectangle(cornerRadius: theme.radii.composer, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: theme.radii.composer, style: .continuous).strokeBorder(SciFiPalette.accent.color(0.45), lineWidth: 1))
        } else {
            content.textFieldStyle(.roundedBorder)
        }
    }
}

struct ThemedTitle: ViewModifier {
    @Environment(\.theme) private var theme
    func body(content: Content) -> some View {
        if let c = theme.palette.textPrimary { content.foregroundStyle(c) } else { content }
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
