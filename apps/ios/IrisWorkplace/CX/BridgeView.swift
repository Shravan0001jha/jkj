import SwiftUI

/// The command bridge (docs/THEMES.md §3): the top of the Plan under Sci-fi. System pulse, what
/// needs you (with the top decision's recommended answer one tap away), what changed since you last
/// looked, live agents on a radar, counts by state, and the command prompt. The Plan follows unchanged.
struct BridgeView: View {
    @Environment(AppModel.self) private var model
    @Environment(SciFiCX.self) private var cx
    @Environment(\.motionLevel) private var motion
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.themeStore) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            needsYou
            sinceLastLook
            liveAgents
            counts
            prompt
        }
        .padding(14)
        .background { HoloCard(radius: 18) }
        .overlay { ShimmerBorder(radius: 18, motion: motion) }
        .foregroundStyle(SciFiPalette.textPrimary.color)
        .onAppear { cx.bridgeSeen = true; cx.queue.sync(open: model.inbox.open) }
        .onChange(of: model.inbox.open.map(\.id)) { _, _ in cx.queue.sync(open: model.inbox.open) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bridge")
    }

    // MARK: system pulse

    private var live: Bool { if case .online = model.connection { return model.socketIsOpen }; return false }

    private var header: some View {
        HStack(spacing: 8) {
            HUDLabel(text: "Bridge")
            Spacer()
            ZStack {
                Circle().fill(live ? Color.green : Color.orange).frame(width: 8, height: 8)
                if live { PulseRing(color: .green, motion: motion).frame(width: 8, height: 8) }
            }
            HUDLabel(text: live ? "Link live" : linkText, color: live ? .green : .orange)
            if case .online(let v) = model.connection { HUDLabel(text: "v" + v, color: SciFiPalette.textSecondary.color) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(live ? "System online" : "System \(linkText)")
    }

    private var linkText: String {
        switch model.connection {
        case .online: return "Link idle"
        case .connecting: return "Linking"
        case .macOffline: return "Mac offline"
        case .accessOff: return "Access off"
        case .unauthorized: return "Session ended"
        case .offline: return "Offline"
        case .signedOut: return "Signed out"
        }
    }

    // MARK: needs you

    @ViewBuilder private var needsYou: some View {
        let open = model.inbox.open
        let top = cx.queue.top.flatMap { id in open.first { $0.id == id } } ?? open.first
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 0) {
                Text("\(open.count)").font(.title.monospacedDigit().weight(.bold))
                    .foregroundStyle(open.isEmpty ? SciFiPalette.textSecondary.color : Color.orange)
                    .contentTransition(.numericText())
                HUDLabel(text: "Needs you", color: SciFiPalette.textSecondary.color)
            }
            .frame(minWidth: 72)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(open.count) decisions need you")
            if let top {
                VStack(alignment: .leading, spacing: 6) {
                    Text(top.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                    HStack(spacing: 8) {
                        if let opt = DecisionQueue.swipeOption(top) {
                            Button {
                                cx.stager.stage(item: top, option: opt, note: nil)
                                ThemeSound.play(store)
                            } label: {
                                Label(opt.label, systemImage: "checkmark").font(.caption.weight(.bold)).lineLimit(1)
                            }
                            .themedProminent().controlSize(.small)
                            .disabled(cx.stager.isStaged(top.id))
                            .accessibilityLabel("Answer \(opt.label) to \(top.title)")
                            .accessibilityIdentifier("bridge.answer")
                        }
                        Button { model.router.openInbox(top.id) } label: { Text("Open").font(.caption.weight(.semibold)) }
                            .buttonStyle(.bordered).controlSize(.small)
                            .accessibilityIdentifier("bridge.open")
                    }
                }
            } else {
                Text("Nothing waiting on you.").font(.subheadline).foregroundStyle(SciFiPalette.textSecondary.color)
            }
            Spacer(minLength: 0)
        }
        .sensoryFeedback(.success, trigger: cx.stager.pending.count)
    }

    // MARK: since you last looked

    @ViewBuilder private var sinceLastLook: some View {
        if let d = cx.digest {
            VStack(alignment: .leading, spacing: 4) {
                HUDLabel(text: "Since \(d.since.formatted(.relative(presentation: .named)))", color: SciFiPalette.textSecondary.color)
                Text(d.isEmpty ? "No change." : d.lines.joined(separator: " · ")).font(.footnote.monospaced())
                    .foregroundStyle(d.isEmpty ? SciFiPalette.textSecondary.color : SciFiPalette.textPrimary.color)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("bridge.since")
        } else if cx.baseline == nil {
            VStack(alignment: .leading, spacing: 4) {
                HUDLabel(text: "Since last look", color: SciFiPalette.textSecondary.color)
                Text("Tracking from now — next time this shows what changed.").font(.footnote).foregroundStyle(SciFiPalette.textSecondary.color)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("bridge.since")
        }
    }

    // MARK: live agents

    private var agents: [EmployeeCard] {
        model.office.cards.filter { $0.employee.virtual != true && ($0.employee.state == .working || $0.session?.status == .running || $0.session?.status == .waiting) }
    }

    @ViewBuilder private var liveAgents: some View {
        let list = agents
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10)) : AnyLayout(HStackLayout(alignment: .center, spacing: 12))
        layout {
            Radar(blips: list.map { ($0.employee.name, $0.employee.state.glyph.tint) }, motion: motion)
                .frame(width: 76, height: 76)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                HUDLabel(text: "\(list.count) agent\(list.count == 1 ? "" : "s") live", color: SciFiPalette.textSecondary.color)
                if list.isEmpty {
                    Text("Nobody is running right now.").font(.footnote).foregroundStyle(SciFiPalette.textSecondary.color)
                }
                ForEach(list.prefix(3)) { c in
                    Button { model.router.talk(to: c.employee.id) } label: {
                        HStack(spacing: 6) {
                            Image(systemName: c.employee.state.glyph.symbol).foregroundStyle(c.employee.state.glyph.tint).font(.caption)
                            Text(c.employee.name).font(.footnote.weight(.semibold))
                            Text(c.currentWork?.title ?? c.employee.state.glyph.label).font(.footnote)
                                .foregroundStyle(SciFiPalette.textSecondary.color).lineLimit(1)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(c.employee.name), \(c.employee.state.glyph.label): \(c.currentWork?.title ?? "")")
                }
                if list.count > 3 { Text("+\(list.count - 3) more").font(.caption).foregroundStyle(SciFiPalette.textSecondary.color) }
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .contain)
    }

    // MARK: counts

    @ViewBuilder private var counts: some View {
        if let plan = model.plan.plan {
            HStack(spacing: 0) {
                ForEach(ItemStatus.order.filter { !ItemStatus.rework.contains($0) || plan.counts[$0.rawValue] != nil }, id: \.self) { s in
                    VStack(spacing: 2) {
                        Image(systemName: s.glyph.symbol).foregroundStyle(s.glyph.tint).font(.caption)
                        Text("\(plan.counts[s.rawValue] ?? 0)").font(.caption.monospacedDigit().weight(.semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(plan.counts[s.rawValue] ?? 0) \(s.glyph.label)")
                }
            }
            .padding(.vertical, 6)
            .background(SciFiPalette.backgroundTop.color(0.5), in: RoundedRectangle(cornerRadius: 10))
            .contentShape(Rectangle())
            .onTapGesture { model.router.planBoard = true }
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("Opens the board")
        }
    }

    // MARK: command prompt

    private var prompt: some View {
        Button { cx.showPalette = true } label: {
            HStack(spacing: 8) {
                Text(">").font(.subheadline.monospaced().weight(.bold)).foregroundStyle(SciFiPalette.accent.color)
                Text("Jump to anything…").font(.subheadline.monospaced()).foregroundStyle(SciFiPalette.textSecondary.color)
                Spacer()
                Image(systemName: "command").foregroundStyle(SciFiPalette.accent.color)
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(SciFiPalette.backgroundTop.color(0.6), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(SciFiPalette.accent.color(0.35), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Command palette")
        .accessibilityHint("Search for any epic, story, decision, person or room, or run an action")
        .accessibilityIdentifier("bridge.command")
    }
}

/// A radar: rings, a sweep (4 s a turn at full motion, still otherwise) and one blip per live agent,
/// placed by name so a person keeps their spot.
struct Radar: View {
    let blips: [(name: String, tint: Color)]
    let motion: MotionLevel
    @Environment(\.scenePhase) private var phase
    @State private var visible = false

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: motion != .full || !visible || phase != .active)) { ctx in
            Canvas { g, size in
                let c = CGPoint(x: size.width / 2, y: size.height / 2)
                let r = min(size.width, size.height) / 2 - 1
                for k in 1...3 {
                    let rr = r * Double(k) / 3
                    g.stroke(Path(ellipseIn: CGRect(x: c.x - rr, y: c.y - rr, width: rr * 2, height: rr * 2)), with: .color(SciFiPalette.accent.color(0.25)), lineWidth: 0.7)
                }
                var cross = Path()
                cross.move(to: CGPoint(x: c.x - r, y: c.y)); cross.addLine(to: CGPoint(x: c.x + r, y: c.y))
                cross.move(to: CGPoint(x: c.x, y: c.y - r)); cross.addLine(to: CGPoint(x: c.x, y: c.y + r))
                g.stroke(cross, with: .color(SciFiPalette.accent.color(0.15)), lineWidth: 0.5)
                let angle = motion == .full ? (ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 4) / 4) * 2 * .pi : -.pi / 4
                var wedge = Path()
                wedge.move(to: c)
                wedge.addArc(center: c, radius: r, startAngle: .radians(angle - 0.6), endAngle: .radians(angle), clockwise: false)
                wedge.closeSubpath()
                g.fill(wedge, with: .linearGradient(Gradient(colors: [SciFiPalette.accent.color(0), SciFiPalette.accent.color(0.35)]),
                                                    startPoint: CGPoint(x: c.x + cos(angle - 0.6) * r, y: c.y + sin(angle - 0.6) * r),
                                                    endPoint: CGPoint(x: c.x + cos(angle) * r, y: c.y + sin(angle) * r)))
                for b in blips {
                    let h = AvatarPalette.index(for: b.name)
                    let a = Double(AvatarPalette.index(for: b.name + "#a") * 51 + h * 13).truncatingRemainder(dividingBy: 360) * .pi / 180
                    let d = r * (0.35 + 0.55 * Double((h * 37) % 100) / 100)
                    let p = CGPoint(x: c.x + cos(a) * d, y: c.y + sin(a) * d)
                    // Brighter just after the sweep passes.
                    var since = (angle - a).truncatingRemainder(dividingBy: 2 * .pi); if since < 0 { since += 2 * .pi }
                    let glow = motion == .full ? max(0.45, 1 - since / (2 * .pi)) : 1
                    g.fill(Path(ellipseIn: CGRect(x: p.x - 3, y: p.y - 3, width: 6, height: 6)), with: .color(b.tint.opacity(glow)))
                }
            }
        }
        .onAppear { visible = true }
        .onDisappear { visible = false }
    }
}
