import SwiftUI

// One chat component for every conversation in Talk (the COO, Asha, each employee) — the same
// spec the Android app is built to (owner, 2 Oct): avatar + presence + name + status in the top
// bar; bottom-anchored messages with day separators; consecutive messages grouped and no name
// repeated in a 1:1; the owner's bubbles on the right in the accent colour, others on the left in
// the surface colour, ~80% max width, the time small at the bottom-right inside the bubble; text
// never truncated (only `details` folds); raw ids turned into titled chips; Workplace and system
// notes folded into one thin centred caption; typing as a small bubble with animated dots; a
// one-row composer with a pill field (up to 5 lines) and a round send button.

// MARK: - The model the component renders

struct ChatItem: Identifiable, Equatable {
    enum Kind: Equatable {
        case message(mine: Bool, text: String, details: String?)
        /// Workplace/system notes and tool runs: one thin caption; the steps open on tap.
        case note(text: String, steps: [LogEntry], error: Bool)
    }
    let id: String
    let at: String
    let kind: Kind

    var mine: Bool? { if case .message(let m, _, _) = kind { return m }; return nil }
}

extension ChatItem {
    /// A session log, after `ChatView.collapse` (tool runs, Workplace prompts, system notes folded).
    static func from(log: [LogEntry]) -> [ChatItem] {
        log.map { e in
            switch e.kind {
            case .user where e.from != .workplace:
                return ChatItem(id: e.id, at: e.at, kind: .message(mine: true, text: e.text, details: nil))
            case .assistant:
                let details = e.details.flatMap { $0 == e.text || $0.isEmpty ? nil : $0 }
                return ChatItem(id: e.id, at: e.at, kind: .message(mine: false, text: e.text, details: details))
            case .image:
                return ChatItem(id: e.id, at: e.at, kind: .message(mine: false, text: "📎 Image", details: nil))
            case .error:
                return ChatItem(id: e.id, at: e.at, kind: .note(text: e.text, steps: [], error: true))
            case .activity:
                return ChatItem(id: e.id, at: e.at, kind: .note(text: e.text, steps: e.activity?.entries ?? [], error: false))
            default:
                // A lone tool run, a stray system note or a Workplace prompt: not a message.
                let label = e.kind == .user ? "Workplace note" : e.kind == .system ? e.text : "worked · \(e.label.isEmpty ? e.kind.rawValue : e.label)"
                return ChatItem(id: e.id, at: e.at, kind: .note(text: label, steps: [e], error: false))
            }
        }
    }

    static func from(coo: [CooMessage]) -> [ChatItem] {
        coo.map { m in
            let details = m.details.flatMap { $0 == m.text || $0.isEmpty ? nil : $0 }
            return ChatItem(id: m.id, at: m.at, kind: .message(mine: m.from == .owner, text: m.text, details: details))
        }
    }
}

/// Grouping and separators, computed once per render (pure; unit-tested).
enum ChatLayout {
    struct Row: Identifiable, Equatable {
        let item: ChatItem
        /// A day label above this row ("Today", "Yesterday", "Mon 29 Sep").
        let day: String?
        /// The previous row is a message on the same side within 5 minutes: tighter, same group.
        let continuesGroup: Bool
        /// The next row continues this group: no tail, time still shown (every bubble has one).
        let groupContinues: Bool
        var id: String { item.id }
    }

    static func rows(_ items: [ChatItem], calendar: Calendar = .current) -> [Row] {
        var out: [Row] = []
        for (i, item) in items.enumerated() {
            let prev = i > 0 ? items[i - 1] : nil
            let next = i + 1 < items.count ? items[i + 1] : nil
            let d = Format.date(item.at)
            let day: String? = {
                guard let d else { return nil }
                if let p = prev.flatMap({ Format.date($0.at) }), calendar.isDate(p, inSameDayAs: d) { return nil }
                return dayLabel(d, calendar: calendar)
            }()
            out.append(Row(item: item, day: day, continuesGroup: day == nil && sameGroup(prev, item), groupContinues: sameGroup(item, next) && !crossesDay(item, next, calendar: calendar)))
        }
        return out
    }

    static func sameGroup(_ a: ChatItem?, _ b: ChatItem?) -> Bool {
        guard let a, let b, let ma = a.mine, let mb = b.mine, ma == mb,
              let da = Format.date(a.at), let db = Format.date(b.at) else { return false }
        return abs(db.timeIntervalSince(da)) < 300
    }

    private static func crossesDay(_ a: ChatItem, _ b: ChatItem?, calendar: Calendar) -> Bool {
        guard let b, let da = Format.date(a.at), let db = Format.date(b.at) else { return false }
        return !calendar.isDate(da, inSameDayAs: db)
    }

    static func dayLabel(_ d: Date, calendar: Calendar = .current) -> String {
        if calendar.isDateInToday(d) { return "Today" }
        if calendar.isDateInYesterday(d) { return "Yesterday" }
        return d.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
    }
}

// MARK: - Raw ids become titled chips

enum IdLinks {
    /// Item, epic, thread, decision and release-post ids as the Workplace writes them.
    static let pattern = /\b(?:as|ft|th|in|rp)_[A-Za-z0-9_]{4,}\b/

    static func ids(in text: String) -> [String] {
        text.matches(of: pattern).map { String($0.0) }
    }

    /// What a chip says when the title is not known yet: never the bare id.
    static func placeholder(_ id: String) -> String {
        if id.hasPrefix("ft_") { return "an epic" }
        if id.hasPrefix("as_") { return "a story" }
        if id.hasPrefix("th_") { return "a thread" }
        if id.hasPrefix("in_") { return "a decision" }
        if id.hasPrefix("rp_") { return "a release" }
        return "an item"
    }

    static func url(for id: String) -> URL? {
        let route: String
        switch id.prefix(3) {
        case "th_": route = "room"
        case "in_": route = "inbox"
        case "rp_": route = "releases"
        default: route = "item"
        }
        return URL(string: "\(AuthCallback.scheme)://\(route)/\(id)")
    }

    /// Plain text with every id replaced by its title (list previews): never a bare id.
    static func plain(_ text: String, title: (String) -> String?) -> String {
        var out = text
        for id in Set(ids(in: text)) { out = out.replacingOccurrences(of: id, with: "“\(title(id) ?? placeholder(id))”") }
        return out
    }

    /// The text with every id replaced by a tappable chip carrying the item's title.
    static func linkified(_ text: String, mine: Bool, title: (String) -> String?) -> AttributedString {
        var out = AttributedString()
        var rest = Substring(headingsAsBold(text))
        while let m = rest.firstMatch(of: pattern) {
            out += inline(String(rest[..<m.range.lowerBound]))
            let id = String(m.0)
            let name = title(id).map { $0.count > 48 ? String($0.prefix(46)) + "…" : $0 } ?? placeholder(id)
            var chip = AttributedString("\u{2009}◆ \(name)\u{2009}")
            chip.link = url(for: id)
            chip.foregroundColor = mine ? .white : .accentColor
            chip.backgroundColor = mine ? Color.white.opacity(0.22) : Color.accentColor.opacity(0.12)
            chip.font = .subheadline.weight(.semibold)
            out += chip
            rest = rest[m.range.upperBound...]
        }
        out += inline(String(rest))
        return out
    }

    /// `**bold**`, `code`, _italic_ as the agents write them; never fails (plain text fallback).
    private static func inline(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }

    /// "## Plan" reads as a bold line in a chat bubble, not as two hashes.
    static func headingsAsBold(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
            guard let m = line.wholeMatch(of: /#{1,6}\s+(.+)/) else { return String(line) }
            return "**\(m.1)**"
        }.joined(separator: "\n")
    }
}

extension AppModel {
    /// The title for an id from whatever is loaded: plan, item pages, rooms, inbox, releases.
    func title(forId id: String) -> String? {
        if let d = items.details[id] { return d.item.title }
        for d in items.details.values {
            if let c = d.children.first(where: { $0.id == id }) { return c.title }
            if d.parent?.id == id { return d.parent?.title }
            if d.epic?.id == id { return d.epic?.title }
        }
        if let p = plan.plan {
            if let c = (p.areas.flatMap(\.epics) + p.unfiled).first(where: { $0.epic.id == id }) { return c.epic.title }
            if let m = p.mine.first(where: { $0.id == id }) { return m.title }
        }
        if let b = plan.board?.values.flatMap({ $0 }).first(where: { $0.id == id }) { return b.title }
        if let t = room.thread(id) { return t.title }
        if let t = rooms.details.values.flatMap(\.threads).first(where: { $0.id == id }) { return t.title }
        if id.hasPrefix("th_epic_"), let e = title(forId: String(id.dropFirst("th_epic_".count))) { return e }
        if let i = inbox.item(id) { return i.title }
        if let r = releasePosts.post(id) { return r.title }
        return nil
    }

    /// Fetch the titles a chat mentions but nothing loaded yet (items only; a handful at a time).
    func loadTitles(in texts: [String]) async {
        guard let rest else { return }
        let missing = Set(texts.flatMap(IdLinks.ids(in:))).filter { ($0.hasPrefix("as_") || $0.hasPrefix("ft_")) && title(forId: $0) == nil }
        for id in missing.prefix(8) { await items.load(rest, id: id) }
    }
}

// MARK: - The component

struct ChatThreadView<Header: View, Footer: View, Trailing: View>: View {
    @Environment(AppModel.self) private var model
    let items: [ChatItem]
    let typing: Bool
    let typingName: String
    let loading: Bool
    let emptyTitle: String
    let emptyText: String
    let placeholder: String
    @Binding var draft: String
    let sending: Bool
    let onSend: () -> Void
    /// Extra composer control beside send (Interrupt while a session runs).
    @ViewBuilder let trailing: () -> Trailing
    /// Above the messages (a one-line banner); not a message itself.
    @ViewBuilder let header: () -> Header
    /// Below the messages (an approval card, an error).
    @ViewBuilder let footer: () -> Footer
    var onOpen: (AppLink) -> Void = { _ in }
    @FocusState private var focused: Bool

    var body: some View {
        let rows = ChatLayout.rows(items)
        VStack(spacing: 0) {
            header()
            GeometryReader { geo in
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if loading && items.isEmpty {
                            ProgressView().padding(24)
                        } else if items.isEmpty {
                            VStack(spacing: 6) {
                                Text(emptyTitle).font(.headline)
                                Text(emptyText).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                            }
                            .padding(32)
                        }
                        ForEach(rows) { row in
                            if let day = row.day { DaySeparator(text: day) }
                            ChatRowView(row: row, maxBubbleWidth: (geo.size.width * 0.8).rounded(.down))
                                .padding(.top, row.continuesGroup ? 2 : 8)
                                .id(row.id)
                        }
                        if typing {
                            TypingBubble(name: typingName).padding(.top, 8).id("typing")
                        }
                        footer().padding(.top, 8)
                        Color.clear.frame(height: 8).id("bottom")
                    }
                    .padding(.horizontal, 10)
                }
                .defaultScrollAnchor(.bottom)
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: items.count) { _, _ in withAnimation(.snappy) { proxy.scrollTo("bottom", anchor: .bottom) } }
                .onChange(of: typing) { _, t in if t { withAnimation(.snappy) { proxy.scrollTo("bottom", anchor: .bottom) } } }
                .onChange(of: focused) { _, f in if f { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } } } }
            }
            }
            ChatComposer(placeholder: placeholder, draft: $draft, sending: sending, focused: $focused, onSend: onSend, trailing: trailing)
        }
        .environment(\.openURL, OpenURLAction { url in
            if let link = AppLink.parse(url: url) { onOpen(link); return .handled }
            return .systemAction
        })
        .task(id: items.count) { await model.loadTitles(in: items.compactMap { if case .message(_, let t, let d) = $0.kind { return t + " " + (d ?? "") }; return nil }) }
    }
}

/// A message bubble or a note caption.
struct ChatRowView: View {
    @Environment(AppModel.self) private var model
    let row: ChatLayout.Row
    /// About 80% of the screen: the widest a bubble gets.
    var maxBubbleWidth: CGFloat = 300
    @State private var showDetails = false
    @State private var showSteps = false

    var body: some View {
        switch row.item.kind {
        case .message(let mine, let text, let details):
            bubble(mine: mine, text: text, details: details)
        case .note(let text, let steps, let error):
            note(text, steps: steps, error: error)
        }
    }

    private func bubble(mine: Bool, text: String, details: String?) -> some View {
        HStack(spacing: 0) {
            if mine { Spacer(minLength: 0) }
            // Trailing-aligned stack: the bubble is as wide as its widest line (never the full
            // 80%), and the time sits at its bottom-right.
            VStack(alignment: .trailing, spacing: 3) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(IdLinks.linkified(text, mine: mine) { model.title(forId: $0) })
                        .font(.subheadline)
                        .foregroundStyle(mine ? Color.white : Color.primary)
                        .tint(mine ? .white : .accentColor)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    if let details {
                        if showDetails {
                            Text(IdLinks.linkified(details, mine: mine) { model.title(forId: $0) })
                                .font(.footnote)
                                .foregroundStyle(mine ? Color.white.opacity(0.9) : Color.secondary)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Button { withAnimation(.snappy) { showDetails.toggle() } } label: {
                            Label(showDetails ? "Hide details" : "Details", systemImage: showDetails ? "chevron.up" : "chevron.down")
                                .font(.caption.weight(.semibold))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(mine ? Color.white.opacity(0.9) : Color.accentColor)
                    }
                }
                Text(Format.time(row.item.at)).font(.caption2).foregroundStyle(mine ? Color.white.opacity(0.75) : Color.secondary)
            }
            .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 6)
            .background(mine ? Color.accentColor : Color(.secondarySystemBackground),
                        in: UnevenRoundedRectangle(cornerRadii: corners(mine: mine), style: .continuous))
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(mine ? "chat.mine" : "chat.theirs")
            .frame(maxWidth: maxBubbleWidth, alignment: mine ? .trailing : .leading)
            if !mine { Spacer(minLength: 0) }
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }

    /// 18 pt everywhere; the corner toward the speaker tightens inside a group.
    private func corners(mine: Bool) -> RectangleCornerRadii {
        let r: CGFloat = 18, tight: CGFloat = 6
        let top = row.continuesGroup ? tight : r
        let bottom = row.groupContinues ? tight : r
        return mine
            ? RectangleCornerRadii(topLeading: r, bottomLeading: r, bottomTrailing: bottom, topTrailing: top)
            : RectangleCornerRadii(topLeading: top, bottomLeading: bottom, bottomTrailing: r, topTrailing: r)
    }

    private func note(_ text: String, steps: [LogEntry], error: Bool) -> some View {
        VStack(spacing: 4) {
            Button { if !steps.isEmpty { withAnimation(.snappy) { showSteps.toggle() } } } label: {
                HStack(spacing: 6) {
                    Rectangle().fill(Color(.separator)).frame(height: 0.5)
                    Text(text).font(.caption2).foregroundStyle(error ? Color.red : Color.secondary).lineLimit(1).layoutPriority(1)
                    if !steps.isEmpty { Image(systemName: showSteps ? "chevron.up" : "chevron.down").font(.system(size: 8)).foregroundStyle(.tertiary) }
                    Rectangle().fill(Color(.separator)).frame(height: 0.5)
                }
            }
            .buttonStyle(.plain)
            if showSteps {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(steps) { e in
                        Text(e.label.isEmpty ? e.text : "\(e.label): \(e.text)").font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(4)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat.note")
    }
}

/// The other side is writing: a small bubble with three dots.
struct TypingBubble: View {
    let name: String
    @State private var phase = 0
    private let timer = Timer.publish(every: 0.35, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack {
            HStack(spacing: 4) {
                ForEach(0..<3) { i in
                    Circle().fill(Color.secondary).frame(width: 7, height: 7).opacity(phase == i ? 1 : 0.3)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            Spacer(minLength: 0)
        }
        .onReceive(timer) { _ in phase = (phase + 1) % 3 }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(name) is typing")
    }
}

/// One row: a pill field that grows to five lines, and a round send button centred against it.
struct ChatComposer<Trailing: View>: View {
    let placeholder: String
    @Binding var draft: String
    let sending: Bool
    var focused: FocusState<Bool>.Binding
    let onSend: () -> Void
    @ViewBuilder let trailing: () -> Trailing

    private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !sending }

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            TextField(placeholder, text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .font(.body)
                .focused(focused)
                .padding(.horizontal, 14).padding(.vertical, 9)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Color(.separator).opacity(0.6), lineWidth: 0.5))
                .accessibilityIdentifier("chat.composer")
            trailing()
            Button(action: onSend) {
                ZStack {
                    Circle().fill(canSend ? Color.accentColor : Color(.tertiarySystemFill))
                    if sending { ProgressView().tint(.white) } else {
                        Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold)).foregroundStyle(canSend ? Color.white : Color.secondary)
                    }
                }
                .frame(width: 36, height: 36)
            }
            .disabled(!canSend)
            .accessibilityLabel("Send")
            .accessibilityIdentifier("chat.send")
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(.bar)
    }
}

/// The top bar: avatar with initials and presence, the name, a status line.
struct ChatTitle: View {
    let name: String
    let subtitle: String
    let online: Bool?
    var tint: Color = .accentColor

    var body: some View {
        HStack(spacing: 8) {
            ZStack(alignment: .bottomTrailing) {
                InitialsAvatar(name: name, size: 32, tint: tint)
                PresenceDot(online: online).offset(x: 1, y: 1)
            }
            VStack(alignment: .leading, spacing: 0) {
                Text(name).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(subtitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat.title")
    }
}
