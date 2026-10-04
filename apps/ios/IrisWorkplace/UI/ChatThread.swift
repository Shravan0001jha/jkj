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
    /// Who wrote it, when it isn't the owner or the person this 1:1 is with (the COO writing into
    /// an employee's session, say): shown above the bubble. Never "You" for someone else's words.
    var sender: String? = nil
    /// The message this one answers, quoted at the top of the bubble.
    var replyTo: ChatQuote? = nil
    /// The owner's own messages: sent, then read once the agent took it in.
    var receipt: ChatReceipt? = nil
    /// Photos, files and voice notes on the message.
    var attachments: [ChatAttachment] = []

    var mine: Bool? { if case .message(let m, _, _) = kind { return m }; return nil }
    var text: String? { if case .message(_, let t, _) = kind { return t }; return nil }
    var details: String? { if case .message(_, _, let d) = kind { return d }; return nil }
}

/// A quoted message: who wrote it and its first words.
struct ChatQuote: Equatable {
    let id: String
    let sender: String
    let text: String
}

enum ChatReceipt: Equatable {
    case sending, sent, read
}

extension ChatItem {
    /// A session log, after `ChatView.collapse` (tool runs, Workplace prompts, system notes folded).
    static func from(log: [LogEntry]) -> [ChatItem] {
        log.map { e in
            switch e.kind {
            case .user where e.from == nil || e.from == .owner:
                return ChatItem(id: e.id, at: e.at, kind: .message(mine: true, text: e.text, details: nil))
            case .user where e.from != .workplace:
                // The COO or another employee wrote into this session (LLD-app-fixes §1): their bubble, named.
                var item = ChatItem(id: e.id, at: e.at, kind: .message(mine: false, text: e.text, details: nil))
                item.sender = e.fromName ?? "Someone else"
                return item
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

    /// Talk thread messages (LLD-app-fixes §2): the real sender on every bubble — "You" only for
    /// the owner's own; the counterpart unnamed (a 1:1); anyone else (the COO writing into an
    /// employee's thread, another employee) named above the bubble. Workplace prompts fold into a note.
    static func from(talk: [TalkMessage], threadId: String, sentFiles: [String: URL] = [:]) -> [ChatItem] {
        talk.map { m in
            if m.from == "workplace" {
                let line = m.text.split(separator: "\n").first.map(String.init) ?? ""
                return ChatItem(id: m.id, at: m.at, kind: .note(text: "Workplace · \(line)", steps: [], error: false))
            }
            let mine = m.from == "owner"
            var atts: [ChatAttachment] = m.attachments.map { a in
                let isVoice = a.kind == .voice || a.id == m.voice?.attachmentId
                return ChatAttachment(id: a.id, kind: isVoice ? .voice : a.kind == .image ? .image : (a.kind == .file ? .file : ChatAttachment.kind(for: a.mediaType)),
                                      name: a.name, mediaType: a.mediaType, size: a.size, path: a.url, localURL: sentFiles[a.id],
                                      durationMs: isVoice ? m.voice?.durationMs : nil, transcript: isVoice ? m.voice?.transcript : nil)
            }
            if let v = m.voice, !atts.contains(where: { $0.id == v.attachmentId }) {
                atts.append(ChatAttachment(id: v.attachmentId, kind: .voice, name: "Voice note", mediaType: "audio/mp4", path: "/api/talk/attachments/\(v.attachmentId)",
                                           localURL: sentFiles[v.attachmentId], durationMs: v.durationMs, transcript: v.transcript))
            }
            // A voice note's text is its transcript, shown under the player: not twice.
            let text = m.voice != nil ? "" : m.text
            let counterpart = m.from == threadId
            var item = ChatItem(id: m.id, at: m.at, kind: .message(mine: mine, text: text, details: nil))
            item.sender = mine || counterpart ? nil : m.fromName
            item.replyTo = m.replyTo.map { ChatQuote(id: $0.id, sender: $0.from == "owner" ? "You" : $0.fromName, text: $0.text) }
            item.attachments = atts
            if mine {
                item.receipt = m.id.hasPrefix("local-") ? .sending : m.receipt == .read ? .read : .sent
            }
            return item
        }
    }

    static func from(coo: [CooMessage]) -> [ChatItem] {
        coo.map { m in
            let details = m.details.flatMap { $0 == m.text || $0.isEmpty ? nil : $0 }
            var item = ChatItem(id: m.id, at: m.at, kind: .message(mine: m.from == .owner, text: m.text, details: details))
            item.attachments = (m.attachments ?? []).map { a in
                ChatAttachment(id: a.id, kind: a.kind == .voice ? .voice : a.kind == .image ? .image : a.kind == .file ? .file : ChatAttachment.kind(for: a.mediaType),
                               name: a.name, mediaType: a.mediaType, size: a.size, path: a.url)
            }
            return item
        }
    }
}

/// A reply the server can't carry as a field yet travels as a quote line the agent reads.
enum ChatReply {
    static func compose(_ text: String, replyTo: ChatItem?, counterpart: String) -> String {
        guard let r = replyTo, let quoted = r.text else { return text }
        let who = r.mine == true ? "me" : (r.sender ?? counterpart)
        let line = MessageMenu.plain(quoted).replacingOccurrences(of: "\n", with: " ")
        let short = line.count > 140 ? String(line.prefix(139)) + "…" : line
        return "> \(who): \(short)\n\n\(text)"
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

// MARK: - Quote, receipt, reply strip

/// The quoted message at the top of a reply bubble.
struct QuoteBlock: View {
    let quote: ChatQuote
    let mine: Bool

    var body: some View {
        HStack(spacing: 6) {
            RoundedRectangle(cornerRadius: 1.5).fill(mine ? Color.white.opacity(0.8) : Color.accentColor).frame(width: 3)
            VStack(alignment: .leading, spacing: 1) {
                Text(quote.sender).font(.caption.weight(.semibold))
                Text(MessageMenu.plain(quote.text)).font(.caption).lineLimit(2)
            }
            .foregroundStyle(mine ? Color.white.opacity(0.9) : Color.secondary)
        }
        .padding(.vertical, 4).padding(.horizontal, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background((mine ? Color.white.opacity(0.15) : Color(.tertiarySystemFill)), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Replying to \(quote.sender): \(quote.text)")
    }
}

/// One tick when sent, two when the agent took the message in.
struct ReceiptMark: View {
    let receipt: ChatReceipt
    var body: some View {
        Group {
            switch receipt {
            case .sending: Image(systemName: "clock")
            case .sent: Image(systemName: "checkmark")
            case .read: Image(systemName: "checkmark.circle.fill")
            }
        }
        .font(.system(size: 9, weight: .bold))
        .accessibilityLabel(receipt == .read ? "Read" : receipt == .sent ? "Sent" : "Sending")
        .accessibilityIdentifier("chat.receipt.\(receipt == .read ? "read" : receipt == .sent ? "sent" : "sending")")
    }
}

/// Above the composer while replying: who and what, and an ✕ to stop replying.
struct ReplyStrip: View {
    let sender: String
    let text: String
    let cancel: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 1.5).fill(Color.accentColor).frame(width: 3, height: 32)
            VStack(alignment: .leading, spacing: 1) {
                Text("Replying to \(sender)").font(.caption.weight(.semibold)).foregroundStyle(Color.accentColor)
                Text(MessageMenu.plain(text)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            Button(action: cancel) { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary).font(.title3) }
                .buttonStyle(.plain)
                .accessibilityLabel("Cancel reply")
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .background(.bar)
        .accessibilityIdentifier("chat.replyStrip")
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
    /// The message the owner is answering (long-press → Reply); shown above the field.
    @Binding var replyTo: ChatItem?
    let sending: Bool
    let onSend: () -> Void
    /// Extra composer control beside send (Interrupt while a session runs).
    @ViewBuilder let trailing: () -> Trailing
    /// Above the messages (a one-line banner); not a message itself.
    @ViewBuilder let header: () -> Header
    /// Below the messages (an approval card, an error).
    @ViewBuilder let footer: () -> Footer
    var onOpen: (AppLink) -> Void = { _ in }
    /// Files waiting to go with the next message; nil when this conversation is text-only.
    var pending: Binding<[OutgoingAttachment]>? = nil
    /// Sends a recorded voice note; nil hides the mic.
    var onVoice: ((OutgoingAttachment) -> Void)? = nil
    var onComposerError: (String) -> Void = { _ in }
    /// Who can be @mentioned from this chat (empty: no mentions here).
    var mentionable: [String] = []
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
                            ChatRowView(row: row, maxBubbleWidth: (geo.size.width * 0.8).rounded(.down),
                                        onReply: { replyTo = $0; focused = true })
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
            if !mentionable.isEmpty {
                MentionSuggestions(draft: $draft, known: mentionable).background(.bar)
            }
            if let r = replyTo {
                ReplyStrip(sender: r.mine == true ? "You" : (r.sender ?? typingName), text: r.text ?? "") { replyTo = nil }
            }
            ChatComposer(placeholder: placeholder, draft: $draft, sending: sending, focused: $focused, onSend: onSend, trailing: trailing,
                         pending: pending, onVoice: onVoice, onError: onComposerError, mentionable: mentionable)
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
    var onReply: ((ChatItem) -> Void)?
    @State private var expanded = false
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
                    if let s = row.item.sender, !mine, !row.continuesGroup {
                        Text(s).font(.caption.weight(.semibold)).foregroundStyle(Color.accentColor)
                            .accessibilityIdentifier("chat.sender")
                    }
                    if let q = row.item.replyTo { QuoteBlock(quote: q, mine: mine) }
                    if !row.item.attachments.isEmpty {
                        AttachmentsView(attachments: row.item.attachments, mine: mine)
                    }
                    if !text.isEmpty || details != nil {
                        MessageTextView(text: text, details: details, expanded: $expanded, mine: mine) {
                            IdLinks.linkified($0, mine: mine) { model.title(forId: $0) }
                        }
                    }
                }
                HStack(spacing: 3) {
                    Text(Format.time(row.item.at))
                    if mine, let r = row.item.receipt { ReceiptMark(receipt: r) }
                }
                .font(.caption2).foregroundStyle(mine ? Color.white.opacity(0.75) : Color.secondary)
            }
            .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 6)
            .background(mine ? Color.accentColor : Color(.secondarySystemBackground),
                        in: UnevenRoundedRectangle(cornerRadii: corners(mine: mine), style: .continuous))
            .contentShape(.contextMenuPreview, UnevenRoundedRectangle(cornerRadii: corners(mine: mine), style: .continuous))
            // Tap anywhere on a long bubble to unfold it; links inside still open on their own.
            .onTapGesture { if MessageBody(text: text, details: details).isLong { withAnimation(.snappy) { expanded.toggle() } } }
            .contextMenu { MessageMenu(text: MessageBody(text: text, details: details).full, onReply: onReply.map { f in { f(row.item) } }) }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(mine ? "chat.mine" : "chat.theirs")
            .accessibilityAction(named: "Reply") { onReply?(row.item) }
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

/// One row: a paperclip, a pill field that grows to five lines, and a round button centred
/// against it — Send when there is something to send, else the mic (hold to record and release to
/// send, slide left to cancel; or tap it to record hands-free with Cancel / Send).
struct ChatComposer<Trailing: View>: View {
    let placeholder: String
    @Binding var draft: String
    let sending: Bool
    var focused: FocusState<Bool>.Binding
    let onSend: () -> Void
    @ViewBuilder let trailing: () -> Trailing
    /// nil: this conversation takes text only (the server has no files for it yet).
    var pending: Binding<[OutgoingAttachment]>? = nil
    /// Sends a voice note at once; nil hides the mic.
    var onVoice: ((OutgoingAttachment) -> Void)? = nil
    var onError: (String) -> Void = { _ in }
    var mentionable: [String] = []

    @State private var recorder = VoiceRecorder()
    @State private var holding = false
    @State private var cancelArmed = false
    @State private var pressStarted: Date?

    private var hasPending: Bool { !(pending?.wrappedValue.isEmpty ?? true) }
    private var canSend: Bool { (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hasPending) && !sending }
    private var showMic: Bool { onVoice != nil && !canSend && !sending }

    var body: some View {
        VStack(spacing: 0) {
            if let pending, !pending.wrappedValue.isEmpty { PendingAttachmentsBar(pending: pending) }
            if recorder.state == .recording {
                RecordingBar(elapsed: recorder.elapsed, holding: holding, cancelArmed: cancelArmed,
                             cancel: { recorder.cancel() }, send: { finishVoice() })
                    .overlay(alignment: .trailing) { if holding { micButton.padding(.trailing, 10) } }
            } else {
                HStack(alignment: .center, spacing: 6) {
                    if let pending {
                        AttachButton(add: { pending.wrappedValue += $0 }, fail: onError)
                    }
                    if !mentionable.isEmpty { MentionButton(draft: $draft, known: mentionable) }
                    TextField(placeholder, text: $draft, axis: .vertical)
                        .lineLimit(1...5)
                        .font(.body)
                        .focused(focused)
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Color(.separator).opacity(0.6), lineWidth: 0.5))
                        .accessibilityIdentifier("chat.composer")
                    trailing()
                    if showMic { micButton } else { sendButton }
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
            }
        }
        .background(.bar)
        .alert("Microphone access is off", isPresented: Binding(get: { recorder.state == .denied }, set: { _ in })) {
            Button("Open Settings") { if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) } }
            Button("Not now", role: .cancel) {}
        } message: { Text("Allow the microphone for Iris Workplace in Settings to record voice notes.") }
    }

    private var sendButton: some View {
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

    /// Press: recording starts. Release after a short press: keep recording hands-free (tap mode).
    /// Release after holding: send, or cancel if slid left.
    private var micButton: some View {
        ZStack {
            Circle().fill(holding ? Color.red : Color.accentColor)
            Image(systemName: "mic.fill").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
        }
        .frame(width: 36, height: 36)
        .scaleEffect(holding ? 1.25 : 1)
        .animation(.snappy, value: holding)
        .contentShape(Circle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { v in
                    if pressStarted == nil {
                        pressStarted = Date()
                        holding = true
                        Task {
                            let ok = await recorder.start()
                            // Released before the recorder came up (a permission prompt, say): tap mode.
                            if !ok { holding = false; pressStarted = nil }
                        }
                    }
                    cancelArmed = v.translation.width < -70
                }
                .onEnded { _ in
                    let held = pressStarted.map { Date().timeIntervalSince($0) } ?? 0
                    pressStarted = nil
                    defer { holding = false; cancelArmed = false }
                    guard recorder.state == .recording else { return }
                    if cancelArmed { recorder.cancel() }
                    else if held >= 0.5 { finishVoice() }
                    // A short tap: keep recording; the bar's Cancel / Send finish it.
                }
        )
        .accessibilityLabel("Record a voice note")
        .accessibilityHint("Hold to record and release to send, or tap to record hands-free")
        .accessibilityIdentifier("chat.mic")
        .accessibilityAction { Task { _ = await recorder.start() } }
    }

    private func finishVoice() {
        if let note = recorder.finish() { onVoice?(note) } else { onError("That voice note was too short.") }
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
