import SwiftUI

// docs/THEMES.md §3 — the chat side of the Sci-fi CX: transmission arrival, the waveform typing
// indicator and quick replies. Text and accessibility labels are never altered; only decoration moves.

/// A message that arrived while the chat was open: blurs in under a scan line (full motion), fades
/// in (Reduce Motion), or simply appears (Low Power, or not arriving).
struct TransmissionArrival: ViewModifier {
    let active: Bool
    @Environment(\.motionLevel) private var motion
    @State private var shown = false
    @State private var scan: CGFloat = 0

    func body(content: Content) -> some View {
        if active && MotionEffect.transmission.animates(at: motion) {
            content
                .opacity(shown ? 1 : 0)
                .blur(radius: shown || motion != .full ? 0 : 6)
                .overlay {
                    if motion == .full && scan < 1 {
                        GeometryReader { g in
                            Rectangle()
                                .fill(LinearGradient(colors: [.clear, SciFiPalette.accent.color(0.7), .clear], startPoint: .top, endPoint: .bottom))
                                .frame(height: 14)
                                .position(x: g.size.width / 2, y: g.size.height * scan)
                        }
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                    }
                }
                .onAppear {
                    withAnimation(.easeOut(duration: motion == .full ? 0.45 : 0.2)) { shown = true }
                    if motion == .full { withAnimation(.easeInOut(duration: 0.45)) { scan = 1 } }
                }
        } else {
            content
        }
    }
}

/// "Receiving transmission": waveform bars in place of the three dots. Same accessibility label.
struct TransmissionTyping: View {
    let name: String
    let motion: MotionLevel
    @State private var t = false

    var body: some View {
        HStack {
            HStack(spacing: 8) {
                HStack(alignment: .center, spacing: 3) {
                    ForEach(0..<5) { i in
                        Capsule().fill(SciFiPalette.accent.color)
                            .frame(width: 3, height: motion == .full ? (t ? [14, 6, 18, 8, 12][i] : [6, 16, 7, 15, 5][i]) : 10)
                            .animation(motion == .full ? .easeInOut(duration: 0.45).repeatForever().delay(Double(i) * 0.08) : nil, value: t)
                    }
                }
                .frame(height: 18)
                Text("RECEIVING").font(.caption2.monospaced().weight(.semibold)).tracking(1.4).foregroundStyle(SciFiPalette.accent.color)
            }
            .padding(.horizontal, 14).padding(.vertical, 9)
            .background(SciFiPalette.surface.color(0.78), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(SciFiPalette.accent2.color(0.6), lineWidth: 1))
            Spacer(minLength: 0)
        }
        .onAppear { t = true }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(name) is typing")
    }
}

/// One-tap replies above the composer (the COO chat).
struct QuickReplyChips: View {
    let suggestions: [String]
    let send: (String) -> Void
    @Environment(\.themeStore) private var store

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(suggestions, id: \.self) { s in
                    Button { ThemeSound.play(store); send(s) } label: {
                        Text(s).font(.subheadline.weight(.medium))
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .background(SciFiPalette.surface.color(0.8), in: Capsule())
                            .overlay(Capsule().strokeBorder(SciFiPalette.accent.color(0.6), lineWidth: 1))
                            .foregroundStyle(SciFiPalette.textPrimary.color)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Send: \(s)")
                    .accessibilityIdentifier("chat.quickReply")
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
        }
        .themedBar(Material.bar)
        .sensoryFeedback(.impact(weight: .light), trigger: suggestions)
    }
}
