import SwiftUI

/// The decision queue (docs/THEMES.md §3): the top of the Inbox under Sci-fi. One card at a time;
/// swipe right = the recommended answer (only a safe one), swipe left = later. Every answer waits
/// in the undo window (`StagedDecisionsBar`) before it is sent. The full Inbox list follows unchanged.
struct DecisionDeck: View {
    @Environment(AppModel.self) private var model
    @Environment(SciFiCX.self) private var cx
    @Environment(\.motionLevel) private var motion
    @Environment(\.themeStore) private var store
    @State private var drag: CGFloat = 0
    @State private var deferred = 0

    private var open: [InboxItem] { model.inbox.open.filter { !cx.stager.isStaged($0.id) } }

    var body: some View {
        let items = open
        let top = cx.queue.order.lazy.compactMap { id in items.first { $0.id == id } }.first ?? items.first
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                HUDLabel(text: "Decision queue")
                Spacer()
                HUDLabel(text: "\(items.count) open", color: SciFiPalette.textSecondary.color)
            }
            .padding(.horizontal, 16)
            if let top {
                ZStack {
                    if items.count > 1 {
                        RoundedRectangle(cornerRadius: 16).fill(SciFiPalette.surface.color(0.35))
                            .padding(.horizontal, 14).offset(y: 8).accessibilityHidden(true)
                    }
                    card(top)
                        .offset(x: drag)
                        .rotationEffect(.degrees(motion == .full ? Double(drag / 40) : 0))
                        .gesture(swipe(top))
                        .id(top.id)
                        .transition(.asymmetric(insertion: .scale(scale: 0.96).combined(with: .opacity), removal: .opacity))
                }
                .animation(motion == .off ? nil : .spring(response: 0.42, dampingFraction: 0.78), value: top.id)
            }
            if let e = cx.lastError { Label(e, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.red) }
        }
        .onAppear { cx.queue.sync(open: model.inbox.open) }
        .onChange(of: model.inbox.open.map(\.id)) { _, _ in cx.queue.sync(open: model.inbox.open) }
        .sensoryFeedback(.impact(weight: .medium), trigger: deferred)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("inbox.queue")
    }

    private func card(_ item: InboxItem) -> some View {
        let g = item.kind.glyph
        let u = (item.urgency ?? .normal).glyph
        let safe = DecisionQueue.swipeOption(item)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                if item.urgency.isRaised { Pill(text: u.label, symbol: u.symbol, tint: u.tint) }
                Label(g.label, systemImage: g.symbol).font(.caption).foregroundStyle(g.tint).labelStyle(.titleAndIcon)
                Spacer()
                Text("\(model.employeeName(item.raisedBy)) · \(Format.ago(item.lastMessageAt ?? item.createdAt))")
                    .font(.caption2.monospaced()).foregroundStyle(SciFiPalette.textSecondary.color)
            }
            Text(item.title).font(.headline).foregroundStyle(SciFiPalette.textPrimary.color).fixedSize(horizontal: false, vertical: true)
            if !item.summary.isEmpty && item.summary != item.title {
                Text(item.summary).font(.subheadline).foregroundStyle(SciFiPalette.textSecondary.color).lineLimit(3)
            }
            HStack(spacing: 8) {
                if let safe {
                    Button { commit(item, safe) } label: { Label(safe.label, systemImage: "checkmark").lineLimit(1) }
                        .themedProminent()
                        .accessibilityLabel("Answer \(safe.label)")
                        .accessibilityIdentifier("queue.answer")
                }
                Button { model.router.openInbox(item.id) } label: { Text(safe == nil ? "Open to answer" : "All options") }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("queue.open")
                Spacer(minLength: 0)
                Button { later(item) } label: { Text("Later") }
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("queue.later")
            }
            .font(.subheadline.weight(.semibold))
            .controlSize(.small)
            if safe != nil {
                Text("Swipe right to answer, left for later").font(.caption2).foregroundStyle(SciFiPalette.textSecondary.color)
                    .accessibilityHidden(true)
            }
        }
        .padding(14)
        .background { HoloCard(radius: 16, accent: item.urgency.isRaised ? u.tint : nil) }
        .overlay(alignment: .trailing) { swipeHint(right: false) }
        .overlay(alignment: .leading) { swipeHint(right: true) }
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Later") { later(item) }
    }

    @ViewBuilder private func swipeHint(right: Bool) -> some View {
        let shown = right ? drag > 30 : drag < -30
        if shown {
            Image(systemName: right ? "checkmark.circle.fill" : "clock.arrow.circlepath")
                .font(.largeTitle).foregroundStyle(right ? Color.green : SciFiPalette.accent2.color)
                .padding(18).opacity(min(1, abs(drag) / 110))
                .accessibilityHidden(true)
        }
    }

    private func swipe(_ item: InboxItem) -> some Gesture {
        DragGesture(minimumDistance: 20)
            .onChanged { v in
                // A vertical drag is the list scrolling, not a swipe.
                guard abs(v.translation.width) > abs(v.translation.height) else { return }
                // Right only moves far when there is a safe answer to give.
                let x = v.translation.width
                drag = x > 0 && DecisionQueue.swipeOption(item) == nil ? min(x, 40) : x
            }
            .onEnded { v in
                let x = abs(v.translation.width) > abs(v.translation.height) ? v.translation.width : 0
                if x > 110, let o = DecisionQueue.swipeOption(item) { commit(item, o) }
                else if x < -110 { later(item) }
                withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) { drag = 0 }
            }
    }

    private func commit(_ item: InboxItem, _ o: InboxOption) {
        cx.stager.stage(item: item, option: o, note: nil)
        ThemeSound.play(store)
    }

    private func later(_ item: InboxItem) {
        withAnimation { cx.queue.defer(item.id) }
        deferred += 1
    }
}

/// Answers waiting to be sent: what, a draining bar for the undo window, and Undo.
struct StagedDecisionsBar: View {
    @Environment(SciFiCX.self) private var cx

    var body: some View {
        VStack(spacing: 6) {
            ForEach(cx.stager.pending) { p in StagedRow(p: p, window: cx.stager.window) { cx.stager.undo(p.itemId) } }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 96)
        .animation(.spring(response: 0.35, dampingFraction: 0.8), value: cx.stager.pending.map(\.itemId))
    }
}

private struct StagedRow: View {
    let p: DecisionStager.Pending
    let window: TimeInterval
    let undo: () -> Void
    @State private var left: CGFloat = 1

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "paperplane.fill").foregroundStyle(SciFiPalette.accent.color)
            VStack(alignment: .leading, spacing: 4) {
                Text("Sending “\(p.option.label)”").font(.subheadline.weight(.semibold)).foregroundStyle(SciFiPalette.textPrimary.color)
                Text(p.title).font(.caption).foregroundStyle(SciFiPalette.textSecondary.color).lineLimit(1)
                Capsule().fill(SciFiPalette.accent.color(0.2)).frame(height: 2)
                    .overlay(alignment: .leading) { GeometryReader { g in Capsule().fill(SciFiPalette.accent.color).frame(width: g.size.width * left) } }
                    .accessibilityHidden(true)
            }
            Button("Undo", action: undo).font(.subheadline.weight(.bold)).buttonStyle(.bordered)
                .accessibilityIdentifier("staged.undo")
        }
        .padding(12)
        .background { HoloCard(radius: 14) }
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .onAppear { withAnimation(.linear(duration: window)) { left = 0 } }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Sending \(p.option.label) for \(p.title) in a few seconds")
        .accessibilityAction(named: "Undo", undo)
    }
}
