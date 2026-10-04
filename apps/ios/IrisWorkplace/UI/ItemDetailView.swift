import SwiftUI

/// An epic, story or task: description, acceptance criteria, children with assignee, reviewer,
/// points and state; then the comments thread (post, @mention) and the activity log. The owner
/// changes the assignee, reviewer, owner, state and points here.
struct ItemDetailView: View {
    @Environment(AppModel.self) private var model
    let id: String
    @State private var draft = ""
    @State private var actionError: String?
    @State private var blocking = false
    @State private var reopening = false
    @State private var note = ""
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
        .sheet(isPresented: $blocking) { if let d = detail { BlockSheet(item: d.item) { reason, who in
            update(UpdateItemRequest(status: .blocked, blockedReason: reason, waitingOn: who))
        } } }
        .sheet(item: $creatingChild) { draft in NewItemView(draft: draft) { _ in Task { await load() } } }
        .alert("Reopen", isPresented: $reopening) {
            TextField("Why it is not done", text: $note)
            Button("Reopen") { update(UpdateItemRequest(status: .inProgress, note: note)); note = "" }
                .disabled(note.trimmingCharacters(in: .whitespaces).isEmpty)
            Button("Cancel", role: .cancel) { note = "" }
        } message: { Text("A reopen needs a note; it goes on the activity log.") }
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
                PersonMenu(title: "Assignee", current: item.assigneeId) { who in if let who { update(UpdateItemRequest(assigneeId: who)) } } label: {
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
            ForEach(ItemStatus.known.filter { $0 != item.status && $0 != .blocked }, id: \.self) { s in
                Button { move(item, to: s) } label: { Label(s.glyph.label, systemImage: s.glyph.symbol) }
            }
            if item.status != .blocked {
                Button(role: .destructive) { blocking = true } label: { Label("Blocked…", systemImage: "octagon") }
            }
            if item.status == .backlog || item.status == .ready {
                Button(role: .destructive) { update(UpdateItemRequest(status: .done, resolution: .wontDo)) } label: { Label("Close as won't do", systemImage: "xmark.circle") }
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

    private func move(_ item: Item, to s: ItemStatus) {
        if item.status == .done && s != .done { reopening = true; return }
        update(UpdateItemRequest(status: s))
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

/// Blocked needs a reason and who it is waiting on (§19.3).
struct BlockSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let item: Item
    let done: (String, String) -> Void
    @State private var reason = ""
    @State private var waitingOn = "owner"

    var body: some View {
        NavigationStack {
            Form {
                Section { Text(item.title).font(.subheadline.weight(.semibold)) }
                Section {
                    TextField("What is it waiting for?", text: $reason, axis: .vertical).lineLimit(2...5)
                } header: { SectionHeader(text: "Reason") }
                Section {
                    Picker("Waiting on", selection: $waitingOn) {
                        ForEach(model.assignees, id: \.id) { p in Text(p.name).tag(p.id) }
                        Text("Claude — COO").tag("coo")
                    }
                }
            }
            .navigationTitle("Mark blocked")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Block") { done(reason.trimmingCharacters(in: .whitespacesAndNewlines), waitingOn); dismiss() }
                        .disabled(reason.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }
}
