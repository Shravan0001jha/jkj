import SwiftUI

// Pieces the v2 screens share: navigation routes, the progress bar, item rows, epic cards and
// the people menu used to assign anything to anyone (the owner included).

// MARK: - Routes (any tab's NavigationStack can open these)

struct ItemRoute: Hashable { let id: String }
struct ReleasePostRoute: Hashable { let id: String }
struct RoomRoute: Hashable { let id: String }
struct ThreadRoute: Hashable { let id: String }

extension View {
    /// Item pages, release posts, rooms and threads: reachable from every tab.
    func v2Destinations() -> some View {
        navigationDestination(for: ItemRoute.self) { ItemDetailView(id: $0.id) }
            .navigationDestination(for: ReleasePostRoute.self) { ReleasePostView(id: $0.id) }
            .navigationDestination(for: RoomRoute.self) { RoomDetailView(id: $0.id) }
            .navigationDestination(for: ThreadRoute.self) { ThreadView(id: $0.id) }
    }
}

// MARK: - Progress

/// Points done / total as a bar; when nothing is pointed yet, stories done / total, said so.
struct EpicProgressBar: View {
    let progress: EpicProgress

    private var fraction: Double { min(1, max(0, progress.pct / 100)) }
    private var label: String {
        if progress.pointsTotal > 0 { return "\(progress.pointsDone) / \(progress.pointsTotal) pts" }
        if progress.storiesTotal > 0 { return "\(progress.storiesDone) / \(progress.storiesTotal) stories · no points yet" }
        return "No stories yet"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color(.tertiarySystemFill))
                    Capsule().fill(fraction >= 1 ? Color.green : Color.accentColor).frame(width: max(fraction > 0 ? 6 : 0, g.size.width * fraction))
                }
            }
            .frame(height: 6)
            HStack {
                Text(label)
                Spacer()
                Text("\(Int(progress.pct.rounded()))%").monospacedDigit()
            }
            .font(.caption2).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Progress \(Int(progress.pct.rounded())) percent, \(label)")
    }
}

// MARK: - Rows

/// One story or task: state glyph, title, then assignee · reviewer · points.
struct ItemRow: View {
    @Environment(AppModel.self) private var model
    let item: Item
    var showEpic = false

    var body: some View {
        let g = item.status.glyph
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: g.symbol).foregroundStyle(g.tint).frame(width: 22).padding(.top, 1)
                .accessibilityLabel(g.label)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title).font(.subheadline.weight(.medium)).lineLimit(2)
                Text(meta).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                if let b = item.blocked {
                    Text("Waiting on \(model.employeeName(b.waitingOn)): \(b.reason)").font(.caption).foregroundStyle(.red).lineLimit(2)
                } else if let s = item.stall {
                    Text(s.line).font(.caption).foregroundStyle(.orange).lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var meta: String {
        var parts = [g(item.status), model.employeeName(item.assigneeId)]
        if let r = item.reviewerId { parts.append("review: \(model.employeeName(r))") }
        if let p = item.points { parts.append("\(p) pt\(p == 1 ? "" : "s")") }
        if showEpic, let e = item.epicId, e != item.id, let card = model.plan.epic(e) { parts.append(card.epic.title) }
        return parts.joined(separator: " · ")
    }

    private func g(_ s: ItemStatus) -> String { s.glyph.label }
}

extension ItemStall {
    /// "Stalled: in review 4 d, untouched" — minutes in the owner's units.
    var line: String {
        let span = Format.duration(minutes * 60)
        switch rule {
        case .notStarted: return "Stalled: ready \(span), not started"
        case .idle: return "Stalled: no activity for \(span)"
        case .unreviewed: return "Stalled: in review \(span), untouched"
        case .unknown: return "Stalled for \(span)"
        }
    }
}

/// An epic on the Plan: focus mark, state, owner, progress, next milestone, blocked/stalled flags.
struct EpicCardView: View {
    @Environment(AppModel.self) private var model
    let card: EpicCard

    var body: some View {
        let e = card.epic
        VStack(alignment: .leading, spacing: 8) {
            Text(e.title).font(.headline).lineLimit(2)
            HStack(spacing: 8) {
                StateLabel(glyph: e.status.glyph, compact: true)
                if card.inFocus { Pill(text: "Focus", symbol: "scope", tint: .orange) }
                Spacer()
                Label(e.ownerId.map { model.employeeName($0) } ?? "No owner", systemImage: "person.crop.circle")
                    .font(.caption).foregroundStyle(e.ownerId == nil ? .tertiary : .secondary)
                    .labelStyle(.titleAndIcon)
            }
            EpicProgressBar(progress: card.progress)
            if let next = card.next {
                Label("Next: \(next.title)", systemImage: "arrow.turn.down.right").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            ForEach(Array(card.flags.prefix(2).enumerated()), id: \.offset) { _, f in FlagLine(flag: f) }
            if card.flags.count > 2 {
                Text("+\(card.flags.count - 2) more \(card.flags.dropFirst(2).allSatisfy { $0.kind == .stalled } ? "stalled" : "flagged")")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
        .padding(.leading, card.inFocus ? 8 : 0)
        .overlay(alignment: .leading) {
            if card.inFocus { Capsule().fill(Color.orange).frame(width: 4).padding(.vertical, 2) }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A blocked or stalled story on an epic card, with its reason and who it is waiting on.
struct FlagLine: View {
    @Environment(AppModel.self) private var model
    let flag: PlanFlag

    var body: some View {
        let blocked = flag.kind == .blocked
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: blocked ? "octagon.fill" : "hourglass").foregroundStyle(blocked ? .red : .orange).font(.caption)
            VStack(alignment: .leading, spacing: 1) {
                Text(blocked ? "Blocked" + (flag.waitingOn.map { " · waiting on \(model.employeeName($0))" } ?? "") : "Stalled")
                    .font(.caption.weight(.semibold)).foregroundStyle(blocked ? .red : .orange)
                Text(Self.humanize(flag.reason)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// The server says "In review for 6529 min, untouched": the owner reads days and hours.
    static func humanize(_ reason: String) -> String {
        guard let m = reason.firstMatch(of: /(\d+) min/), let n = Int(m.1), n >= 60 else { return reason }
        return reason.replacingCharacters(in: m.range, with: Format.duration(n * 60))
    }
}

// MARK: - People

/// A menu to pick a person: the owner ("Me") first, then everyone in the Office.
struct PersonMenu<Label: View>: View {
    @Environment(AppModel.self) private var model
    let title: String
    let current: String?
    var allowNone = false
    let pick: (String?) -> Void
    @ViewBuilder let label: () -> Label

    var body: some View {
        Menu {
            Section(title) {
                ForEach(model.assignees, id: \.id) { p in
                    Button { pick(p.id) } label: {
                        if p.id == current { SwiftUI.Label(p.name, systemImage: "checkmark") } else { Text(p.name) }
                    }
                }
                if allowNone { Button("Nobody", role: .destructive) { pick(nil) } }
            }
        } label: { label() }
    }
}

/// "Assignee   Dev ›" — a field row that opens a menu.
struct FieldRow: View {
    let title: String
    let value: String
    var symbol: String? = nil
    var tint: Color = .primary

    var body: some View {
        HStack {
            Text(title).foregroundStyle(.secondary)
            Spacer()
            if let symbol { Image(systemName: symbol).foregroundStyle(tint) }
            Text(value).foregroundStyle(tint == .primary ? Color.primary : tint)
            Image(systemName: "chevron.up.chevron.down").font(.caption2).foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }
}

/// `@name` in the accent colour.
func mentionHighlighted(_ text: String, font: Font = .subheadline) -> AttributedString {
    var a = AttributedString(text)
    for m in text.matches(of: /@([A-Za-z0-9_-]+)/) {
        if let r = a.range(of: String(m.0)) {
            a[r].foregroundColor = .accentColor
            a[r].font = font.weight(.semibold)
        }
    }
    return a
}
