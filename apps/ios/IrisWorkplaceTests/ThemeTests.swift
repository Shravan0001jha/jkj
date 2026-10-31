import SwiftUI
import XCTest
@testable import IrisWorkplace

/// docs/THEMES.md §2: Default's tokens are today's literals, the store persists the choice, the
/// environment follows a switch, and motion honours Reduce Motion and Low Power Mode.
@MainActor
final class ThemeTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let name = "theme-tests-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    // MARK: Default = today

    func testDefaultTokensEqualTodaysLiterals() {
        let t = Theme.default
        XCTAssertEqual(t.id, .default)
        XCTAssertNil(t.chrome, "Default has no chrome: every themed modifier is an identity")
        XCTAssertNil(t.colorScheme, "Default follows the system appearance")
        XCTAssertNil(t.tint, "Default sets no tint (the asset AccentColor applies)")
        XCTAssertTrue(t.features.isEmpty, "Default builds none of the Sci-fi CX")
        XCTAssertFalse(t.motion.ambient)
        // Literals as they were in 45dc1d8.
        XCTAssertEqual(t.palette.accent, Color.accentColor)          // ChatPalette, mentions, Pill(.accentColor)
        XCTAssertEqual(t.radii.card, 14)                              // InboxItemView.question, CooNoteBanner, AlertBanner
        XCTAssertEqual(t.radii.bubble, 18)                            // ChatRowView.corners r
        XCTAssertEqual(t.radii.bubbleTight, 6)                        // ChatRowView.corners tight
        XCTAssertEqual(t.radii.composer, 20)                          // ChatComposer field
        XCTAssertEqual(t.radii.quote, 8)                              // QuoteBlock
        XCTAssertEqual(t.radii.pillPadding.h, 8)                      // Pill
        XCTAssertEqual(t.radii.pillPadding.v, 3)
        XCTAssertEqual(t.radii.progressHeight, 6)                     // EpicProgressBar
        XCTAssertEqual(t.type.sectionHeader, Font.subheadline.weight(.semibold))   // SectionHeader
        XCTAssertFalse(t.type.sectionHeaderUppercase)
        XCTAssertEqual(t.type.sectionHeaderTracking, 0)
        XCTAssertFalse(t.type.monospacedTimes)
        XCTAssertEqual(t.motion.spring, Animation.snappy)
    }

    func testSciFiIsAlwaysDarkWithChromeAndEveryCXFeature() {
        let t = Theme.scifi
        XCTAssertEqual(t.colorScheme, .dark)
        XCTAssertNotNil(t.chrome)
        XCTAssertNotNil(t.tint)
        XCTAssertTrue(t.motion.ambient)
        XCTAssertEqual(t.features, Set(ThemeFeature.allCases))
        XCTAssertEqual(Theme.all.map(\.id), ThemeID.allCases, "every id has a theme, in picker order")
    }

    // MARK: ThemeStore

    func testStoreDefaultsToDefaultAndPersistsAChoice() {
        let d = defaults()
        let s = ThemeStore(defaults: d, env: [:])
        XCTAssertEqual(s.selected, .default)
        XCTAssertEqual(s.theme.id, .default)
        s.selected = .scifi
        XCTAssertEqual(s.theme.id, .scifi)
        XCTAssertEqual(d.string(forKey: ThemeStore.key), "scifi")
        XCTAssertEqual(ThemeStore(defaults: d, env: [:]).selected, .scifi, "a relaunch keeps the choice")
    }

    func testUnknownStoredValueFallsBackToDefault() {
        let d = defaults()
        d.set("vaporwave", forKey: ThemeStore.key)
        XCTAssertEqual(ThemeStore(defaults: d, env: [:]).selected, .default)
    }

    func testEnvOverrideWinsWithoutPersisting() {
        let d = defaults()
        let s = ThemeStore(defaults: d, env: ["WORKPLACE_THEME": "scifi"])
        XCTAssertEqual(s.selected, .scifi)
        XCTAssertNil(d.string(forKey: ThemeStore.key), "a scripted run never changes the owner's choice")
        XCTAssertEqual(ThemeStore(defaults: d, env: ["WORKPLACE_THEME": "default"]).selected, .default)
    }

    func testInterfaceSoundsAreOffByDefaultAndPersist() {
        let d = defaults()
        let s = ThemeStore(defaults: d, env: [:])
        XCTAssertFalse(s.uiSounds)
        s.uiSounds = true
        XCTAssertTrue(ThemeStore(defaults: d, env: [:]).uiSounds)
    }

    // MARK: the environment follows the store

    func testThemeSwitchUpdatesTheEnvironment() {
        let s = ThemeStore(defaults: defaults(), env: [:])
        let seen = Box()
        let renderer = { ImageRenderer(content: ThemeProbe(seen: seen).themeRoot(s, boot: false).frame(width: 10, height: 10)).uiImage }
        _ = renderer()
        XCTAssertEqual(seen.id, .default)
        s.selected = .scifi
        _ = renderer()
        XCTAssertEqual(seen.id, .scifi)
        XCTAssertEqual(seen.motion, .full, "no Reduce Motion, no Low Power in the test host")
    }

    // MARK: motion

    func testMotionLevelHonoursReduceMotionAndLowPower() {
        XCTAssertEqual(MotionLevel.resolve(theme: .scifi, reduceMotion: false, lowPower: false), .full)
        XCTAssertEqual(MotionLevel.resolve(theme: .scifi, reduceMotion: true, lowPower: false), .reduced)
        XCTAssertEqual(MotionLevel.resolve(theme: .scifi, reduceMotion: false, lowPower: true), .off)
        XCTAssertEqual(MotionLevel.resolve(theme: .scifi, reduceMotion: true, lowPower: true), .off)
        XCTAssertEqual(MotionLevel.resolve(theme: .default, reduceMotion: false, lowPower: false), .off, "Default has no ambient motion")
    }

    func testReducedMotionMakesEveryEffectStaticOrAFade() {
        for effect in MotionEffect.allCases {
            XCTAssertFalse(effect.animates(at: .off), "\(effect) is off in Low Power Mode")
            XCTAssertFalse(effect.loops(at: .reduced), "\(effect) never loops under Reduce Motion")
            XCTAssertFalse(effect.moves(at: .reduced), "\(effect) is at most a fade under Reduce Motion")
        }
        XCTAssertTrue(MotionEffect.starfield.loops(at: .full))
        XCTAssertTrue(MotionEffect.transmission.animates(at: .reduced), "arrival still fades in")
    }
}

final class Box { var id: ThemeID?; var motion: MotionLevel? }

private struct ThemeProbe: View {
    let seen: Box
    @Environment(\.theme) private var theme
    @Environment(\.motionLevel) private var motion
    var body: some View {
        seen.id = theme.id
        seen.motion = motion
        return Color.clear
    }
}
