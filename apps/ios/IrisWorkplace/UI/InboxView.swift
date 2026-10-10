import SwiftUI

struct InboxView: View {
    @Environment(AppModel.self) private var model
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if let error = model.inbox.error, !model.inbox.loaded {
                    ErrorRow(message: error) { Task { await reload() } }
                } else if !model.inbox.loaded {
                    // Never a blank screen while the first load is on its way (a slow relay).
                    HStack { Spacer(); ProgressView("Loading the Inbox…"); Spacer() }
                }
                if model.inbox.loaded && model.inbox.items.isEmpty {
                    EmptyState(symbol: "tray", title: "Nothing waiting",
                               text: "Approvals, decisions and questions from the employees arrive here.")
                }
                if !model.inbox.open.isEmpty {
                    Section {
                        ForEach(model.inbox.open) { item in
                            NavigationLink(value: item.id) { InboxRow(item: item) }
                        }
                    } header: { SectionHeader(text: "Needs you") }
                } else if model.inbox.loaded && !model.inbox.items.isEmpty {
                    Section { Label("No open items", systemImage: "checkmark.circle").foregroundStyle(.secondary) }
                }
                if !model.inbox.closed.isEmpty {
                    Section {
                        ForEach(model.inbox.closed) { item in
                            NavigationLink(value: item.id) { InboxRow(item: item) }
                        }
                    } header: { SectionHeader(text: "Answered") }
                }
                if let error = model.inbox.error, model.inbox.loaded {
                    Section { ErrorRow(message: error) { Task { await reload() } } }
                }
            }
            .listStyle(.insetGrouped)
            .refreshable { await reload() }
            .navigationTitle("Inbox")
            .navigationDestination(for: String.self) { id in InboxItemView(id: id) }
            .safeAreaInset(edge: .top, spacing: 0) { ConnectionStrip() }
            .task { if !model.inbox.loaded { await reload() } }
            .onChange(of: model.router.inboxItemId, initial: true) { _, id in
                guard let id else { return }
                path = [id]
                model.router.inboxItemId = nil
            }
        }
    }

    private func reload() async {
        guard let rest = model.rest else { return }
        await model.inbox.load(rest)
    }
}

/// One decision: urgency by colour and label, the question in bold on one line, a short context
/// line, then kind · who · when · replies.
struct InboxRow: View {
    @Environment(AppModel.self) private var model
    let item: InboxItem

    var body: some View {
        let g = item.kind.glyph
        let u = (item.urgency ?? .normal).glyph
        let open = item.state == .open
        HStack(alignment: .top, spacing: 10) {
            RoundedRectangle(cornerRadius: 2).fill(open && item.urgency.isRaised ? u.tint : Color.clear).frame(width: 4)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    if open && item.urgency.isRaised { Pill(text: u.label, symbol: u.symbol, tint: u.tint) }
                    Label(g.label, systemImage: g.symbol).font(.caption).foregroundStyle(g.tint).labelStyle(.titleAndIcon)
                    Spacer()
                    Text(Format.ago(item.lastMessageAt ?? item.createdAt)).font(.caption2).foregroundStyle(.tertiary)
                }
                Text(item.title).font(.subheadline.weight(open ? .bold : .regular)).lineLimit(1)
                if let note = item.cooNote, !note.text.isEmpty {
                    Label("COO: \(note.text)", systemImage: "person.badge.shield.checkmark").font(.caption.weight(.medium))
                        .foregroundStyle(Color.accentColor).lineLimit(2)
                }
                if !item.summary.isEmpty && item.summary != item.title {
                    Text(item.summary).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                HStack(spacing: 6) {
                    Text(model.employeeName(item.raisedBy))
                    if let n = item.messageCount, n > 0 { Label("\(n)", systemImage: "bubble.left.and.bubble.right").labelStyle(.titleAndIcon) }
                    if let a = item.answer, let opt = item.options.first(where: { $0.id == a.optionId }) {
                        Label(opt.label, systemImage: "checkmark").lineLimit(1)
                    } else if item.state == .expired {
                        Label("Expired", systemImage: "clock.badge.xmark")
                    }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(open && item.urgency.isRaised ? u.label + " urgency. " : "")\(g.label): \(item.title)")
    }
}

/// The COO passed this on to the owner: why it needs him, on top of the item.
struct CooNoteBanner: View {
    let note: CooNote

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "person.badge.shield.checkmark").font(.title3).foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 3) {
                Text("COO: needs you because…").font(.caption.weight(.semibold)).foregroundStyle(Color.accentColor)
                Text(note.text).font(.subheadline).fixedSize(horizontal: false, vertical: true)
                if let at = note.at { Text(Format.ago(at)).font(.caption2).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("inbox.cooNote")
    }
}

extension Optional where Wrapped == InboxUrgency {
    /// High or urgent: shown by colour and label. Normal, absent or unknown: no mark.
    var isRaised: Bool { self == .high || self == .urgent }
}

/// One decision as a thread: the question in bold, a short context, the options as buttons with
/// the recommended one marked, then the conversation as chat bubbles and a free-text reply box
/// (reply, ask back, or suggest something else). `danger` confirms; `needsNote` asks for a note.
struct InboxItemView: View {
    @Environment(AppModel.self) private var model
    let id: String
    @State private var draft = ""
    @State private var error: String?
    @FocusState private var composing: Bool

    private var item: InboxItem? { model.inbox.item(id) }
    private var messages: [InboxMessage] { model.inbox.messages[id] ?? [] }

    var body: some View {
        Group {
            if let item {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            if let note = item.cooNote, !note.text.isEmpty { CooNoteBanner(note: note) }
                            question(item)
                            VStack(alignment: .leading, spacing: 8) {
                                AnswerOptions(item: item)
                            }
                            .id("answer")
                            .scrollToAnswerWhenDeciding(item.id)
                            more(item)
                            conversation(item)
                            Color.clear.frame(height: 1).id("bottom")
                        }
                        .padding(16)
                    }
                    .scrollDismissesKeyboard(.interactively)
                    .onChange(of: messages.count) { _, _ in withAnimation { proxy.scrollTo("bottom") } }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) { composer }
            } else if let e = model.inbox.threadErrors[id] {
                List { ErrorRow(message: e) { Task { await load() } } }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(item?.kind.glyph.label ?? "Inbox item")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: id) { await load() }
    }

    private func question(_ item: InboxItem) -> some View {
        let u = (item.urgency ?? .normal).glyph
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                if item.state == .open && item.urgency.isRaised { Pill(text: u.label, symbol: u.symbol, tint: u.tint) }
                StateLabel(glyph: item.kind.glyph, compact: true)
                Spacer()
                Text("\(model.employeeName(item.raisedBy)) · \(Format.ago(item.createdAt))").font(.caption).foregroundStyle(.secondary)
            }
            Text(item.title).font(.headline.weight(.bold)).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("inbox.question")
            OwnerLineView(summary: item.summary.isEmpty ? item.body : item.summary,
                          details: item.details ?? (item.body == item.summary ? nil : item.body))
                .font(.subheadline)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(item.state == .open && item.urgency.isRaised ? u.tint.opacity(0.7) : .clear, lineWidth: 1.5))
    }

    /// Who raised it, what each answer does, links, context: behind one disclosure.
    @ViewBuilder private func more(_ item: InboxItem) -> some View {
        let hasMore = !item.affects.isEmpty || item.onApprove?.isEmpty == false || item.onDeny?.isEmpty == false
            || item.links?.isEmpty == false || !item.context.isEmpty || item.kind == .orgChange
        if hasMore {
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 8) {
                    if !item.affects.isEmpty {
                        LabeledContent("Affects", value: item.affects.map { model.employeeName($0) }.joined(separator: ", ")).font(.subheadline)
                    }
                    if let a = item.onApprove, !a.isEmpty {
                        Label { Text(a) } icon: { Image(systemName: "checkmark.circle").foregroundStyle(.green) }.font(.subheadline)
                    }
                    if let d = item.onDeny, !d.isEmpty {
                        Label { Text(d) } icon: { Image(systemName: "xmark.circle").foregroundStyle(.red) }.font(.subheadline)
                    }
                    if item.kind == .orgChange, let pid = item.context["proposalId"]?.stringValue {
                        NavigationLink { ProposalDetailView(id: pid) } label: { Label("Read the change as a diff", systemImage: "doc.text.magnifyingglass") }
                    }
                    ForEach(Array((item.links ?? []).enumerated()), id: \.offset) { _, link in InboxLinkRow(link: link) }
                    ForEach(item.context.keys.sorted(), id: \.self) { key in ContextRow(key: key, value: item.context[key]!) }
                }
                .padding(.top, 6)
            } label: {
                Text("Who and what").font(.subheadline.weight(.semibold))
            }
        }
    }

    @ViewBuilder private func conversation(_ item: InboxItem) -> some View {
        if !messages.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Conversation").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(messages) { m in InboxBubble(message: m) }
            }
        }
        if model.inbox.replying.contains(id) {
            HStack { Spacer(); ProgressView().controlSize(.small); Text("Sending…").font(.caption).foregroundStyle(.secondary) }
        }
        if let error { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.subheadline) }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Reply, ask, or suggest something else", text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.roundedBorder)
                .focused($composing)
                .accessibilityIdentifier("inbox.reply")
            Button { Task { await send() } } label: {
                if model.inbox.replying.contains(id) { ProgressView().frame(width: 28, height: 28) } else { Image(systemName: "arrow.up.circle.fill").font(.title) }
            }
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.inbox.replying.contains(id))
            .accessibilityLabel("Send reply")
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(.bar)
    }

    private func load() async {
        guard let rest = model.rest else { return }
        await model.inbox.loadThread(rest, id: id)
    }

    private func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let rest = model.rest else { return }
        error = nil
        do { try await model.inbox.reply(rest, id: id, text: text); draft = ""; composing = false }
        catch { if let m = error.userMessage { self.error = m } }
    }
}

/// A message in an Inbox thread: the owner's on the right, the asker's on the left.
struct InboxBubble: View {
    @Environment(AppModel.self) private var model
    let message: InboxMessage
    @State private var expanded = false

    var body: some View {
        let mine = message.by == "owner"
        HStack(alignment: .bottom, spacing: 8) {
            if mine { Spacer(minLength: 48) }
            VStack(alignment: mine ? .trailing : .leading, spacing: 2) {
                if !mine { Text(model.employeeName(message.by)).font(.caption2.weight(.semibold)).foregroundStyle(.secondary) }
                Text(expanded ? (message.details ?? message.text) : message.text)
                    .font(.subheadline)
                    .foregroundStyle(mine ? .white : .primary)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(mine ? Color.accentColor.opacity(0.9) : Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
                    .textSelection(.enabled)
                    .onTapGesture { if message.details != nil { withAnimation(.snappy) { expanded.toggle() } } }
                Text(Format.time(message.at)).font(.caption2).foregroundStyle(.tertiary)
            }
            if !mine { Spacer(minLength: 48) }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The one line the owner reads first, with the details behind an expand control.
struct OwnerLineView: View {
    let summary: String
    let details: String?
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(summary).font(.body)
            if let details, !details.isEmpty {
                Button { withAnimation(.snappy) { expanded.toggle() } } label: {
                    Label(expanded ? "Hide details" : "Details", systemImage: expanded ? "chevron.up" : "chevron.down").font(.caption.weight(.semibold))
                }
                .buttonStyle(.plain).foregroundStyle(Color.accentColor)
                if expanded { Prose(text: details).font(.subheadline) }
            }
        }
    }
}

private extension View {
    /// A push's DECIDE action lands with the options in view.
    func scrollToAnswerWhenDeciding(_ id: String) -> some View { modifier(DecideScroll(id: id)) }
}

private struct DecideScroll: ViewModifier {
    @Environment(AppModel.self) private var model
    let id: String
    func body(content: Content) -> some View {
        ScrollViewReader { proxy in
            content.onAppear {
                if model.router.decideItemId == id {
                    model.router.decideItemId = nil
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { withAnimation { proxy.scrollTo("answer", anchor: .bottom) } }
                }
            }
        }
    }
}

/// A link on an Inbox item: a Team Room thread opens in the Room tab; a URL opens outside.
struct InboxLinkRow: View {
    @Environment(AppModel.self) private var model
    let link: InboxLink

    var body: some View {
        if let threadId = link.roomThreadId {
            Button { model.router.openThread(threadId) } label: {
                Label(link.label, systemImage: "person.3")
            }
        } else if let url = link.url {
            Link(destination: url) { Label(link.label, systemImage: "link") }
        } else {
            Label(link.label, systemImage: "link").foregroundStyle(.secondary)
        }
    }
}

/// One button per option, with the confirm (danger) and note (needsNote) steps, and the recorded
/// answer once there is one. Shared by the Inbox item and the employee page.
struct AnswerOptions: View {
    @Environment(AppModel.self) private var model
    let item: InboxItem
    var compact = false
    @State private var confirming: InboxOption?
    @State private var noting: InboxOption?
    @State private var note = ""
    @State private var error: String?

    var body: some View {
        Group {
            if item.state == .open {
                ForEach(item.options) { opt in
                    let rec = opt.recommended == true
                    Button(role: opt.danger == true ? .destructive : nil) { tap(opt) } label: {
                        HStack {
                            Image(systemName: opt.danger == true ? "exclamationmark.triangle" : opt.needsNote == true ? "text.bubble" : rec ? "star.circle.fill" : "checkmark.circle")
                            Text(opt.label).fontWeight(.semibold).multilineTextAlignment(.leading)
                            Spacer(minLength: 4)
                            if rec { Text("Recommended").font(.caption2.weight(.bold)).padding(.horizontal, 6).padding(.vertical, 2).background(.white.opacity(0.25), in: Capsule()) }
                            if model.inbox.answering.contains(item.id) { ProgressView() }
                        }
                        .font(compact ? .subheadline : .body)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, compact ? 0 : 4)
                    }
                    .modifier(OptionStyle(recommended: rec, compact: compact))
                    .disabled(model.inbox.answering.contains(item.id))
                    .accessibilityLabel(rec ? "\(opt.label), recommended" : opt.label)
                }
            } else if let a = item.answer {
                let label = item.options.first { $0.id == a.optionId }?.label ?? a.optionId
                Label("\(label) · \(Format.ago(a.at)) via \(a.via.rawValue)", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                if let n = a.note, !n.isEmpty { Text(n).font(.subheadline).foregroundStyle(.secondary) }
            } else {
                Label("Expired without an answer", systemImage: "clock.badge.xmark").foregroundStyle(.secondary)
            }
            if let error { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.subheadline) }
        }
        .confirmationDialog(confirming.map { "\($0.label)?" } ?? "", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible) {
            if let opt = confirming {
                Button(opt.label, role: .destructive) { confirming = nil; proceed(opt) }
                Button("Cancel", role: .cancel) { confirming = nil }
            }
        } message: {
            Text(item.onApprove ?? "This is an outward action. It runs as soon as you confirm.")
        }
        .alert(noting.map { $0.label } ?? "", isPresented: Binding(get: { noting != nil }, set: { if !$0 { noting = nil } })) {
            TextField(noting?.id == "raise-today" ? "New cap for today, in ₹" : "Note", text: $note)
            Button("Send") { if let opt = noting { noting = nil; Task { await answer(opt, note: note) } } }
                .disabled(note.trimmingCharacters(in: .whitespaces).isEmpty)
            Button("Cancel", role: .cancel) { noting = nil }
        } message: {
            Text("This answer needs a note.")
        }
    }

    private func tap(_ opt: InboxOption) {
        error = nil
        if opt.danger == true { confirming = opt } else { proceed(opt) }
    }

    private func proceed(_ opt: InboxOption) {
        if opt.needsNote == true { note = ""; noting = opt } else { Task { await answer(opt, note: nil) } }
    }

    private func answer(_ opt: InboxOption, note: String?) async {
        do {
            try await model.answer(item: item, option: opt, note: note)
        } catch {
            if let m = error.userMessage { self.error = m }
        }
    }
}

/// The recommended option is the prominent one; the others are plain bordered buttons.
private struct OptionStyle: ViewModifier {
    let recommended: Bool
    let compact: Bool
    func body(content: Content) -> some View {
        if compact {
            content
        } else if recommended {
            content.buttonStyle(.borderedProminent)
        } else {
            content.buttonStyle(.bordered)
        }
    }
}

/// One key of the structured context. Diffs are monospace; links are tappable; lists are lines.
struct ContextRow: View {
    let key: String
    let value: JSONValue

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(key.replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression).capitalized)
                .font(.caption).foregroundStyle(.secondary)
            switch value {
            case .string(let s) where key.lowercased().contains("diff"):
                ScrollView(.horizontal) { Text(s).font(.caption.monospaced()).textSelection(.enabled) }
            case .string(let s):
                EvidenceLine(text: s)
            case .array(let items):
                ForEach(Array(items.enumerated()), id: \.offset) { _, v in
                    HStack(alignment: .top, spacing: 6) { Text("•"); EvidenceLine(text: v.display) }
                }
            default:
                Text(value.display).font(.subheadline)
            }
        }
        .padding(.vertical, 2)
    }
}
