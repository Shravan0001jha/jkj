import SwiftUI

// docs/THEMES.md §2.4 — the Sci-fi chrome. Every layer here is decorative: hidden from
// accessibility, no hit testing, and its motion follows `MotionLevel`.

struct SciFiChrome: ThemeChrome {
    var separator: Color { SciFiPalette.accent.color(0.18) }

    func backdrop(motion: MotionLevel, live: Bool) -> AnyView { AnyView(SpaceBackdrop(motion: motion, live: live)) }

    func rowBackground() -> AnyView { AnyView(HoloRow()) }

    func card(radius: CGFloat, accent: Color?) -> AnyView { AnyView(HoloCard(radius: radius, accent: accent)) }

    func bar() -> AnyView { AnyView(HUDBar()) }

    func bubbleFill(mine: Bool) -> AnyShapeStyle {
        mine
            ? AnyShapeStyle(LinearGradient(colors: [SciFiPalette.mineBubble.color(0.92), SciFiPalette.mineBubble.color(0.78)],
                                           startPoint: .topLeading, endPoint: .bottomTrailing))
            : AnyShapeStyle(SciFiPalette.surface.color(0.78))
    }

    func bubbleEdge(mine: Bool) -> AnyShapeStyle {
        mine
            ? AnyShapeStyle(LinearGradient(colors: [SciFiPalette.accent.color(0.9), SciFiPalette.accent.color(0.25)], startPoint: .topTrailing, endPoint: .bottomLeading))
            : AnyShapeStyle(LinearGradient(colors: [SciFiPalette.accent2.color(0.7), SciFiPalette.accent2.color(0.15)], startPoint: .topLeading, endPoint: .bottomTrailing))
    }

    func wallpaper(motion: MotionLevel, live: Bool) -> AnyView { AnyView(SpaceBackdrop(motion: motion, live: live, grid: true)) }

    func tabChrome(index: Int, count: Int, motion: MotionLevel) -> AnyView { AnyView(DockGlow(index: index, count: count, motion: motion)) }

    func boot(motion: MotionLevel) -> AnyView { AnyView(BootSequence(motion: motion)) }
}

// MARK: - Backdrop

/// Deep space: a navy gradient, two static nebulae, a two-layer starfield and, for chats, a
/// perspective grid. The sky is rasterised once (`drawingGroup`) and drifts by moving that layer
/// (a transform, composited by the GPU: no per-frame redraw while a list scrolls over it). The near
/// layer drifts faster than the far one (parallax); both stop below full motion or off screen.
/// Dims when the socket is not live: the "system pulse".
struct SpaceBackdrop: View {
    let motion: MotionLevel
    var live = true
    var grid = false
    @Environment(\.scenePhase) private var phase
    @Environment(\.ambientPaused) private var paused
    @State private var visible = false
    @State private var clock = AmbientClock()

    var body: some View {
        let drifting = motion == .full && visible && phase == .active && !paused && !AmbientDebug.off.contains("stars")
        ZStack {
            SpaceGradient().equatable()
            TimelineView(.animation(minimumInterval: 1.0 / 20, paused: !drifting)) { ctx in
                let t = clock.time(ctx.date)
                ZStack {
                    StarLayer(layer: 0, shift: (t / 140).truncatingRemainder(dividingBy: 1))
                    StarLayer(layer: 1, shift: (t / 55).truncatingRemainder(dividingBy: 1))
                }
            }
            .opacity(live ? 1 : 0.45)
            .animation(.easeInOut(duration: 0.6), value: live)
            if grid { Canvas { g, size in Starfield.drawGrid(in: &g, size: size) } }
        }
        .ignoresSafeArea()
        .onAppear { visible = true; clock.set(running: drifting) }
        .onDisappear { visible = false }
        .onChange(of: drifting) { _, d in clock.set(running: d) }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The navy gradient and both nebulae, flattened into one rasterised layer (one blend, not three).
private struct SpaceGradient: View, Equatable {
    var body: some View {
        ZStack {
            LinearGradient(colors: [SciFiPalette.backgroundTop.color, SciFiPalette.backgroundBottom.color], startPoint: .top, endPoint: .bottom)
            RadialGradient(colors: [SciFiPalette.nebulaViolet.color(0.55), .clear], center: UnitPoint(x: 0.9, y: 0.12), startRadius: 0, endRadius: 320)
            RadialGradient(colors: [SciFiPalette.nebulaCyan.color(0.45), .clear], center: UnitPoint(x: 0.05, y: 0.78), startRadius: 0, endRadius: 360)
        }
        .drawingGroup()
    }
}

/// One layer of stars, slid up by `shift` screens. Only the offset changes per tick: the tile below
/// is an Equatable view, so SwiftUI never re-runs its Canvas and the rasterised layer is reused.
private struct StarLayer: View {
    let layer: Int
    let shift: Double

    var body: some View {
        GeometryReader { g in
            StarTile(layer: layer, width: g.size.width, height: g.size.height)
                .equatable()
                .offset(y: -g.size.height * shift)
        }
    }
}

/// Two identical skies stacked (a seamless wrap), drawn once and rasterised (`drawingGroup`).
private struct StarTile: View, Equatable {
    let layer: Int
    let width: CGFloat
    let height: CGFloat

    var body: some View {
        Canvas { ctx, size in
            for k in 0..<2 {
                ctx.translateBy(x: 0, y: k == 0 ? 0 : height)
                Starfield.draw(in: &ctx, size: CGSize(width: width, height: height), layer: layer)
            }
        }
        .frame(width: width, height: height * 2)
        .drawingGroup()
    }
}

enum Starfield {
    struct Star { let x: Double, y: Double, r: Double, phase: Double, layer: Int }

    /// Seeded, so every screen shows the same sky (and screenshots are reproducible).
    static let stars: [Star] = {
        var s: UInt64 = 0x9E3779B97F4A7C15
        func next() -> Double { s ^= s << 13; s ^= s >> 7; s ^= s << 17; return Double(s % 10_000) / 10_000 }
        return (0..<140).map { i in
            let layer = i % 3 == 0 ? 1 : 0
            return Star(x: next(), y: next(), r: layer == 1 ? 0.9 + next() * 0.9 : 0.4 + next() * 0.6, phase: next() * 6.28, layer: layer)
        }
    }()

    static func draw(in g: inout GraphicsContext, size: CGSize, layer: Int) {
        for st in stars where st.layer == layer {
            let y = st.y * size.height
            let x = st.x * size.width
            let a = (st.layer == 1 ? 0.85 : 0.5) * (0.55 + 0.45 * sin(st.phase))
            let rect = CGRect(x: x - st.r, y: y - st.r, width: st.r * 2, height: st.r * 2)
            let tint: Color = st.layer == 1 && st.phase > 4.5 ? SciFiPalette.accent.color(a) : Color.white.opacity(a)
            g.fill(Path(ellipseIn: rect), with: .color(tint))
        }
    }

    /// A receding grid on the lower third: the "bridge floor" under a chat.
    static func drawGrid(in g: inout GraphicsContext, size: CGSize) {
        let horizon = size.height * 0.62
        var p = Path()
        let lines = 14
        for i in 0...lines {
            let x = size.width * Double(i) / Double(lines)
            p.move(to: CGPoint(x: size.width / 2 + (x - size.width / 2) * 0.15, y: horizon))
            p.addLine(to: CGPoint(x: size.width / 2 + (x - size.width / 2) * 2.2, y: size.height))
        }
        var y = horizon
        var step = 6.0
        while y < size.height { p.move(to: CGPoint(x: 0, y: y)); p.addLine(to: CGPoint(x: size.width, y: y)); y += step; step *= 1.35 }
        g.stroke(p, with: .linearGradient(Gradient(colors: [SciFiPalette.grid.color(0), SciFiPalette.grid.color(0.16)]),
                                          startPoint: CGPoint(x: 0, y: horizon), endPoint: CGPoint(x: 0, y: size.height)), lineWidth: 0.6)
    }
}

// MARK: - Glass

struct HoloRow: View {
    var body: some View {
        ZStack(alignment: .leading) {
            Rectangle().fill(SciFiPalette.surface.color(SciFiPalette.surfaceAlpha))
            Rectangle().fill(LinearGradient(colors: [SciFiPalette.accent.color(0.9), SciFiPalette.accent2.color(0.5)], startPoint: .top, endPoint: .bottom))
                .frame(width: 2)
        }
        .accessibilityHidden(true)
    }
}

struct HoloCard: View {
    let radius: CGFloat
    var accent: Color? = nil
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        // No .shadow: a shadow is an offscreen pass per card per frame while scrolling. A wide,
        // faint stroke outside the edge reads as the glow for the cost of a path.
        shape.fill(SciFiPalette.surface.color(SciFiPalette.surfaceAlpha))
            .overlay(shape.strokeBorder(HoloEdge.gradient(accent), lineWidth: 1))
            .background(shape.stroke((accent ?? SciFiPalette.accent.color).opacity(0.14), lineWidth: 6))
            .accessibilityHidden(true)
    }
}

enum HoloEdge {
    static func gradient(_ accent: Color? = nil) -> LinearGradient {
        LinearGradient(colors: [accent ?? SciFiPalette.accent.color(0.85), SciFiPalette.accent2.color(0.35), SciFiPalette.accent3.color(0.55)],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

/// An animated gradient border (the Bridge): the gradient turns once every 8 s at full motion.
/// The gradient is a disc drawn once (an Equatable, rasterised view) that only rotates — a transform
/// — under a static stroke used as a mask. (Re-rendering an AngularGradient stroke at a new angle
/// each tick cost ~7% of frames in the simulator; this costs a transform.)
struct ShimmerBorder: View {
    let radius: CGFloat
    let motion: MotionLevel
    @Environment(\.ambientPaused) private var paused
    @Environment(\.scenePhase) private var phase
    @State private var clock = AmbientClock()
    @State private var visible = false
    var body: some View {
        let running = motion == .full && visible && !paused && phase == .active && !AmbientDebug.off.contains("shimmer")
        GeometryReader { g in
            let d = (g.size.width * g.size.width + g.size.height * g.size.height).squareRoot()
            TimelineView(.animation(minimumInterval: 1.0 / 20, paused: !running)) { ctx in
                ShimmerDisc(diameter: d).equatable()
                    .rotationEffect(.degrees((clock.time(ctx.date) / 8).truncatingRemainder(dividingBy: 1) * 360))
                    .position(x: g.size.width / 2, y: g.size.height / 2)
            }
        }
        .mask(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(lineWidth: 1.2))
        .onAppear { visible = true; clock.set(running: running) }
        .onDisappear { visible = false }
        .onChange(of: running) { _, r in clock.set(running: r) }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct ShimmerDisc: View, Equatable {
    let diameter: CGFloat
    var body: some View {
        Circle()
            .fill(AngularGradient(colors: [SciFiPalette.accent.color, SciFiPalette.accent2.color(0.4), SciFiPalette.accent3.color,
                                           SciFiPalette.accent.color(0.3), SciFiPalette.accent.color], center: .center))
            .frame(width: diameter, height: diameter)
            .drawingGroup()
    }
}

struct HUDBar: View {
    var body: some View {
        ZStack(alignment: .bottom) {
            Rectangle().fill(.ultraThinMaterial)
            Rectangle().fill(SciFiPalette.backgroundBottom.color(0.55))
            Rectangle().fill(LinearGradient(colors: [.clear, SciFiPalette.accent.color(0.6), .clear], startPoint: .leading, endPoint: .trailing)).frame(height: 0.75)
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Dock glow

/// A glow under the selected tab of the native (floating) tab bar, sliding on a spring; the bar
/// itself stays native so VoiceOver and the UI tests see the same buttons.
struct DockGlow: View {
    let index: Int
    let count: Int
    let motion: MotionLevel
    @State private var sweep = false

    var body: some View {
        GeometryReader { g in
            // iOS 26's floating bar: items centred on 16.3% + i × 16.35% of the width.
            let x = g.size.width * (0.163 + 0.1635 * Double(index) * 5 / Double(max(count, 1)))
            ZStack {
                Ellipse().fill(RadialGradient(colors: [SciFiPalette.accent.color(0.32), .clear], center: .center, startRadius: 0, endRadius: 60))
                    .frame(width: 130, height: 70)
                    .position(x: x, y: g.size.height - 46)
                Capsule().fill(SciFiPalette.accent.color(0.9)).frame(width: 26, height: 3)
                    .shadow(color: SciFiPalette.accent.color, radius: 6)
                    .position(x: x, y: g.size.height - 12)
                if motion == .full {
                    Rectangle().fill(LinearGradient(colors: [.clear, SciFiPalette.accent.color(0.5), .clear], startPoint: .leading, endPoint: .trailing))
                        .frame(width: 90, height: 1)
                        .position(x: sweep ? g.size.width + 60 : -60, y: g.size.height - 92)
                }
            }
            .animation(motion == .off ? nil : .spring(response: 0.42, dampingFraction: 0.78), value: index)
        }
        .frame(height: 120)
        .ignoresSafeArea(edges: .bottom)
        .onChange(of: index) { _, _ in
            guard motion == .full else { return }
            sweep = false
            withAnimation(.easeOut(duration: 0.35)) { sweep = true }
        }
    }
}

// MARK: - Boot

/// "SYSTEM ONLINE": ≤ 0.9 s, over the already-live app, tap-through; a 0.25 s fade under Reduce
/// Motion; skipped in Low Power Mode.
struct BootSequence: View {
    let motion: MotionLevel
    @State private var progress: CGFloat = 0
    @State private var gone = false

    var body: some View {
        Group {
            if !gone && motion != .off {
                GeometryReader { g in
                    ZStack {
                        SciFiPalette.backgroundTop.color.opacity(0.92)
                        VStack(spacing: 10) {
                            Text("IRIS WORKPLACE").font(.system(.title3, design: .monospaced).weight(.bold)).tracking(4)
                                .foregroundStyle(SciFiPalette.textPrimary.color)
                            Text(progress < 0.6 ? "LINKING…" : "SYSTEM ONLINE").font(.system(.caption, design: .monospaced).weight(.semibold)).tracking(3)
                                .foregroundStyle(SciFiPalette.accent.color)
                            Capsule().fill(SciFiPalette.accent.color(0.2)).frame(width: 160, height: 2)
                                .overlay(alignment: .leading) { Capsule().fill(SciFiPalette.accent.color).frame(width: 160 * progress, height: 2) }
                        }
                        if motion == .full {
                            Rectangle().fill(LinearGradient(colors: [.clear, SciFiPalette.accent.color(0.55), .clear], startPoint: .top, endPoint: .bottom))
                                .frame(height: 60).position(x: g.size.width / 2, y: g.size.height * progress)
                        }
                    }
                }
                .ignoresSafeArea()
                .transition(.opacity)
            }
        }
        .task {
            guard motion != .off else { BootOnce.done = true; return }
            if motion == .full {
                withAnimation(.easeInOut(duration: 0.75)) { progress = 1 }
                try? await Task.sleep(for: .milliseconds(650))
            } else {
                progress = 1
                try? await Task.sleep(for: .milliseconds(100))
            }
            withAnimation(.easeOut(duration: motion == .full ? 0.25 : 0.25)) { gone = true }
            try? await Task.sleep(for: .milliseconds(300))
            BootOnce.done = true
        }
    }
}

// MARK: - Small pieces shared by Sci-fi views

/// A presence or "working" ping: a ring that scales out every 2 s (full motion only).
struct PulseRing: View {
    let color: Color
    let motion: MotionLevel
    @Environment(\.ambientPaused) private var paused
    @Environment(\.scenePhase) private var phase
    @State private var clock = AmbientClock()
    @State private var visible = false
    var body: some View {
        let running = motion == .full && visible && !paused && phase == .active && !AmbientDebug.off.contains("pulse")
        TimelineView(.animation(minimumInterval: 1.0 / 20, paused: !running)) { ctx in
            let p = (clock.time(ctx.date) / 2).truncatingRemainder(dividingBy: 1)
            Circle().stroke(color, lineWidth: 1.5)
                .scaleEffect(1 + 1.2 * p).opacity(0.8 * (1 - p))
        }
        .opacity(motion == .full ? 1 : 0)
        .onAppear { visible = true; clock.set(running: running) }
        .onDisappear { visible = false }
        .onChange(of: running) { _, r in clock.set(running: r) }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// HUD caption: monospaced, uppercase, tracked.
struct HUDLabel: View {
    let text: String
    var color: Color = SciFiPalette.accent.color
    var body: some View {
        // Never broken mid-word: a HUD caption shrinks a little before it wraps.
        Text(text.uppercased()).font(.caption2.monospaced().weight(.semibold)).tracking(1.4).foregroundStyle(color)
            .lineLimit(2).minimumScaleFactor(0.7)
    }
}
