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

/// Deep space: a navy gradient, two static nebulae, a two-layer starfield that drifts (24 fps,
/// paused when off screen, inactive or not at full motion) and, for chats, a perspective grid.
/// Dims when the socket is not live: the "system pulse".
struct SpaceBackdrop: View {
    let motion: MotionLevel
    var live = true
    var grid = false
    @Environment(\.scenePhase) private var phase
    @State private var visible = false

    var body: some View {
        ZStack {
            LinearGradient(colors: [SciFiPalette.backgroundTop.color, SciFiPalette.backgroundBottom.color], startPoint: .top, endPoint: .bottom)
            RadialGradient(colors: [SciFiPalette.nebulaViolet.color(0.55), .clear], center: UnitPoint(x: 0.9, y: 0.12), startRadius: 0, endRadius: 320)
            RadialGradient(colors: [SciFiPalette.nebulaCyan.color(0.45), .clear], center: UnitPoint(x: 0.05, y: 0.78), startRadius: 0, endRadius: 360)
            TimelineView(.animation(minimumInterval: 1.0 / 24, paused: motion != .full || !visible || phase != .active)) { ctx in
                Canvas { g, size in
                    Starfield.draw(in: &g, size: size, t: ctx.date.timeIntervalSinceReferenceDate, dim: live ? 1 : 0.45)
                    if grid { Starfield.drawGrid(in: &g, size: size) }
                }
            }
        }
        .ignoresSafeArea()
        .onAppear { visible = true }
        .onDisappear { visible = false }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
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

    static func draw(in g: inout GraphicsContext, size: CGSize, t: Double, dim: Double) {
        let speeds = [3.0, 9.0]   // points per second: far, near (parallax)
        for st in stars {
            let dy = (t * speeds[st.layer]).truncatingRemainder(dividingBy: Double(size.height))
            var y = st.y * size.height - dy
            if y < 0 { y += size.height }
            let x = st.x * size.width
            let twinkle = 0.55 + 0.45 * sin(t * (st.layer == 1 ? 1.7 : 0.9) + st.phase)
            let a = (st.layer == 1 ? 0.85 : 0.5) * twinkle * dim
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
        shape.fill(SciFiPalette.surface.color(SciFiPalette.surfaceAlpha))
            .overlay(shape.strokeBorder(HoloEdge.gradient(accent), lineWidth: 1))
            .shadow(color: (accent ?? SciFiPalette.accent.color).opacity(0.22), radius: 8)
            .accessibilityHidden(true)
    }
}

enum HoloEdge {
    static func gradient(_ accent: Color? = nil) -> LinearGradient {
        LinearGradient(colors: [accent ?? SciFiPalette.accent.color(0.85), SciFiPalette.accent2.color(0.35), SciFiPalette.accent3.color(0.55)],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

/// An animated gradient border (the Bridge): the angular gradient turns once every 8 s at full motion.
struct ShimmerBorder: View {
    let radius: CGFloat
    let motion: MotionLevel
    @State private var turn = false
    var body: some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .strokeBorder(AngularGradient(colors: [SciFiPalette.accent.color, SciFiPalette.accent2.color(0.4), SciFiPalette.accent3.color, SciFiPalette.accent.color(0.3), SciFiPalette.accent.color],
                                          center: .center, angle: .degrees(turn ? 360 : 0)), lineWidth: 1.2)
            .onAppear { if motion == .full { withAnimation(.linear(duration: 8).repeatForever(autoreverses: false)) { turn = true } } }
            .accessibilityHidden(true)
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
    @State private var on = false
    var body: some View {
        Circle().stroke(color, lineWidth: 1.5)
            .scaleEffect(on ? 2.2 : 1).opacity(on ? 0 : 0.8)
            .onAppear { if motion == .full { withAnimation(.easeOut(duration: 2).repeatForever(autoreverses: false)) { on = true } } }
            .opacity(motion == .full ? 1 : 0)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

/// HUD caption: monospaced, uppercase, tracked.
struct HUDLabel: View {
    let text: String
    var color: Color = SciFiPalette.accent.color
    var body: some View {
        Text(text.uppercased()).font(.caption2.monospaced().weight(.semibold)).tracking(1.4).foregroundStyle(color)
    }
}
