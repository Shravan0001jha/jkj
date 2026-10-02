import SwiftUI

/// The Room (v2): General, one room per product area (a thread per epic inside it, plus the
/// area's own channel), and the Releases room. Agents discuss, hand off and review here; each
/// area room also carries named update lines ("Story 'X' is done").
struct RoomView: View {
    @Environment(AppModel.self) private var model
    @State private var path = NavigationPath()
    @State private var showNew = false

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if let e = model.rooms.error, !model.rooms.loaded {
                    ErrorRow(message: e) { Task { await reload() } }
                } else if !model.rooms.loaded {
                    HStack { Spacer(); ProgressView(); Spacer() }
                }
                let rooms = model.rooms.rooms
                if let general = rooms.first(where: { $0.kind == .general }) {
                    Section { roomLink(general) } header: { SectionHeader(text: "Everyone") }
                }
                let areas = rooms.filter { $0.kind == .area || $0.kind == .unknown }
                if !areas.isEmpty {
                    Section { ForEach(areas) { roomLink($0) } } header: { SectionHeader(text: "Areas") }
                }
                if let releases = rooms.first(where: { $0.kind == .releases }) {
                    Section { roomLink(releases) } header: { SectionHeader(text: "Releases") }
                }
            }
            .listStyle(.insetGrouped)
            .refreshable { await reload() }
            .navigationTitle("Room")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showNew = true } label: { Image(systemName: "square.and.pencil") }.accessibilityLabel("New thread")
                }
            }
            .navigationDestination(for: String.self) { id in ThreadView(id: id) }
            .navigationDestination(for: ReleasesRoomRoute.self) { _ in ReleasePostsView() }
            .v2Destinations()
            .safeAreaInset(edge: .top, spacing: 0) { ConnectionStrip() }
            .sheet(isPresented: $showNew) { NewThreadView { id in path.append(ThreadRoute(id: id)) } }
            .task { if !model.rooms.loaded { await reload() } }
            .onChange(of: model.router.roomThreadId, initial: true) { _, id in
                guard let id else { return }
                path = NavigationPath([ThreadRoute(id: id)])
                model.router.roomThreadId = nil
            }
            .onChange(of: model.router.releasePostId, initial: true) { _, id in
                guard let id else { return }
                var p = NavigationPath()
                p.append(ReleasesRoomRoute())
                p.append(ReleasePostRoute(id: id))
                path = p
                model.router.releasePostId = nil
            }
        }
    }

    @ViewBuilder private func roomLink(_ room: Room) -> some View {
        if room.kind == .releases {
            NavigationLink(value: ReleasesRoomRoute()) { RoomRow(room: room) }
        } else {
            NavigationLink(value: RoomRoute(id: room.id)) { RoomRow(room: room) }
        }
    }

    private func reload() async {
        guard let rest = model.rest else { return }
        async let r: Void = model.rooms.load(rest)
        async let t: Void = model.room.load(rest)
        _ = await (r, t)
    }
}

struct ReleasesRoomRoute: Hashable {}

struct RoomRow: View {
    @Environment(AppModel.self) private var model
    let room: Room

    private var symbol: String {
        switch room.kind {
        case .general: return "number"
        case .area: return "square.stack.3d.up"
        case .releases: return "shippingbox"
        case .unknown: return "bubble.left.and.bubble.right"
        }
    }

    var body: some View {
        let unread = room.threadIds.filter { model.room.unread.contains($0) }.count
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol).foregroundStyle(.white).font(.subheadline.weight(.semibold))
                .frame(width: 32, height: 32).background(room.kind == .releases ? Color.brown : Color.accentColor, in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(room.title).font(.subheadline.weight(unread > 0 ? .bold : .semibold))
                    if unread > 0 { Circle().fill(Color.accentColor).frame(width: 8, height: 8).accessibilityLabel("\(unread) unread") }
                    Spacer()
                    Text(Format.ago(room.lastAt)).font(.caption2).foregroundStyle(.tertiary)
                }
                if !room.headline.isEmpty { Text(room.headline).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                if room.kind == .area {
                    let epics = room.threadIds.filter { $0.hasPrefix("th_epic_") }.count
                    Text("\(epics) epic thread\(epics == 1 ? "" : "s")").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

/// One room's threads: an area's epic threads and its own channel, or General's threads.
struct RoomDetailView: View {
    @Environment(AppModel.self) private var model
    let id: String

    private var detail: RoomDetail? { model.rooms.details[id] }

    var body: some View {
        List {
            if let d = detail {
                let pinned = d.threads.filter { $0.id == RoomStore.generalId || $0.id.hasPrefix("th_area_") }
                let epics = d.threads.filter { $0.epicId != nil && $0.state != .resolved }
                let others = d.threads.filter { !pinned.contains($0) && !epics.contains($0) }
                if !pinned.isEmpty {
                    Section { ForEach(pinned) { t in NavigationLink(value: ThreadRoute(id: t.id)) { ThreadRow(thread: t, isChannel: true) } } }
                        header: { SectionHeader(text: "Channel") }
                }
                if !epics.isEmpty {
                    Section { ForEach(epics) { t in NavigationLink(value: ThreadRoute(id: t.id)) { ThreadRow(thread: t, isEpic: true) } } }
                        header: { SectionHeader(text: "Epics") }
                }
                let open = others.filter { $0.state != .resolved }
                let resolved = others.filter { $0.state == .resolved }
                if !open.isEmpty {
                    Section { ForEach(open) { t in NavigationLink(value: ThreadRoute(id: t.id)) { ThreadRow(thread: t) } } }
                        header: { SectionHeader(text: "Open") }
                }
                if !resolved.isEmpty {
                    Section { ForEach(resolved) { t in NavigationLink(value: ThreadRoute(id: t.id)) { ThreadRow(thread: t) } } }
                        header: { SectionHeader(text: "Resolved") }
                }
                if d.threads.isEmpty {
                    EmptyState(symbol: "person.3", title: "Quiet so far", text: "Threads open here when work in this room needs discussing.")
                }
            } else if let e = model.rooms.error {
                ErrorRow(message: e) { Task { await load() } }
            } else {
                HStack { Spacer(); ProgressView(); Spacer() }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await load() }
        .navigationTitle(detail?.room.title ?? model.rooms.rooms.first { $0.id == id }?.title ?? "Room")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: id) { await load() }
    }

    private func load() async {
        guard let rest = model.rest else { return }
        await model.rooms.loadRoom(rest, id: id)
    }
}

struct ThreadRow: View {
    @Environment(AppModel.self) private var model
    let thread: RoomThread
    var isChannel = false
    var isEpic = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if isEpic {
                Image(systemName: "flag.fill").foregroundStyle(Color.accentColor).font(.title3).frame(width: 26)
            } else if isChannel {
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
    /// General and each area's own channel: everyone's, never resolved from here.
    private var isChannel: Bool { id == RoomStore.generalId || id.hasPrefix("th_area_") }
    /// The server refuses to resolve General, an area's channel, an epic's thread and Releases
    /// (400): only ordinary topic threads offer Resolve.
    private var canResolve: Bool {
        guard let t = thread, t.state == .open else { return false }
        if isChannel || id.hasPrefix("th_epic_") || id == "th_releases" || t.epicId != nil { return false }
        if let r = t.roomId, r != "general" { return false }
        return true
    }
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
                    if !t.headline.isEmpty && t.headline != t.title { Text(t.headline).font(.caption).foregroundStyle(.secondary) }
                }
                .padding(.horizontal, 16).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.bar)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        // Spinner only until the thread has loaded: an empty channel says so instead of
                        // spinning forever (an area's own channel starts with no messages).
                        if model.room.messages[id] == nil {
                            HStack { Spacer(); ProgressView(); Spacer() }.padding()
                        } else if messages.isEmpty {
                            Text("No messages yet. Say something, or @mention someone.").font(.subheadline).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding()
                        }
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
            if canResolve {
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
        } catch { if let m = error.userMessage { self.error = m } }
    }

    private func resolve() async {
        guard let rest = model.rest else { return }
        do { try await model.room.resolve(rest, threadId: id, summary: summary.trimmingCharacters(in: .whitespaces)); summary = "" }
        catch { if let m = error.userMessage { self.error = m } }
    }
}

/// One message: who, when, one line; the rest behind a chevron. The owner's are marked.
struct RoomMessageRow: View {
    @Environment(AppModel.self) private var model
    let message: RoomMessage
    @State private var expanded = false

    /// Only the owner's own words are "You": the COO posts as herself (`by: 'coo'`).
    private var isOwner: Bool { message.by == "owner" || (message.owner && message.by != "coo") }

    private var senderName: String {
        isOwner ? "You" : message.by == "workplace" ? "Workplace" : message.by == "coo" ? "Claude — COO" : model.employeeName(message.by)
    }

    var body: some View {
        if let kind = message.kind, kind != .message { UpdateLineRow(message: message) } else { bubble }
    }

    private var bubble: some View {
        let c = CompactText(text: message.text, details: message.details)
        return HStack(alignment: .top, spacing: 8) {
            if isOwner { Spacer(minLength: 40) }
            if !isOwner { InitialsAvatar(name: senderName, tint: message.by == "workplace" ? .secondary : .accentColor) }
            VStack(alignment: isOwner ? .trailing : .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(senderName).font(.caption.weight(.semibold)).foregroundStyle(isOwner ? Color.accentColor : .primary)
                    Text(Format.ago(message.at)).font(.caption2).foregroundStyle(.tertiary)
                    if c.hasDetails { Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption2).foregroundStyle(.secondary) }
                }
                Text(highlighted(expanded ? (message.details ?? message.text) : c.line))
                    .font(.subheadline)
                    .lineLimit(expanded ? nil : 1)
                    .multilineTextAlignment(isOwner ? .trailing : .leading)
                    .foregroundStyle(isOwner ? .white : .primary)
                    .textSelection(.enabled)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(isOwner ? Color.accentColor.opacity(0.9) : Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
            }
            if !isOwner { Spacer(minLength: 40) }
        }
        .frame(maxWidth: .infinity, alignment: isOwner ? .trailing : .leading)
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

/// A named update the room posts ("Story 'X' is done"), a stand-up or a release line: a quiet
/// centred line, not a chat bubble; tapping it opens the item it is about.
struct UpdateLineRow: View {
    @Environment(AppModel.self) private var model
    let message: RoomMessage
    @State private var expanded = false

    private var symbol: String {
        switch message.kind {
        case .standup: return "sunrise"
        case .release: return "shippingbox"
        default:
            let t = message.text.lowercased()
            if t.contains("blocked") && !t.contains("unblocked") { return "octagon.fill" }
            if t.contains("done") { return "checkmark.circle.fill" }
            if t.contains("started") { return "play.circle.fill" }
            return "info.circle"
        }
    }

    var body: some View {
        let line = HStack(alignment: .top, spacing: 6) {
            Image(systemName: symbol).foregroundStyle(symbol == "octagon.fill" ? Color.red : symbol == "checkmark.circle.fill" || symbol == "play.circle.fill" ? Color.green : Color.secondary)
            VStack(alignment: .leading, spacing: 2) {
                if message.kind == .standup, let who = message.about { Text("Stand-up · \(model.employeeName(who))").font(.caption.weight(.semibold)) }
                Text(expanded ? (message.details ?? message.text) : message.text).font(.caption).lineLimit(expanded ? nil : 3)
                Text(Format.ago(message.at)).font(.caption2).foregroundStyle(.tertiary)
            }
            if message.itemId != nil { Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary) }
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Color(.tertiarySystemFill).opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
        Group {
            if let id = message.itemId {
                NavigationLink(value: ItemRoute(id: id)) { line }.buttonStyle(.plain)
            } else {
                line.onTapGesture { if message.details != nil { withAnimation(.snappy) { expanded.toggle() } } }
            }
        }
        .accessibilityElement(children: .combine)
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
        } catch { if let m = error.userMessage { self.error = m } }
    }
}
