import SwiftUI

/// An epic, story or task: description, acceptance criteria, children with assignee, reviewer,
/// points and state; the story's chain of people and its audit; then the comments thread (post,
/// @mention) and the activity log. The owner changes the assignee, reviewer, owner, state and
/// points here. Every state or assignee change asks for a reason first (rework, Oct 2026).
struct ItemDetailView: View {
    @Environment(AppModel.self) private var model
    let id: String
    @State private var draft = ""
    @State private var actionError: String?
    @State private var statusDraft: StatusDraft?
    @State private var reassigning: ReassignDraft?
    @State private var showAllAudit = false
    @State private var creatingChild: NewItemView.Draft?
    @State private var showAllActivity = false
    @State private var bodyExpanded = false
    @FocusState private var composing: Bool

    private var detail: ItemDetail? { model.items.details[id] }

    var body: some View {
        Group {
            if let d = detail {
                content(d)
            } else if let e = model.items.errors[id] {
                List { ErrorRow(message: e) { Task { await load() } } }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(detail?.item.level.label ?? "Item")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: id) { await load() }
        .refreshable { await load() }
        .sheet(item: $statusDraft) { draft in
            if let d = detail { StatusChangeSheet(item: d.item, change: draft.change) { change in try await changeStatus(change) } }
        }
        .sheet(item: $reassigning) { draft in
            if let d = detail {
                ReasonSheet(title: "Reassign", subject: d.item.title,
                            summary: "\(model.employeeName(d.item.assigneeId)) → \(model.employeeName(draft.to))",
                            prompt: "Why this person?", action: "Reassign") { reason in
                    try await send(UpdateItemRequest(assigneeId: draft.to, note: reason, reason: reason))
                }
            }
        }
        .sheet(item: $creatingChild) { draft in NewItemView(draft: draft) { _ in Task { await load() } } }
        .alert("Couldn't do that", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(actionError ?? "") }
    }

    private func content(_ d: ItemDetail) -> some View {
        let item = d.item
        return ScrollViewReader { proxy in
            List {
                header(d)
                fields(item)
                if let url = item.docUrl.flatMap(URL.init(string:)), url.scheme?.hasPrefix("http") == true {
                    Section {
                        Link(destination: url) {
                            HStack {
                                Label("Open the doc", systemImage: "doc.richtext")
                                Spacer()
                                Image(systemName: "safari").foregroundStyle(.secondary)
                            }
                        }
                        .accessibilityIdentifier("item.doc")
                    } footer: { Text(url.host ?? url.absoluteString).lineLimit(1) }
                }
                if !item.body.isEmpty {
                    Section {
                        // Short by default: five lines, the whole text on demand.
                        if bodyExpanded {
                            Prose(text: item.body).font(.subheadline)
                        } else {
                            Text((try? AttributedString(markdown: item.body, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(item.body))
                                .font(.subheadline).lineLimit(5)
                        }
                        if item.body.count > 240 || item.body.filter({ $0 == "\n" }).count > 4 {
                            Button(bodyExpanded ? "Show less" : "Show all") { withAnimation(.snappy) { bodyExpanded.toggle() } }.font(.caption.weight(.semibold))
                        }
                    } header: { SectionHeader(text: "Description") }
                }
                if !item.acceptance.isEmpty {
                    Section {
                        ForEach(Array(item.acceptance.enumerated()), id: \.offset) { i, c in
                            HStack(alignment: .top, spacing: 8) {
                                Text("AC\(i + 1)").font(.caption.monospaced().weight(.semibold)).foregroundStyle(.secondary)
                                Text(c).font(.subheadline)
                            }
                        }
                    } header: { SectionHeader(text: "Acceptance criteria") }
                }
                if item.level != .task {
                    Section {
                        if d.children.isEmpty { Text(item.level == .epic ? "No stories yet" : "No tasks").font(.subheadline).foregroundStyle(.secondary) }
                        ForEach(d.children) { c in
                            NavigationLink(value: ItemRoute(id: c.id)) { ItemRow(item: c) }
                        }
                        Button { creatingChild = .init(level: item.level == .epic ? .story : .task, parentId: item.id) } label: {
                            Label(item.level == .epic ? "Add a story" : "Add a task", systemImage: "plus.circle")
                        }
                    } header: { SectionHeader(text: item.level == .epic ? "Stories (\(d.children.count))" : "Tasks (\(d.children.count))") }
                }
                if let rca = item.rca {
                    Section {
                        Prose(text: rca.text).font(.subheadline)
                        if rca.by != nil || rca.at != nil {
                            Text([rca.by.map { model.employeeName($0) }, rca.at.map { Format.ago($0) }].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    } header: { SectionHeader(text: "RCA") }
                }
                if let chain = d.chain { chainSection(chain) }
                if let audit = d.audit { auditSection(audit) }
                comments(d)
                activity(d)
                if let t = d.threadId {
                    Section { NavigationLink(value: ThreadRoute(id: t)) { Label("Discuss in the Room", systemImage: "person.3") } }
                }
                Color.clear.frame(height: 1).listRowBackground(Color.clear).id("end")
            }
            .listStyle(.insetGrouped)
            .safeAreaInset(edge: .bottom, spacing: 0) { composer(d) }
            .onChange(of: d.comments.count) { _, _ in withAnimation { proxy.scrollTo("comments-end", anchor: .bottom) } }
        }
    }

    // MARK: header and fields

    @ViewBuilder private func header(_ d: ItemDetail) -> some View {
        let item = d.item
        Section {
            VStack(alignment: .leading, spacing: 8) {
                breadcrumbs(d)
                Text(item.title).font(.title3.weight(.semibold)).accessibilityIdentifier("item.title")
                HStack(spacing: 8) {
                    StateLabel(glyph: item.status.glyph, compact: true)
                    if let t = item.trueStatus, t != .unknown, t.label != item.status.glyph.label, !(t == .waiting && item.status == .waiting) {
                        Pill(text: t.label, tint: .secondary)
                    }
                    if item.type == .bug { Pill(text: "Bug", symbol: "ladybug", tint: .red) }
                    if item.type == .rca { Pill(text: "RCA", symbol: "magnifyingglass", tint: .indigo) }
                    if model.plan.focusIds.contains(item.id) { Pill(text: "Focus", symbol: "scope", tint: .orange) }
                    if let r = item.resolution, r != .done { Pill(text: r == .wontDo ? "Won't do" : r == .duplicate ? "Duplicate" : "Closed", tint: .secondary) }
                    Spacer()
                    Text("since \(Format.ago(item.statusSince))").font(.caption).foregroundStyle(.secondary)
                }
                if let b = item.blocked {
                    VStack(alignment: .leading, spacing: 3) {
                        Label("Blocked · waiting on \(model.employeeName(b.waitingOn))", systemImage: "octagon.fill").font(.subheadline.weight(.semibold)).foregroundStyle(.red)
                        Text(b.reason).font(.subheadline)
                        Text("since \(Format.ago(b.since))").font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                } else if item.status == .waiting, let w = item.waiting {
                    StatusBox(title: "Waiting on \(model.employeeName(w.on))", symbol: ItemStatus.waiting.glyph.symbol, tint: .orange,
                              text: w.reason, since: w.since)
                } else if item.status == .parked, let p = item.parked {
                    StatusBox(title: "Parked" + (p.by.map { " by \(model.employeeName($0))" } ?? ""), symbol: ItemStatus.parked.glyph.symbol, tint: .gray,
                              text: p.reason, extra: p.resumeWhen.map { "Resume when: \($0)" }, since: p.since)
                } else if let s = item.stall {
                    Label(s.line, systemImage: "hourglass").font(.subheadline).foregroundStyle(.orange)
                }
                if let p = d.progress { EpicProgressBar(progress: p) }
            }
            .padding(.vertical, 4)
        }
    }

    @ViewBuilder private func breadcrumbs(_ d: ItemDetail) -> some View {
        HStack(spacing: 4) {
            Image(systemName: d.item.level.symbol).foregroundStyle(.secondary)
            if let a = d.area { Text(a.title).foregroundStyle(.secondary) }
            if let e = d.epic, e.id != d.parent?.id {
                Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                NavigationLink(value: ItemRoute(id: e.id)) { Text(e.title).lineLimit(1) }.buttonStyle(.borderless)
            }
            if let p = d.parent {
                Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                NavigationLink(value: ItemRoute(id: p.id)) { Text(p.title).lineLimit(1) }.buttonStyle(.borderless)
            }
        }
        .font(.caption)
    }

    @ViewBuilder private func fields(_ item: Item) -> some View {
        Section {
            if item.level == .epic {
                PersonMenu(title: "Owner", current: item.ownerId) { who in update(UpdateItemRequest(ownerId: who ?? "owner")) } label: {
                    FieldRow(title: "Owner", value: item.ownerId.map { model.employeeName($0) } ?? "Nobody yet")
                }
                .tint(.primary)
                Button { toggleFocus(item) } label: {
                    FieldRow(title: "Focus", value: model.plan.focusIds.contains(item.id) ? "In focus" : "Not in focus", symbol: "scope",
                             tint: model.plan.focusIds.contains(item.id) ? .orange : .primary)
                }
                .buttonStyle(.plain)
            } else {
                PersonMenu(title: "Assignee", current: item.assigneeId) { who in
                    if let who, who != item.assigneeId { reassigning = ReassignDraft(to: who) }
                } label: {
                    FieldRow(title: "Assignee", value: model.employeeName(item.assigneeId))
                }
                .tint(.primary)
                .accessibilityIdentifier("item.assignee")
                PersonMenu(title: "Reviewer", current: item.reviewerId) { who in if let who { update(UpdateItemRequest(reviewerId: who)) } } label: {
                    FieldRow(title: "Reviewer", value: item.reviewerId.map { model.employeeName($0) } ?? "Nobody yet")
                }
                .tint(.primary)
                Menu {
                    ForEach(Points.allCases, id: \.self) { p in
                        Button { update(UpdateItemRequest(points: p.rawValue)) } label: {
                            if item.points == p.rawValue { Label("\(p.rawValue)", systemImage: "checkmark") } else { Text("\(p.rawValue)") }
                        }
                    }
                } label: { FieldRow(title: "Points", value: item.points.map { "\($0)" } ?? "Not estimated") }
                .tint(.primary)
            }
            stateMenu(item)
                .tint(.primary)
            if let t = item.targetDate { LabeledContent("Target", value: t) }
        } header: {
            HStack { SectionHeader(text: "Who and state"); Spacer(); if model.items.busy.contains(item.id) { ProgressView().controlSize(.small) } }
        }
    }

    private func stateMenu(_ item: Item) -> some View {
        Menu {
            ForEach(ItemStatus.order.filter { $0 != item.status && $0 != .blocked }, id: \.self) { s in
                Button { statusDraft = StatusDraft(change: StatusChange(to: s)) } label: {
                    Label(s.glyph.label + (StatusChangeSheet.asksMore(s) ? "…" : ""), systemImage: s.glyph.symbol)
                }
            }
            if item.status != .blocked {
                Button(role: .destructive) { statusDraft = StatusDraft(change: StatusChange(to: .blocked)) } label: { Label("Blocked…", systemImage: "octagon") }
            }
            if item.status == .backlog || item.status == .ready {
                Button(role: .destructive) { statusDraft = StatusDraft(change: StatusChange(to: .done, resolution: .wontDo)) } label: { Label("Close as won't do", systemImage: "xmark.circle") }
            }
        } label: {
            FieldRow(title: "State", value: item.status.glyph.label, symbol: item.status.glyph.symbol, tint: item.status.glyph.tint)
        }
        .accessibilityIdentifier("item.state")
    }

    // MARK: comments and activity

    @ViewBuilder private func comments(_ d: ItemDetail) -> some View {
        Section {
            if d.comments.isEmpty { Text("No comments yet. Ask, answer, or @mention someone below.").font(.subheadline).foregroundStyle(.secondary) }
            ForEach(d.comments) { c in CommentRow(comment: c) }
            Color.clear.frame(height: 0).id("comments-end")
        } header: { SectionHeader(text: "Comments (\(d.comments.count))") }
    }

    @ViewBuilder private func activity(_ d: ItemDetail) -> some View {
        let shown = showAllActivity ? d.activity : Array(d.activity.suffix(6))
        Section {
            if d.activity.isEmpty { Text("Nothing has happened to this item yet.").font(.subheadline).foregroundStyle(.secondary) }
            if d.activity.count > shown.count {
                Button("Show all \(d.activity.count)") { withAnimation(.snappy) { showAllActivity = true } }.font(.caption.weight(.semibold))
            }
            ForEach(shown) { a in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: a.kind.symbol).foregroundStyle(.secondary).frame(width: 20)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(a.text).font(.caption).lineLimit(4)
                        Text("\(model.employeeName(a.by)) · \(Format.ago(a.at))").font(.caption2).foregroundStyle(.tertiary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        } header: { SectionHeader(text: "Activity") }
    }

    // MARK: chain and audit

    /// Everyone on the story's path to done; a tap opens their Talk thread.
    @ViewBuilder private func chainSection(_ chain: StoryChain) -> some View {
        Section {
            if let t = chain.charterTitle ?? chain.charterId {
                LabeledContent("Charter", value: t)
            }
            ForEach(Array(chain.people.enumerated()), id: \.offset) { _, p in
                if p.id == "owner" {
                    LabeledContent(p.role, value: model.employeeName(p.id))
                } else {
                    Button { model.router.talk(to: p.id) } label: {
                        HStack(spacing: 10) {
                            InitialsAvatar(name: model.employeeName(p.id), size: 24, tint: .secondary)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(model.employeeName(p.id)).font(.subheadline).foregroundStyle(.primary)
                                Text(p.role).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "bubble.left").foregroundStyle(Color.accentColor)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(p.role): \(model.employeeName(p.id)). Talk")
                    .accessibilityIdentifier("item.chain.\(p.role)")
                }
            }
        } header: { SectionHeader(text: "Chain") } footer: { Text("Tap someone to talk to them.") }
    }

    /// Who did what and why, newest first. Rows from before reasons were required say so.
    @ViewBuilder private func auditSection(_ entries: [AuditEntry]) -> some View {
        let all = AuditEntry.newestFirst(entries)
        let shown = showAllAudit ? all : Array(all.prefix(8))
        Section {
            if all.isEmpty { Text("Nothing recorded yet.").font(.subheadline).foregroundStyle(.secondary) }
            ForEach(Array(shown.enumerated()), id: \.offset) { _, e in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: e.kind.symbol).foregroundStyle(.secondary).frame(width: 20)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(Format.ago(e.at)) · \(model.employeeName(e.by)) · \(e.what { model.employeeName($0) })").font(.caption.weight(.medium))
                        Text(e.reasonLine).font(.caption).foregroundStyle(e.reason == nil ? .tertiary : .secondary).italic(e.reason == nil).lineLimit(4)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            if all.count > shown.count {
                Button("Show all \(all.count)") { withAnimation(.snappy) { showAllAudit = true } }.font(.caption.weight(.semibold))
            }
        } header: { SectionHeader(text: "Audit") }
    }

    private func composer(_ d: ItemDetail) -> some View {
        let known = model.mentionable
        return VStack(spacing: 4) {
            MentionSuggestions(draft: $draft, known: known)
            MentionPills(draft: draft, known: known)
            HStack(alignment: .bottom, spacing: 8) {
                MentionButton(draft: $draft, known: known)
                TextField("Comment · @name to mention", text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.roundedBorder)
                    .focused($composing)
                    .accessibilityIdentifier("item.comment")
                Button { Task { await send() } } label: {
                    if model.items.busy.contains(id) && !draft.isEmpty { ProgressView().frame(width: 28, height: 28) } else { Image(systemName: "arrow.up.circle.fill").font(.title) }
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Post comment")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(.bar)
    }

    // MARK: actions

    private func load() async {
        guard let rest = model.rest else { return }
        await model.items.load(rest, id: id)
        if model.office.data == nil { await model.office.load(rest) }
    }

    private func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let rest = model.rest else { return }
        do { try await model.items.comment(rest, id: id, text: text, mentions: RoomStore.mentions(in: text, known: model.mentionable)); draft = ""; composing = false }
        catch { if let m = error.userMessage { actionError = m } }
    }

    /// From a sheet: throws so the sheet stays open with the server's answer.
    private func changeStatus(_ change: StatusChange) async throws {
        guard let rest = model.rest else { throw WorkplaceError.notPaired }
        try await model.items.changeStatus(rest, id: id, change)
        await model.plan.load(rest)
    }

    private func send(_ req: UpdateItemRequest) async throws {
        guard let rest = model.rest else { throw WorkplaceError.notPaired }
        try await model.items.update(rest, id: id, req)
        await model.plan.load(rest)
    }

    private func update(_ req: UpdateItemRequest) {
        guard let rest = model.rest else { return }
        Task {
            do {
                try await model.items.update(rest, id: id, req)
                await model.plan.load(rest)
            } catch { if let m = error.userMessage { actionError = m } }
        }
    }

    private func toggleFocus(_ item: Item) {
        guard let rest = model.rest else { return }
        Task {
            do { try await model.plan.setFocus(rest, epicId: item.id, on: !model.plan.focusIds.contains(item.id)) }
            catch { if let m = error.userMessage { actionError = m } }
        }
    }
}

/// One comment: who, when, the text with @mentions; long agent comments expand.
struct CommentRow: View {
    @Environment(AppModel.self) private var model
    let comment: Comment
    @State private var expanded = false

    var body: some View {
        let mine = comment.by == "owner"
        let body = MessageBody(text: comment.text, details: comment.details, foldLines: 6)
        HStack(alignment: .top, spacing: 8) {
            InitialsAvatar(name: model.employeeName(comment.by), size: 24, tint: mine ? .accentColor : .secondary)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(model.employeeName(comment.by)).font(.caption.weight(.semibold)).foregroundStyle(mine ? Color.accentColor : .primary)
                    Text(Format.ago(comment.at)).font(.caption2).foregroundStyle(.tertiary)
                }
                MessageTextView(text: comment.text, details: comment.details, expanded: $expanded, foldLines: 6) {
                    var a = (try? AttributedString(markdown: $0, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString($0)
                    for m in $0.matches(of: /@([A-Za-z0-9_-]+)/) {
                        if let r = a.range(of: String(m.0)) { a[r].foregroundColor = .accentColor; a[r].font = Font.subheadline.weight(.semibold) }
                    }
                    return a
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { if body.isLong { withAnimation(.snappy) { expanded.toggle() } } }
        .contextMenu { MessageMenu(text: body.full) }
        .accessibilityElement(children: .combine)
    }
}

struct StatusDraft: Identifiable { let id = UUID(); var change: StatusChange }
struct ReassignDraft: Identifiable { let id = UUID(); let to: String }

/// Waiting, Parked or Blocked: a coloured box with the reason and since when.
struct StatusBox: View {
    let title: String
    let symbol: String
    let tint: Color
    let text: String?
    var extra: String? = nil
    let since: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Label(title, systemImage: symbol).font(.subheadline.weight(.semibold)).foregroundStyle(tint)
            if let text, !text.isEmpty { Text(text).font(.subheadline) }
            if let extra { Text(extra).font(.subheadline) }
            if let since { Text("since \(Format.ago(since))").font(.caption).foregroundStyle(.secondary) }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
    }
}

/// Every status change asks why (rework, Oct 2026). Waiting also asks who (the team, the owner
/// or the COO), Parked when to resume, Blocked which outside cause. The send button stays off
/// until the change is complete; a refusal from the server shows here and keeps the sheet open.
struct StatusChangeSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let item: Item
    @State var change: StatusChange
    let submit: (StatusChange) async throws -> Void
    @State private var sending = false
    @State private var error: String?

    init(item: Item, change: StatusChange, submit: @escaping (StatusChange) async throws -> Void) {
        self.item = item
        self._change = State(initialValue: change)
        self.submit = submit
    }

    /// The statuses whose sheet asks for more than a reason.
    static func asksMore(_ s: ItemStatus) -> Bool { s == .waiting || s == .parked || s == .blocked }

    private var title: String {
        if change.to == .done && change.resolution == .wontDo { return "Close as won't do" }
        if item.status == .done && change.to != .done { return "Reopen" }
        switch change.to {
        case .waiting: return "Waiting on someone"
        case .parked: return "Park it"
        case .blocked: return "Mark blocked"
        default: return "Move to \(change.to.glyph.label)"
        }
    }

    private var prompt: String {
        switch change.to {
        case .waiting: return "What do they need to do?"
        case .parked: return "Why park it?"
        case .blocked: return "What outside thing is it waiting for?"
        default: return item.status == .done ? "Why is it not done?" : "Why this change?"
        }
    }

    /// The team, then you and the COO.
    private var people: [(id: String, name: String)] {
        model.assignees.filter { $0.id != "owner" } + [("owner", "You (the owner)"), ("coo", "Claude — COO")]
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(item.title).font(.subheadline.weight(.semibold))
                    HStack(spacing: 6) {
                        StateLabel(glyph: item.status.glyph, compact: true)
                        Image(systemName: "arrow.right").font(.caption).foregroundStyle(.tertiary)
                        StateLabel(glyph: change.to.glyph, compact: true)
                    }
                    .accessibilityElement(children: .combine)
                }
                if change.to == .waiting {
                    Section {
                        Picker("Waiting on", selection: $change.waitingOn) {
                            Text("Choose…").tag(String?.none)
                            ForEach(people, id: \.id) { p in Text(p.name).tag(Optional(p.id)) }
                        }
                        .accessibilityIdentifier("status.waitingOn")
                    } header: { SectionHeader(text: "Who") }
                }
                if change.to == .blocked {
                    Section {
                        Picker("Blocked on", selection: $change.blockedOn) {
                            Text("Someone outside the team").tag("external")
                            Text("The release").tag("release")
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                    } header: { SectionHeader(text: "Blocked on") } footer: {
                        Text("Waiting on a teammate, you or the COO is Waiting, not Blocked.")
                    }
                }
                Section {
                    TextField(prompt, text: $change.reason, axis: .vertical).lineLimit(2...6)
                        .accessibilityIdentifier("status.reason")
                } header: { SectionHeader(text: "Reason (required)") } footer: {
                    Text("It goes on the story's audit.")
                }
                if change.to == .parked {
                    Section {
                        TextField("Resume when… (after 1.4 ships, Monday)", text: $change.resumeWhen, axis: .vertical).lineLimit(1...3)
                            .accessibilityIdentifier("status.resumeWhen")
                    } header: { SectionHeader(text: "Resume when (required)") }
                }
                if change.to == .waiting && change.waitingOn == "owner" {
                    Section {
                        TextField("What do you recommend?", text: $change.recommendation, axis: .vertical).lineLimit(1...4)
                    } header: { SectionHeader(text: "Recommendation (required)") }
                }
                if let error {
                    Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).font(.subheadline) }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if sending { ProgressView() } else {
                        Button("Save") { Task { await save() } }
                            .disabled(change.problem != nil)
                            .accessibilityIdentifier("status.save")
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(sending)
    }

    private func save() async {
        sending = true
        defer { sending = false }
        do { try await submit(change); dismiss() } catch { if let m = error.userMessage { self.error = m } }
    }
}

/// A change that only needs a reason (a reassign): one field, sent once it is long enough.
struct ReasonSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let subject: String
    let summary: String
    let prompt: String
    let action: String
    let submit: (String) async throws -> Void
    @State private var reason = ""
    @State private var sending = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(subject).font(.subheadline.weight(.semibold))
                    Text(summary).font(.subheadline).foregroundStyle(.secondary)
                }
                Section {
                    TextField(prompt, text: $reason, axis: .vertical).lineLimit(2...6)
                        .accessibilityIdentifier("reason.text")
                } header: { SectionHeader(text: "Reason (required)") } footer: { Text("It goes on the story's audit.") }
                if let error {
                    Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).font(.subheadline) }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if sending { ProgressView() } else {
                        Button(action) { Task { await save() } }.disabled(!StatusChange.validReason(reason))
                    }
                }
            }
        }
        .presentationDetents([.medium])
        .interactiveDismissDisabled(sending)
    }

    private func save() async {
        sending = true
        defer { sending = false }
        let why = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        do { try await submit(why); dismiss() } catch { if let m = error.userMessage { self.error = m } }
    }
}
