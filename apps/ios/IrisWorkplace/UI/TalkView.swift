import SwiftUI

/// Talk: a list of everyone you can talk to (the COO pinned first, Asha second, then by last
/// activity), and one chat component for every conversation (ChatThread.swift).
struct TalkView: View {
    @Environment(AppModel.self) private var model
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            TalkListView()
                .navigationDestination(for: TalkRoute.self) { r in ConversationView(employeeId: r.employeeId, path: $path) }
                .v2Destinations()
                .safeAreaInset(edge: .top, spacing: 0) { ConnectionStrip() }
                .onChange(of: model.router.talkEmployeeId, initial: true) { _, id in
                    guard let id else { return }
                    path = NavigationPath([TalkRoute(employeeId: id)])
                    model.router.talkEmployeeId = nil
                }
        }
    }
}

struct TalkRoute: Hashable { let employeeId: String }

/// WhatsApp-style: avatar with presence, name, a one-line preview or role, time and a badge.
/// Rows are one height. The COO first, Asha second, then by last activity.
struct TalkListView: View {
    @Environment(AppModel.self) private var model
    @State private var actionError: String?

    static let rowHeight: CGFloat = 64

    var body: some View {
        List {
            if model.office.data == nil {
                if let e = model.office.error {
                    ErrorRow(message: e) { Task { if let r = model.rest { await model.office.load(r) } } }
                } else {
                    HStack { Spacer(); ProgressView("Loading…"); Spacer() }
                }
            }
            ForEach(orderedCards) { card in
                let id = card.employee.id
                NavigationLink(value: TalkRoute(employeeId: id)) {
                    TalkListRow(card: card, preview: IdLinks.plain(preview(card)) { model.title(forId: $0) }, time: time(card),
                                pinned: isPinned(card), unread: unread(card), typing: thread(card).map { model.talkThreads.typing.contains($0.id) } ?? false)
                }
                .frame(height: Self.rowHeight)
                .listRowInsets(EdgeInsets(top: 0, leading: 14, bottom: 0, trailing: 12))
                .swipeActions(edge: .leading) {
                    Button { togglePin(card) } label: {
                        Label(isPinned(card) ? "Unpin" : "Pin", systemImage: isPinned(card) ? "pin.slash.fill" : "pin.fill")
                    }
                    .tint(.orange)
                }
                .contextMenu {
                    Button { togglePin(card) } label: {
                        Label(isPinned(card) ? "Unpin" : "Pin to top", systemImage: isPinned(card) ? "pin.slash" : "pin")
                    }
                    if unread(card) > 0 {
                        Button { markRead(card) } label: { Label("Mark as read", systemImage: "envelope.open") }
                    }
                }
                .accessibilityIdentifier("talk.row.\(id)")
            }
        }
        .listStyle(.plain)
        .navigationTitle("Talk")
        .refreshable { if let r = model.rest { await model.office.load(r); await model.coo.load(r); await model.talkThreads.load(r) } }
        .alert("Couldn't do that", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(actionError ?? "") }
        .task {
            guard let rest = model.rest else { return }
            if model.office.data == nil { await model.office.load(rest) }
            model.talkPrefs.seed(chiefOfStaff: model.chiefOfStaff)
            if !model.coo.loaded { await model.coo.load(rest) }
            await model.talkThreads.load(rest)
            // Titles for the ids the previews mention.
            await model.loadTitles(in: model.office.cards.compactMap(\.lastReport) + model.coo.log.suffix(1).map(\.text))
        }
    }

    /// Pinned first (in pin order), then unread, then by last activity (newest first).
    static func ordered(_ cards: [EmployeeCard], pinned: [String], unread: (EmployeeCard) -> Int, lastAt: (EmployeeCard) -> String?) -> [EmployeeCard] {
        var seen = Set<String>()
        let unique = cards.filter { seen.insert($0.employee.id).inserted }
        return TalkPrefs.order(unique, id: { $0.employee.id }, lastAt: lastAt, unread: unread, pinned: pinned, name: { $0.employee.name })
    }

    static func lastActivity(_ c: EmployeeCard) -> String? { c.session.map { $0.endedAt ?? $0.startedAt } }

    // MARK: threads (the server's, else this phone's pins and read marks)

    /// The card's Talk thread, when the server has them: `coo` for the COO, else the employee id.
    private func thread(_ c: EmployeeCard) -> TalkThread? {
        guard model.talkThreads.supported == true else { return nil }
        return model.talkThreads.threads[c.employee.virtual == true ? "coo" : c.employee.id] ?? model.talkThreads.threads[c.employee.id]
    }

    private var orderedCards: [EmployeeCard] {
        let cards = model.office.cards
        if model.talkThreads.supported == true {
            let pinned = model.talkThreads.threads.values.filter(\.pinned).sorted { ($0.pinnedAt ?? "") > ($1.pinnedAt ?? "") }
                .compactMap { t in cards.first { thread($0)?.id == t.id }?.employee.id }
            return Self.ordered(cards, pinned: pinned, unread: unread, lastAt: lastAt)
        }
        return Self.ordered(cards, pinned: model.talkPrefs.pinned, unread: unread, lastAt: lastAt)
    }

    private func isPinned(_ c: EmployeeCard) -> Bool { thread(c)?.pinned ?? model.talkPrefs.isPinned(c.employee.id) }

    private func togglePin(_ c: EmployeeCard) {
        guard let t = thread(c) else { withAnimation { model.talkPrefs.togglePin(c.employee.id) }; return }
        guard let rest = model.rest else { return }
        Task {
            do { try await model.talkThreads.setPinned(rest, threadId: t.id, pinned: !t.pinned) }
            catch { if let m = error.userMessage { actionError = m } }
        }
    }

    private func markRead(_ c: EmployeeCard) {
        model.talkPrefs.markRead(c.employee.id)
        if let t = thread(c), let rest = model.rest { Task { await model.talkThreads.markRead(rest, threadId: t.id) } }
    }

    /// The COO's last message, or the session's last activity.
    private func lastAt(_ c: EmployeeCard) -> String? {
        if let t = thread(c) { return t.lastMessageAt }
        if c.employee.virtual == true { return model.coo.log.last?.at }
        return Self.lastActivity(c)
    }

    private func unread(_ c: EmployeeCard) -> Int {
        if let t = thread(c) { return t.unreadCount }
        let them: String? = c.employee.virtual == true ? model.coo.log.last(where: { $0.from != .owner })?.at : Self.lastActivity(c)
        return model.talkPrefs.unread(c.employee.id, lastFromThemAt: them)
    }

    private func preview(_ c: EmployeeCard) -> String {
        if let t = thread(c) {
            if model.talkThreads.typing.contains(t.id) { return "typing…" }
            if let m = t.lastMessage { return (m.from == "owner" ? "You: " : m.from == t.id || (t.id == "coo" && m.from == "coo") ? "" : "\(m.fromName): ") + m.text }
        }
        if c.employee.virtual == true, let last = model.coo.log.last { return (last.from == .owner ? "You: " : "") + last.text }
        // Busy: what they are on. Otherwise their last line. Never "typing" from a working state.
        if c.employee.state == .working, let w = c.currentWork { return "Working on \(w.title)" }
        if let r = c.lastReport, !r.isEmpty { return r }
        return c.charters.map(\.title).joined(separator: " · ")
    }

    private func time(_ c: EmployeeCard) -> String? {
        if let t = thread(c), let at = t.lastMessageAt { return Format.ago(at) }
        if c.employee.virtual == true, let last = model.coo.log.last { return Format.ago(last.at) }
        return Self.lastActivity(c).map { Format.ago($0) }
    }
}

struct TalkListRow: View {
    let card: EmployeeCard
    let preview: String
    let time: String?
    var pinned = false
    var unread = 0
    var typing = false

    /// Presence: the COO's heartbeat; for an employee, a session that is live right now.
    private var online: Bool? {
        if let o = card.employee.isOnline { return o }
        switch card.session?.status {
        case .running?, .waiting?: return true
        default: return false
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            ZStack(alignment: .bottomTrailing) {
                InitialsAvatar(name: card.employee.name, size: 44, tint: card.employee.virtual == true ? .indigo : .accentColor)
                PresenceDot(online: online).offset(x: 1, y: 1)
            }
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(card.employee.name).font(.subheadline.weight(unread > 0 ? .bold : .semibold)).lineLimit(1)
                    Spacer(minLength: 6)
                    if let time { Text(time).font(.caption2.weight(unread > 0 ? .semibold : .regular)).foregroundStyle(unread > 0 ? Color.accentColor : .secondary) }
                }
                HStack {
                    Text(preview).font(.caption).foregroundStyle(typing ? Color.accentColor : unread > 0 ? .primary : .secondary).lineLimit(1)
                    Spacer(minLength: 6)
                    if pinned {
                        Image(systemName: "pin.fill").font(.caption2).foregroundStyle(.secondary).rotationEffect(.degrees(45))
                            .accessibilityLabel("Pinned")
                    }
                    if unread > 0 {
                        Text("\(unread)").font(.caption2.weight(.bold)).foregroundStyle(.white)
                            .padding(.horizontal, 6).frame(minWidth: 18, minHeight: 18)
                            .background(Color.accentColor, in: Capsule())
                            .accessibilityLabel("\(unread) unread")
                    }
                    if card.needsYou > 0 {
                        Text("\(card.needsYou)").font(.caption2.weight(.bold)).foregroundStyle(.white)
                            .padding(.horizontal, 6).frame(minWidth: 18, minHeight: 18)
                            .background(Color.orange, in: Capsule())
                            .accessibilityLabel("\(card.needsYou) waiting on you")
                    }
                }
            }
        }
        .frame(maxHeight: .infinity)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// A day break in a chat.
struct DaySeparator: View {
    let text: String
    var body: some View {
        Text(text).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            .padding(.horizontal, 10).padding(.vertical, 3)
            .background(Color(.tertiarySystemFill), in: Capsule())
            .frame(maxWidth: .infinity).padding(.vertical, 8)
    }
}

/// One conversation: the COO's bridge chat or an employee's session, in the same component.
struct ConversationView: View {
    @Environment(AppModel.self) private var model
    let employeeId: String
    @Binding var path: NavigationPath
    @State private var draft = ""
    @State private var replyTo: ChatItem?
    @State private var pending: [OutgoingAttachment] = []
    @State private var error: String?
    @State private var showProfile = false
    @State private var showAssign = false
    @State private var confirmEnd = false
    @State private var confirmInterrupt = false

    private var talk: TalkStore { model.talk }
    private var isCoo: Bool { employeeId == "coo" || model.office.card(employeeId)?.employee.virtual == true }
    private var name: String { isCoo ? (model.office.card(employeeId)?.employee.name ?? "Claude — COO") : (talk.detail?.employee.name ?? model.employeeName(employeeId)) }
    private var cooOnline: Bool? { model.coo.presence?.online ?? model.office.card(employeeId)?.employee.isOnline }

    var body: some View {
        Group {
            if model.talkThreads.supported == true { threadChat } else if isCoo { cooChat } else { employeeChat }
        }
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                ChatTitle(name: name, subtitle: subtitle, online: isCoo ? cooOnline : sessionOnline, tint: isCoo ? .indigo : .accentColor)
            }
            ToolbarItem(placement: .topBarTrailing) { menu }
        }
        .toolbar(.visible, for: .tabBar)
        .sheet(isPresented: $showProfile) { EmployeeProfileView() }
        .sheet(isPresented: $showAssign) { AssignView(employeeId: employeeId) }
        .confirmationDialog("End \(name)'s session?", isPresented: $confirmEnd, titleVisibility: .visible) {
            Button("End and write handoff", role: .destructive) {
                Task { do { if let r = model.rest { try await model.talk.endSession(r) } } catch { if let m = error.userMessage { self.error = m } } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The employee writes status and handoff, then the session closes. The next message starts a fresh one from the files.")
        }
        .confirmationDialog("Stop \(name)'s current run?", isPresented: $confirmInterrupt, titleVisibility: .visible) {
            Button("Stop the run", role: .destructive) {
                Task { do { if let r = model.rest { try await talk.interrupt(r) } } catch { if let m = error.userMessage { self.error = m } } }
            }
            Button("Keep working", role: .cancel) {}
        } message: { Text("The session stops mid-step; the work so far stays on its branch.") }
        .task(id: employeeId) {
            guard let rest = model.rest else { return }
            if model.talkThreads.supported == nil { await model.talkThreads.load(rest) }
            if model.talkThreads.supported == true {
                await model.talkThreads.loadMessages(rest, threadId: threadId)
                await model.talkThreads.markRead(rest, threadId: threadId)
            }
            if isCoo {
                await model.coo.load(rest)
                model.coo.pollPresence(rest)
            } else if talk.employeeId != employeeId || talk.detail == nil {
                await talk.select(rest, employeeId: employeeId)
            } else {
                await talk.reload(rest)
            }
        }
        .onDisappear { if isCoo { model.coo.stopPolling() }; model.talkPrefs.markRead(employeeId) }
        .onAppear { model.talkPrefs.markRead(employeeId) }
        .onChange(of: isCoo ? model.coo.log.count : talk.log.count) { _, _ in model.talkPrefs.markRead(employeeId) }
        .onChange(of: model.talkThreads.messages[threadId]?.count ?? 0) { _, _ in
            // A message arrived while the thread is on screen: it is read (LLD-app-fixes §2).
            if let r = model.rest { Task { await model.talkThreads.markRead(r, threadId: threadId) } }
        }
    }

    private var sessionOnline: Bool? {
        switch talk.session?.status {
        case .running?, .waiting?: return true
        default: return false
        }
    }

    private var subtitle: String {
        if isCoo { return cooOnline == false ? "Offline · messages wait" : "Online" }
        guard talk.employeeId == employeeId, let s = talk.session else { return talk.detail?.employee.state.glyph.label ?? " " }
        switch s.status {
        case .running: return "Busy on a task"
        case .waiting: return "Waiting for you"
        default: return "\(s.status.glyph.label) · $\(String(format: "%.2f", s.usage.costUsd))"
        }
    }

    private func open(_ link: AppLink) {
        switch link {
        case .item(let id): path.append(ItemRoute(id: id))
        case .room(let id): path.append(ThreadRoute(id: id))
        case .releasePost(let id): path.append(ReleasePostRoute(id: id))
        default: model.open(link)
        }
    }

    // MARK: Talk thread (LLD-app-fixes)

    /// The COO's thread is `coo`; an employee's is their id.
    private var threadId: String { isCoo ? "coo" : employeeId }
    private var threads: TalkThreadsStore { model.talkThreads }

    private var threadChat: some View {
        let mine = talk.employeeId == employeeId
        return ChatThreadView(
            items: ChatItem.from(talk: threads.shown(threadId), threadId: threadId, sentFiles: threads.sentFiles),
            typing: threads.typing.contains(threadId),
            typingName: name,
            loading: threads.loadingThread.contains(threadId) && threads.messages[threadId] == nil,
            emptyTitle: isCoo ? "Nothing yet" : "No messages yet",
            emptyText: isCoo ? "Say what you need. The COO answers within its own authority, or brings you a recommendation."
                             : "Your first message starts a session from \(name)'s context: handbook, unit, charter, status and handoff.",
            placeholder: isCoo ? "Message the COO" : "Message \(name)",
            draft: $draft,
            replyTo: $replyTo,
            sending: threads.sending.contains(threadId),
            onSend: { Task { await sendToThread() } },
            trailing: {
                if !isCoo && mine && talk.isRunning {
                    Button { confirmInterrupt = true } label: {
                        Image(systemName: "stop.fill").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                            .frame(width: 36, height: 36).background(Color.red, in: Circle())
                    }
                    .accessibilityLabel("Interrupt")
                }
            },
            header: {
                if isCoo, cooOnline == false {
                    Text("The COO is offline: messages wait; Asha handles routine work meanwhile.")
                        .font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity).padding(.vertical, 6).background(.bar)
                } else if !isCoo, mine, let d = talk.detail, !d.needsYou.isEmpty {
                    NeedsYouBanner(count: d.needsYou.count, name: name).padding(.top, 6)
                }
            },
            footer: {
                VStack(spacing: 8) {
                    if !isCoo, mine, let a = talk.pendingApproval, let s = talk.session {
                        ApprovalCard(approval: a, agentId: s.id) { self.error = $0 }
                    }
                    if let e = error ?? threads.error {
                        Label(e, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.footnote)
                    }
                }
            },
            onOpen: open,
            // The COO's thread takes text and voice, not files (§2).
            pending: isCoo ? nil : $pending,
            onVoice: { note in Task { await sendToThread(voice: note) } },
            onComposerError: { self.error = $0 },
            mentionable: model.mentionable.filter { $0 != threadId }
        )
    }

    private func sendToThread(voice: OutgoingAttachment? = nil) async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let rest = model.rest, voice != nil || !text.isEmpty || !pending.isEmpty else { return }
        let quoted = replyTo.flatMap { r in threads.shown(threadId).first { $0.id == r.id } }
        error = nil
        do {
            let agent: Agent?
            if let voice {
                agent = try await threads.sendVoice(rest, threadId: threadId, note: voice, replyTo: quoted)
            } else {
                let mentions = RoomStore.mentions(in: text, known: model.mentionable)
                agent = try await threads.send(rest, threadId: threadId, text: text, replyTo: quoted, mentions: mentions, files: pending)
                draft = ""; pending = []
            }
            replyTo = nil
            if let agent, !isCoo { await talk.adopt(rest, agent: agent) }
        } catch {
            if let m = error.userMessage { self.error = m }
        }
    }

    // MARK: employee

    private var employeeChat: some View {
        let mine = talk.employeeId == employeeId
        return ChatThreadView(
            items: mine ? ChatItem.from(log: talk.chatLog) : [],
            // Typing comes only from the server's talk.typing (threads); an older server has no
            // honest signal, so nothing shows rather than dots the moment the owner sends.
            typing: false,
            typingName: name,
            loading: talk.loading || !mine,
            emptyTitle: "No session open",
            emptyText: "Your first message starts one from \(name)'s context: handbook, unit, charter, status and handoff.",
            placeholder: "Message \(name)",
            draft: $draft,
            replyTo: $replyTo,
            sending: talk.sending,
            onSend: { Task { await sendToEmployee() } },
            trailing: {
                if mine && talk.isRunning {
                    // Confirmed first: a stray tap next to Send must never stop a live session.
                    Button { confirmInterrupt = true } label: {
                        Image(systemName: "stop.fill").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                            .frame(width: 36, height: 36).background(Color.red, in: Circle())
                    }
                    .accessibilityLabel("Interrupt")
                }
            },
            header: {
                if mine, let d = talk.detail, !d.needsYou.isEmpty {
                    NeedsYouBanner(count: d.needsYou.count, name: name).padding(.top, 6)
                }
            },
            footer: {
                VStack(spacing: 8) {
                    if mine, let a = talk.pendingApproval, let s = talk.session {
                        ApprovalCard(approval: a, agentId: s.id) { self.error = $0 }
                    }
                    if let e = (mine ? talk.error : nil) ?? error {
                        Label(e, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.footnote)
                    }
                }
            },
            onOpen: open,
            pending: $pending,
            onVoice: { note in Task { await sendToEmployee(voice: note) } },
            onComposerError: { self.error = $0 },
            mentionable: model.mentionable.filter { $0 != employeeId }
        )
    }

    private func sendToEmployee(voice: OutgoingAttachment? = nil) async {
        let typed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = voice.map { [$0] } ?? pending
        guard !typed.isEmpty || !files.isEmpty, let rest = model.rest else { return }
        let text = ChatReply.compose(typed.isEmpty && voice != nil ? "" : typed, replyTo: voice == nil ? replyTo : nil, counterpart: name)
        error = nil
        do {
            try await talk.send(rest, text: text.isEmpty ? (voice != nil ? "🎤 Voice note" : "📎 Attachment") : text, attachments: files)
            if voice == nil { draft = ""; pending = []; replyTo = nil }
        } catch { if let m = error.userMessage { self.error = m } }
    }

    // MARK: COO

    private var cooChat: some View {
        ChatThreadView(
            items: ChatItem.from(coo: model.coo.log),
            typing: false,
            typingName: name,
            loading: model.coo.loading,
            emptyTitle: "Nothing yet",
            emptyText: "Say what you need. The COO answers within its own authority, or brings you a recommendation.",
            placeholder: "Message the COO",
            draft: $draft,
            replyTo: $replyTo,
            sending: model.coo.sending,
            onSend: { Task { await sendToCoo() } },
            trailing: { EmptyView() },
            header: {
                if cooOnline == false {
                    Text("The COO is offline: messages wait; Asha handles routine work meanwhile.")
                        .font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity).padding(.vertical, 6).background(.bar)
                }
            },
            footer: {
                if let e = model.coo.error ?? error {
                    Label(e, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.footnote)
                }
            },
            onOpen: open
        )
    }

    private func sendToCoo() async {
        let typed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty, let rest = model.rest else { return }
        let text = ChatReply.compose(typed, replyTo: replyTo, counterpart: name)
        error = nil
        do { try await model.coo.send(rest, text: text); draft = ""; replyTo = nil } catch { if let m = error.userMessage { self.error = m } }
    }

    // MARK: menu

    @ViewBuilder private var menu: some View {
        if isCoo {
            Button { Task { if let r = model.rest { await model.coo.load(r) } } } label: { Image(systemName: "arrow.clockwise") }
                .accessibilityLabel("Refresh")
        } else {
            Menu {
                Button { showProfile = true } label: { Label("Charter and status", systemImage: "doc.text") }
                Button { showAssign = true } label: { Label("Assign work to \(name)", systemImage: "tray.and.arrow.down") }
                if let s = talk.session {
                    Menu {
                        ForEach(PermissionMode.choices, id: \.self) { m in
                            Button {
                                Task { do { try await model.send(.agentMode(agentId: s.id, mode: m)) } catch { if let msg = error.userMessage { self.error = msg } } }
                            } label: {
                                if s.permissionMode == m { Label(m.title, systemImage: "checkmark") } else { Text(m.title) }
                            }
                        }
                    } label: { Label("Permission: \(s.permissionMode?.title ?? "—")", systemImage: "lock.shield") }
                    Button(role: .destructive) { confirmEnd = true } label: { Label("End session (write handoff)", systemImage: "square.and.arrow.down") }
                }
                Button { Task { if let r = model.rest { await talk.reload(r) } } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
            } label: { Image(systemName: "ellipsis.circle") }
            .accessibilityLabel("More")
        }
    }
}

/// What this employee is waiting on you for, as one line above the chat: the decisions live in the
/// Inbox, the chat stays a chat.
struct NeedsYouBanner: View {
    @Environment(AppModel.self) private var model
    let count: Int
    let name: String

    var body: some View {
        Button { model.router.tab = .inbox } label: {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange)
                Text("\(count) decision\(count == 1 ? "" : "s") from \(name) wait\(count == 1 ? "s" : "") on you").font(.caption.weight(.semibold))
                Spacer()
                Text("Inbox").font(.caption)
                Image(systemName: "chevron.right").font(.caption2)
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 12)
    }
}

/// The session is waiting on a tool. Allow once, always for this tool, or deny.
struct ApprovalCard: View {
    @Environment(AppModel.self) private var model
    let approval: PendingApproval
    let agentId: String
    let onError: (String) -> Void
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Approve \(approval.tool)?", systemImage: "hand.raised.circle.fill").font(.headline).foregroundStyle(.orange)
            if !approval.reason.isEmpty { Text(approval.reason).font(.subheadline).foregroundStyle(.secondary) }
            ScrollView(.horizontal) {
                Text(approval.input).font(.caption.monospaced()).textSelection(.enabled)
            }
            .frame(maxHeight: 120)
            HStack {
                Button("Allow once") { decide(.once) }.buttonStyle(.borderedProminent)
                Button("Always") { decide(.always) }.buttonStyle(.bordered)
                Button("Deny", role: .destructive) { decide(.deny) }.buttonStyle(.bordered)
                if busy { ProgressView() }
            }
            .disabled(busy)
        }
        .padding(12)
        .background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.orange.opacity(0.5)))
        .padding(.horizontal, 12)
        .accessibilityElement(children: .contain)
    }

    private func decide(_ d: ApprovalDecision) {
        busy = true
        Task {
            defer { busy = false }
            do { try await model.send(.agentApprove(agentId: agentId, approvalId: approval.id, decision: d)) }
            catch { if let m = error.userMessage { onError(m) } }
        }
    }
}

/// Charter, status, handoff, assignments and sessions of the selected employee.
struct EmployeeProfileView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var charter: Charter?
    @State private var charterError: String?

    var body: some View {
        NavigationStack {
            List {
                if let d = model.talk.detail {
                    Section {
                        LabeledContent("Role", value: d.employee.roleId)
                        LabeledContent("Level", value: levelName(d.employee.level))
                        LabeledContent("Unit", value: d.employee.unitId)
                        if let r = d.employee.reportsTo { LabeledContent("Reports to", value: model.employeeName(r)) }
                        LabeledContent("Budget", value: "\(Format.inr(d.employee.budget.inrPerDay))/day · \(d.employee.budget.concurrentSessions) sessions")
                        LabeledContent("Spend today", value: Format.inr(d.spendTodayInr))
                        LabeledContent("Workspace", value: d.employee.workspace.worktree ?? d.employee.workspace.repo).lineLimit(2)
                        if let b = d.employee.workspace.branch { LabeledContent("Branch", value: b) }
                        if let g = d.employee.githubApp { LabeledContent("GitHub identity", value: "\(g)[bot]") }
                    } header: { HStack { SectionHeader(text: d.employee.name); Spacer(); StateLabel(glyph: d.employee.state.glyph, compact: true) } }

                    Section {
                        Prose(text: d.status.isEmpty ? "No status written yet." : d.status)
                    } header: { SectionHeader(text: "Status") }
                    Section {
                        Prose(text: d.handoff.isEmpty ? "No handoff written yet." : d.handoff)
                    } header: { SectionHeader(text: "Handoff") }

                    Section {
                        ForEach(d.charters) { c in
                            NavigationLink { CharterView(summary: c) } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack { Text(c.title).font(.headline); Spacer(); Pill(text: c.axis.rawValue, tint: .secondary) }
                                    Text(c.mission).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                    Text("v\(c.version) · ~\(c.tokens) tokens").font(.caption2).foregroundStyle(.tertiary)
                                }
                            }
                        }
                    } header: { SectionHeader(text: "Charters") }

                    if !d.assignments.isEmpty {
                        Section {
                            ForEach(d.assignments) { a in
                                HStack(alignment: .top, spacing: 8) {
                                    Image(systemName: a.state.glyph.symbol).foregroundStyle(a.state.glyph.tint)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(a.title).font(.subheadline)
                                        Text(a.state.glyph.label).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        } header: { SectionHeader(text: "Assignments") }
                    }

                    Section {
                        LabeledContent("Throughput (7 d)", value: String(format: "%.0f", d.signals.throughput7d))
                        LabeledContent("Rework (7 d)", value: String(format: "%.0f", d.signals.rework7d))
                        LabeledContent("False-done rate", value: Format.percent(Int((d.signals.falseDoneRate7d * 100).rounded()), of: 100))
                        LabeledContent("Cost per done item", value: Format.inr(d.signals.costPerDoneInr))
                    } header: { SectionHeader(text: "Signals") }

                    if !d.sessions.isEmpty {
                        Section {
                            ForEach(d.sessions) { s in
                                HStack {
                                    StateLabel(glyph: s.status.glyph, compact: true)
                                    Text(s.task).font(.caption).lineLimit(1)
                                    Spacer()
                                    Text(Format.ago(s.startedAt)).font(.caption2).foregroundStyle(.tertiary)
                                }
                            }
                        } header: { SectionHeader(text: "Sessions") }
                    }
                } else {
                    HStack { Spacer(); ProgressView(); Spacer() }
                }
            }
            .navigationTitle("Profile")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func levelName(_ l: Level) -> String {
        switch l {
        case .chiefOfStaff: return "Chief of Staff"
        case .lead: return "Lead (permanent)"
        case .hire: return "Hire (contractor)"
        }
    }
}

struct CharterView: View {
    @Environment(AppModel.self) private var model
    let summary: CharterSummary
    @State private var charter: Charter?
    @State private var error: String?

    var body: some View {
        List {
            Section {
                Text(summary.mission).font(.body)
                HStack {
                    Pill(text: summary.axis.rawValue, tint: .secondary)
                    Pill(text: "v\(summary.version)", tint: .secondary)
                    Pill(text: "held by " + summary.holderIds.map { model.employeeName($0) }.joined(separator: ", "), tint: .secondary)
                }
            } header: { SectionHeader(text: "Mission") }
            if let c = charter {
                list("Scope", c.scope)
                if !c.owns.isEmpty {
                    Section {
                        ForEach(Array(c.owns.enumerated()), id: \.offset) { _, o in
                            HStack { Pill(text: o.kind.rawValue, tint: .secondary); Text(o.key).font(.caption.monospaced()) }
                        }
                    } header: { SectionHeader(text: "Owns") }
                }
                list("Rules", c.rules)
                list("Definition of done", c.definitionOfDone)
                list("Build, test, ship", c.buildTestShip)
                list("Coordinates with", c.coordinateWith.map { model.charterTitle($0) })
                list("Needs the owner's approval", c.needsOwnerApproval)
                list("Publishes", c.interfaces.publishes)
                list("Consumes", c.interfaces.consumes)
                Section { Prose(text: c.body) } header: { SectionHeader(text: "Charter text") }
            } else if let error {
                ErrorRow(message: error) { Task { await load() } }
            } else {
                HStack { Spacer(); ProgressView(); Spacer() }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(summary.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    @ViewBuilder private func list(_ title: String, _ items: [String]) -> some View {
        if !items.isEmpty {
            Section {
                ForEach(Array(items.enumerated()), id: \.offset) { _, s in
                    HStack(alignment: .top, spacing: 6) { Text("•"); Text(s).font(.subheadline) }
                }
            } header: { SectionHeader(text: title) }
        }
    }

    private func load() async {
        guard let rest = model.rest else { return }
        do { charter = try await rest.charter(summary.id); error = nil } catch { if let m = error.userMessage { self.error = m } }
    }
}
