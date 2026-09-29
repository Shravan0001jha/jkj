import SwiftUI

/// The Team Room: threads with a one-line status, a thread's messages one line each with details on
/// demand, posting as the owner with @mentions, live updates.
struct RoomView: View {
    @Environment(AppModel.self) private var model
    @State private var path: [String] = []
    @State private var showNew = false

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if let e = model.room.error, !model.room.loaded {
                    ErrorRow(message: e) { Task { await reload() } }
                }
                if model.room.loaded && model.room.threads.isEmpty {
                    EmptyState(symbol: "person.3", title: "No threads yet",
                               text: "Employees open threads when their work crosses charters. You can start one too.")
                }
                if let general = model.room.general {
                    Section {
                        NavigationLink(value: general.id) { ThreadRow(thread: general, isChannel: true) }
                    } header: { SectionHeader(text: "Channel") }
                }
                if !model.room.open.isEmpty {
                    Section {
                        ForEach(model.room.open) { t in NavigationLink(value: t.id) { ThreadRow(thread: t) } }
                    } header: { SectionHeader(text: "Open") }
                }
                if !model.room.resolved.isEmpty {
                    Section {
                        ForEach(model.room.resolved) { t in NavigationLink(value: t.id) { ThreadRow(thread: t) } }
                    } header: { SectionHeader(text: "Resolved") }
                }
            }
            .listStyle(.insetGrouped)
            .refreshable { await reload() }
            .navigationTitle("Team Room")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showNew = true } label: { Image(systemName: "square.and.pencil") }.accessibilityLabel("New thread")
                }
            }
            .navigationDestination(for: String.self) { id in ThreadView(id: id) }
            .safeAreaInset(edge: .top, spacing: 0) { ConnectionStrip() }
            .sheet(isPresented: $showNew) { NewThreadView { id in path = [id] } }
            .task { if !model.room.loaded { await reload() } }
            .onChange(of: model.router.roomThreadId, initial: true) { _, id in
                guard let id else { return }
                path = [id]
                model.router.roomThreadId = nil
            }
        }
    }

    private func reload() async {
        guard let rest = model.rest else { return }
        await model.room.load(rest)
    }
}

struct ThreadRow: View {
    @Environment(AppModel.self) private var model
    let thread: RoomThread
    var isChannel = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if isChannel {
                Image(systemName: "number").foregroundStyle(.white).font(.headline)
                    .frame(width: 32, height: 32).background(Color.accentColor, in: Circle())
            } else {
                Image(systemName: thread.state == .open ? "bubble.left.and.bubble.right" : "checkmark.circle")
                    .foregroundStyle(thread.state == .open ? Color.accentColor : .green).font(.title3).frame(width: 26)
            }
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(thread.title).font(.subheadline.weight(model.room.unread.contains(thread.id) ? .bold : .semibold)).lineLimit(2)
                    if model.room.unread.contains(thread.id) { Circle().fill(Color.accentColor).frame(width: 8, height: 8).accessibilityLabel("unread") }
                }
                if !thread.headline.isEmpty { Text(thread.headline).font(.caption).lineLimit(2) }
                Text(status).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }

    /// One line: who is in it, how many messages, the last activity, and escalations.
    private var status: String {
        var parts: [String] = []
        parts.append(thread.participants.filter { $0 != "workplace" }.map { $0 == "owner" ? "you" : model.employeeName($0) }.joined(separator: ", "))
        parts.append("\(thread.messageCount) msg")
        parts.append(Format.ago(thread.lastAt))
        if !thread.escalations.isEmpty { parts.append("\(thread.escalations.count) for you") }
        if !thread.charterIds.isEmpty { parts.append(thread.charterIds.map { model.charterTitle($0) }.joined(separator: "/")) }
        return parts.joined(separator: " · ")
    }
}

struct ThreadView: View {
    @Environment(AppModel.self) private var model
    let id: String
    @State private var draft = ""
    @State private var error: String?
    @State private var showResolve = false
    @State private var summary = ""
    @FocusState private var composing: Bool

    private var thread: RoomThread? { model.room.thread(id) }
    private var messages: [RoomMessage] { model.room.messages[id] ?? [] }
    private var isChannel: Bool { id == "general" }
    /// Who can be @mentioned: everyone in the Office, plus the thread's participants (the Office may not be loaded yet).
    private var knownIds: [String] {
        Array(Set(model.office.cards.map(\.employee.id) + (thread?.participants ?? []) + messages.map(\.by))).filter { $0 != "owner" && $0 != "workplace" }
    }
    /// The word being typed after the last unfinished `@`, or nil when the draft isn't mid-mention.
    private var mentionQuery: String? {
        guard let at = draft.lastIndex(of: "@") else { return nil }
        let after = draft[draft.index(after: at)...]
        guard !after.contains(where: { $0.isWhitespace }) else { return nil }
        return String(after)
    }

    var body: some View {
        VStack(spacing: 0) {
            if let t = thread {
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(t.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                        Spacer()
                        if isChannel {
                            Pill(text: "everyone", symbol: "person.3", tint: .secondary)
                        } else {
                            Pill(text: t.state == .open ? "open" : "resolved", tint: t.state == .open ? .accentColor : .green)
                        }
                    }
                    if !t.escalations.isEmpty {
                        HStack(spacing: 6) {
                            ForEach(t.escalations, id: \.self) { ib in
                                Button { model.router.openInbox(ib) } label: { Pill(text: "Inbox \(ib)", symbol: "tray", tint: .orange) }.buttonStyle(.plain)
                            }
                        }
                    }
                    if !t.headline.isEmpty { Text(t.headline).font(.caption).foregroundStyle(.secondary) }
                }
                .padding(.horizontal, 16).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.bar)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        if messages.isEmpty { HStack { Spacer(); ProgressView(); Spacer() }.padding() }
                        ForEach(messages) { m in
                            RoomMessageRow(message: m).id(m.id)
                        }
                        if let who = model.room.replying[id] {
                            ReplyingBubble(name: model.employeeName(who)).id("replying")
                        }
                        if let e = error ?? model.room.error {
                            Label(e, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.subheadline).padding(.horizontal)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.vertical, 8)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: messages.count) { _, _ in withAnimation { proxy.scrollTo("bottom") } }
                .onChange(of: model.room.replying[id]) { _, who in if who != nil { withAnimation { proxy.scrollTo("replying") } } }
                .onAppear { proxy.scrollTo("bottom") }
            }
            composer
        }
        .navigationTitle(thread?.title ?? "Thread")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if thread?.state == .open && !isChannel {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { showResolve = true } label: { Label("Resolve with a summary", systemImage: "checkmark.circle") }
                    } label: { Image(systemName: "ellipsis.circle") }.accessibilityLabel("More")
                }
            }
        }
        .alert("Resolve this thread", isPresented: $showResolve) {
            TextField("One-line summary", text: $summary)
            Button("Resolve") { Task { await resolve() } }.disabled(summary.trimmingCharacters(in: .whitespaces).isEmpty)
            Button("Cancel", role: .cancel) {}
        } message: { Text("The summary is what the charter keeps.") }
        .task(id: id) {
            guard let rest = model.rest else { return }
            await model.room.loadThread(rest, id: id)
        }
        .onAppear { model.room.markRead(id) }
        .onChange(of: messages.count) { _, _ in model.room.markRead(id) }
    }

    /// Employees whose id or name starts with the word after the last unfinished `@`.
    private var mentionCandidates: [String] {
        guard let q = mentionQuery else { return [] }
        if q.isEmpty { return knownIds.sorted { model.employeeName($0) < model.employeeName($1) } }
        return knownIds.filter { $0.hasPrefix(q.lowercased()) || model.employeeName($0).lowercased().hasPrefix(q.lowercased()) }
    }

    /// Replaces the word being typed after the last `@` with the chosen id, so picking never
    /// disturbs anything typed before it.
    private func pickMention(_ empId: String) {
        guard let at = draft.lastIndex(of: "@") else { return }
        draft.replaceSubrange(draft.index(after: at)..., with: empId + " ")
    }

    private var composer: some View {
        VStack(spacing: 4) {
            if !mentionCandidates.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(mentionCandidates, id: \.self) { empId in
                            Button { pickMention(empId) } label: {
                                HStack(spacing: 4) {
                                    InitialsAvatar(name: model.employeeName(empId), size: 18)
                                    Text(model.employeeName(empId)).font(.caption.weight(.medium))
                                }
                                .padding(.horizontal, 8).padding(.vertical, 5)
                                .background(Color(.secondarySystemBackground), in: Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 14)
                }
                .accessibilityLabel("Mention someone")
            }
            let mentions = RoomStore.mentions(in: draft, known: knownIds)
            if !mentions.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "at").font(.caption).foregroundStyle(.secondary)
                    ForEach(mentions, id: \.self) { Pill(text: model.employeeName($0), tint: .accentColor) }
                    Spacer()
                }
                .padding(.horizontal, 14)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Post as you · @name to mention", text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.roundedBorder)
                    .focused($composing)
                    .disabled(thread?.state == .resolved)
                Button { Task { await send() } } label: {
                    if model.room.posting.contains(id) { ProgressView().frame(width: 28, height: 28) } else { Image(systemName: "arrow.up.circle.fill").font(.title) }
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.room.posting.contains(id) || thread?.state == .resolved)
                .accessibilityLabel("Post")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(.bar)
    }

    private func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let rest = model.rest else { return }
        error = nil
        do {
            try await model.room.post(rest, threadId: id, text: text, mentions: RoomStore.mentions(in: text, known: knownIds))
            draft = ""
        } catch { self.error = error.localizedDescription }
    }

    private func resolve() async {
        guard let rest = model.rest else { return }
        do { try await model.room.resolve(rest, threadId: id, summary: summary.trimmingCharacters(in: .whitespaces)); summary = "" }
        catch { self.error = error.localizedDescription }
    }
}

/// One message: who, when, one line; the rest behind a chevron. The owner's are marked.
struct RoomMessageRow: View {
    @Environment(AppModel.self) private var model
    let message: RoomMessage
    @State private var expanded = false

    private var senderName: String {
        message.owner ? "You" : message.by == "workplace" ? "Workplace" : model.employeeName(message.by)
    }

    var body: some View {
        let c = CompactText(text: message.text)
        HStack(alignment: .top, spacing: 8) {
            if message.owner { Spacer(minLength: 40) }
            if !message.owner { InitialsAvatar(name: senderName, tint: message.by == "workplace" ? .secondary : .accentColor) }
            VStack(alignment: message.owner ? .trailing : .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(senderName).font(.caption.weight(.semibold)).foregroundStyle(message.owner ? Color.accentColor : .primary)
                    Text(Format.ago(message.at)).font(.caption2).foregroundStyle(.tertiary)
                    if c.hasDetails { Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption2).foregroundStyle(.secondary) }
                }
                Text(highlighted(expanded ? message.text : c.line))
                    .font(.subheadline)
                    .lineLimit(expanded ? nil : 1)
                    .multilineTextAlignment(message.owner ? .trailing : .leading)
                    .foregroundStyle(message.owner ? .white : .primary)
                    .textSelection(.enabled)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(message.owner ? Color.accentColor.opacity(0.9) : Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
            }
            if !message.owner { Spacer(minLength: 40) }
        }
        .frame(maxWidth: .infinity, alignment: message.owner ? .trailing : .leading)
        .padding(.horizontal, 12)
        .contentShape(Rectangle())
        .onTapGesture { if c.hasDetails { withAnimation(.snappy) { expanded.toggle() } } }
        .accessibilityElement(children: .combine)
        .accessibilityHint(c.hasDetails ? (expanded ? "Collapses the details" : "Expands the details") : "")
    }

    /// `@name` in the accent colour.
    private func highlighted(_ text: String) -> AttributedString {
        var a = AttributedString(text)
        for m in text.matches(of: /@([A-Za-z0-9_-]+)/) {
            if let r = a.range(of: String(m.0)) {
                a[r].foregroundColor = .accentColor
                a[r].font = .subheadline.weight(.semibold)
            }
        }
        return a
    }
}

/// A mentioned employee is composing a reply — shown from `room.typing` until their message lands.
/// `room.replying` said `started` for this employee, in this thread — no `done`/`skipped`/message yet.
struct ReplyingBubble: View {
    let name: String
    var body: some View {
        HStack(spacing: 8) {
            InitialsAvatar(name: name)
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text("\(name) is replying…").font(.caption).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
            Spacer(minLength: 40)
        }
        .padding(.horizontal, 12)
        .accessibilityElement(children: .combine)
    }
}

struct NewThreadView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let onCreated: (String) -> Void
    @State private var title = ""
    @State private var text = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section { TextField("Title", text: $title) } header: { SectionHeader(text: "Topic") }
                Section {
                    TextField("First message · @name to mention", text: $text, axis: .vertical).lineLimit(3...8)
                } header: { SectionHeader(text: "Message") } footer: {
                    let mentions = RoomStore.mentions(in: text, known: model.office.cards.map(\.employee.id))
                    if !mentions.isEmpty { Text("Mentions: " + mentions.map { model.employeeName($0) }.joined(separator: ", ")) }
                }
                if let error { Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red) } }
            }
            .navigationTitle("New thread")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Posting…" : "Post") { Task { await create() } }
                        .disabled(busy || title.trimmingCharacters(in: .whitespaces).isEmpty || text.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func create() async {
        guard let rest = model.rest else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let t = try await model.room.create(rest, title: title.trimmingCharacters(in: .whitespaces), text: text.trimmingCharacters(in: .whitespacesAndNewlines),
                                                mentions: RoomStore.mentions(in: text, known: model.office.cards.map(\.employee.id)))
            dismiss()
            onCreated(t.id)
        } catch { self.error = error.localizedDescription }
    }
}
