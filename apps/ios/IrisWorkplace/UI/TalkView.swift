import SwiftUI

/// Pick an employee, then the conversation: the session log streamed live, the composer, inline
/// tool approvals, interrupt, and the charter / status sheet.
struct TalkView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            Group {
                if model.talk.employeeId == nil {
                    EmployeePicker()
                } else {
                    ConversationView()
                }
            }
            .safeAreaInset(edge: .top, spacing: 0) { ConnectionStrip() }
            .onChange(of: model.router.talkEmployeeId, initial: true) { _, id in
                guard let id, let rest = model.rest else { return }
                // Cleared only once selection finishes, not before dispatching it: both handlers
                // fire synchronously (both `initial: true`) on first appearance, in source order —
                // clearing it up front let the chief-of-staff default below see it as nil in that
                // same pass and race a second, later-finishing `select` that silently overwrote an
                // explicit `talk(to:)` (e.g. the Office card) with Asha.
                Task {
                    await model.talk.select(rest, employeeId: id)
                    model.router.talkEmployeeId = nil
                }
            }
            .onChange(of: model.office.data?.chiefOfStaff, initial: true) { _, cos in
                // Asha by default: the first thing Talk shows is the Chief of Staff, one tap from anything.
                guard model.talk.employeeId == nil, model.router.talkEmployeeId == nil, let cos, let rest = model.rest else { return }
                Task { await model.talk.select(rest, employeeId: cos) }
            }
        }
    }
}

struct EmployeePicker: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            if model.office.data == nil {
                if let e = model.office.error {
                    ErrorRow(message: e) { Task { if let r = model.rest { await model.office.load(r) } } }
                } else {
                    HStack { Spacer(); ProgressView("Loading the employees…"); Spacer() }
                }
            }
            ForEach(model.office.data?.units ?? []) { u in
                Section {
                    ForEach(u.employees) { card in
                        Button {
                            model.router.talk(to: card.employee.id)
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: card.employee.state.glyph.symbol).foregroundStyle(card.employee.state.glyph.tint).font(.title3).frame(width: 26)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(card.employee.name).font(.headline)
                                    Text(card.charters.map(\.title).joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(card.employee.state.glyph.label).font(.caption).foregroundStyle(.secondary)
                                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                } header: { SectionHeader(text: u.unit.title) }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Talk to…")
        .task { if model.office.data == nil, let r = model.rest { await model.office.load(r) } }
    }
}

struct ConversationView: View {
    @Environment(AppModel.self) private var model
    @State private var draft = ""
    @State private var error: String?
    @State private var showProfile = false
    @State private var showAssign = false
    @State private var confirmEnd = false
    @FocusState private var composing: Bool

    private var talk: TalkStore { model.talk }
    private var name: String { talk.detail?.employee.name ?? model.employeeName(talk.employeeId) }
    /// The COO is never spawned (no session, no tool calls): its own chat, not this one.
    private var isCoo: Bool { talk.detail?.employee.virtual == true || talk.employeeId == "coo" }

    var body: some View {
        Group {
            if isCoo { CooTalkView() } else { employeeConversation }
        }
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .sheet(isPresented: $showProfile) { EmployeeProfileView() }
        .sheet(isPresented: $showAssign) { AssignView(employeeId: talk.employeeId) }
        .confirmationDialog("End \(name)'s session?", isPresented: $confirmEnd, titleVisibility: .visible) {
            Button("End and write handoff", role: .destructive) {
                Task { do { if let r = model.rest { try await model.talk.endSession(r) } } catch { self.error = error.localizedDescription } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The employee writes status and handoff, then the session closes. The next message starts a fresh one from the files.")
        }
    }

    private var employeeConversation: some View {
        VStack(spacing: 0) {
            sessionStrip
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if let d = talk.detail, !d.needsYou.isEmpty {
                            NeedsYouSection(items: d.needsYou, name: name)
                        }
                        if talk.loading && talk.log.isEmpty {
                            HStack { Spacer(); ProgressView(); Spacer() }.padding()
                        } else if talk.session == nil && !talk.loading {
                            VStack(spacing: 8) {
                                Image(systemName: "bubble.left.and.text.bubble.right").font(.largeTitle).foregroundStyle(.secondary)
                                Text("No session open").font(.headline)
                                Text("Your first message starts one from \(name)'s layered context: handbook, unit, charter, status and handoff.")
                                    .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                            }
                            .padding(24)
                        }
                        let items = talk.chatLog
                        ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                            let previousAt = i > 0 ? items[i - 1].at : nil
                            if let label = Format.chatSeparator(since: previousAt, at: item.at) {
                                DateSeparator(text: label)
                            }
                            LogRow(entry: item).id(item.id)
                        }
                        if talk.isRunning {
                            WorkingBubble(name: name).id("working")
                        }
                        if let a = talk.pendingApproval, let s = talk.session {
                            ApprovalCard(approval: a, agentId: s.id) { self.error = $0 }.id("approval")
                        }
                        if let e = talk.error ?? error {
                            Label(e, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.subheadline).padding(.horizontal)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.vertical, 8)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: talk.log.count) { _, _ in withAnimation { proxy.scrollTo("bottom") } }
                .onChange(of: talk.isRunning) { _, running in if running { withAnimation { proxy.scrollTo("working") } } }
                .onChange(of: talk.pendingApproval) { _, a in if a != nil { withAnimation { proxy.scrollTo("approval") } } }
                .onAppear { proxy.scrollTo("bottom") }
            }
            composer
        }
    }

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button { model.talk.deselect() } label: { Label("Someone else", systemImage: "person.2") }
                .accessibilityLabel("Talk to someone else")
        }
        ToolbarItem(placement: .topBarTrailing) {
            if isCoo {
                // The COO is never assigned, has no permission mode and no session to end.
                Button { Task { if let r = model.rest { await model.coo.load(r) } } } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("Refresh")
            } else {
                Menu {
                    Button { showProfile = true } label: { Label("Charter and status", systemImage: "doc.text") }
                    Button { showAssign = true } label: { Label("Assign work to \(name)", systemImage: "tray.and.arrow.down") }
                    if let s = talk.session {
                        Menu {
                            ForEach(PermissionMode.allCases, id: \.self) { m in
                                Button {
                                    Task { await send(.agentMode(agentId: s.id, mode: m)) }
                                } label: {
                                    if s.permissionMode == m { Label(m.title, systemImage: "checkmark") } else { Text(m.title) }
                                }
                            }
                        } label: { Label("Permission: \(s.permissionMode?.title ?? "—")", systemImage: "lock.shield") }
                        Button(role: .destructive) { confirmEnd = true } label: { Label("End session (write handoff)", systemImage: "square.and.arrow.down") }
                    }
                    Button { Task { if let r = model.rest { await model.talk.reload(r) } } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                } label: { Image(systemName: "ellipsis.circle") }
                .accessibilityLabel("More")
            }
        }
    }

    @ViewBuilder private var sessionStrip: some View {
        if let s = talk.session {
            HStack(spacing: 8) {
                StateLabel(glyph: s.status.glyph, compact: true)
                Text("·").foregroundStyle(.secondary)
                Text(s.task).font(.caption).lineLimit(1).foregroundStyle(.secondary)
                Spacer()
                if let m = s.permissionMode { Pill(text: m.title, symbol: "lock.shield", tint: .secondary) }
                Text("$\(s.usage.costUsd, specifier: "%.2f")").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 16).padding(.vertical, 6)
            .background(.bar)
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message \(name)", text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.roundedBorder)
                .focused($composing)
            if talk.isRunning {
                Button {
                    Task { do { if let r = model.rest { try await model.talk.interrupt(r) } } catch { self.error = error.localizedDescription } }
                } label: { Image(systemName: "stop.circle.fill").font(.title) }
                .foregroundStyle(.red)
                .accessibilityLabel("Interrupt")
            }
            Button { Task { await sendDraft() } } label: {
                if talk.sending { ProgressView().frame(width: 28, height: 28) } else { Image(systemName: "arrow.up.circle.fill").font(.title) }
            }
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || talk.sending)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(.bar)
    }

    private func sendDraft() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let rest = model.rest else { return }
        error = nil
        do {
            try await model.talk.send(rest, text: text)
            draft = ""
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func send(_ command: ClientCommand) async {
        do { try await model.send(command) } catch { self.error = error.localizedDescription }
    }
}

extension TalkStore {
    func deselect() { clear() }
}

/// The owner's Talk with "Claude — COO": not a session — no tool calls, no thinking, no mirroring.
/// Only what the owner sent and what the lead replied through `POST /api/coo/reply` ever appear
/// here. `coo.presence` is not in the contract yet, so presence is polled while this is on screen.
struct CooTalkView: View {
    @Environment(AppModel.self) private var model
    @State private var draft = ""
    @State private var error: String?
    @FocusState private var composing: Bool

    private var coo: CooStore { model.coo }
    private var online: Bool { coo.presence?.online ?? (model.talk.detail?.employee.state == .online) }

    var body: some View {
        VStack(spacing: 0) {
            if !online {
                Text("The COO is offline: messages wait; Asha handles routine work in the meantime.")
                    .font(.caption).foregroundStyle(.secondary)
                    .padding(.horizontal, 16).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.bar)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if coo.loading && coo.log.isEmpty {
                            HStack { Spacer(); ProgressView(); Spacer() }.padding()
                        } else if coo.log.isEmpty {
                            VStack(spacing: 8) {
                                Image(systemName: "bubble.left.and.text.bubble.right").font(.largeTitle).foregroundStyle(.secondary)
                                Text("Nothing yet").font(.headline)
                                Text("Say what you need. The COO answers within its own authority, or brings you a recommendation.")
                                    .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                            }
                            .padding(24)
                        }
                        ForEach(Array(coo.log.enumerated()), id: \.element.id) { i, m in
                            let previousAt = i > 0 ? coo.log[i - 1].at : nil
                            if let label = Format.chatSeparator(since: previousAt, at: m.at) {
                                DateSeparator(text: label)
                            }
                            CooMessageRow(message: m).id(m.id)
                        }
                        if let e = coo.error ?? error {
                            Label(e, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.subheadline).padding(.horizontal)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.vertical, 8)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: coo.log.count) { _, _ in withAnimation { proxy.scrollTo("bottom") } }
                .onAppear { proxy.scrollTo("bottom") }
            }
            composer
        }
        .task {
            guard let rest = model.rest else { return }
            await coo.load(rest)
            coo.pollPresence(rest)
        }
        .onDisappear { coo.stopPolling() }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message the COO", text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.roundedBorder)
                .focused($composing)
            Button { Task { await sendDraft() } } label: {
                if coo.sending { ProgressView().frame(width: 28, height: 28) } else { Image(systemName: "arrow.up.circle.fill").font(.title) }
            }
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || coo.sending)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(.bar)
    }

    private func sendDraft() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let rest = model.rest else { return }
        error = nil
        do {
            try await coo.send(rest, text: text)
            draft = ""
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// One line from the owner or the COO; bubbled like Talk's. `summary`/`details` behind expand.
struct CooMessageRow: View {
    let message: CooMessage
    @State private var expanded = false

    private var owner: Bool { message.from == .owner }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if owner { Spacer(minLength: 40) }
            VStack(alignment: owner ? .trailing : .leading, spacing: 3) {
                Text(Format.time(message.at)).font(.caption2).foregroundStyle(.tertiary)
                let c = CompactText(text: message.summary ?? message.text, details: message.details)
                Text(expanded ? (c.details ?? c.line) : c.line)
                    .font(.subheadline)
                    .multilineTextAlignment(owner ? .trailing : .leading)
                    .foregroundStyle(owner ? .white : .primary)
                    .textSelection(.enabled)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(owner ? Color.accentColor.opacity(0.9) : Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
            }
            if !owner { Spacer(minLength: 40) }
        }
        .frame(maxWidth: .infinity, alignment: owner ? .trailing : .leading)
        .padding(.horizontal, 12)
        .contentShape(Rectangle())
        .onTapGesture { if c(message).hasDetails { withAnimation(.snappy) { expanded.toggle() } } }
    }

    private func c(_ message: CooMessage) -> CompactText { CompactText(text: message.summary ?? message.text, details: message.details) }
}

/// A quiet date/time break in the chat, like iMessage's — only when the gap is worth marking.
struct DateSeparator: View {
    let text: String
    var body: some View {
        Text(text).font(.caption2).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity).padding(.top, 6)
    }
}

/// A collapsed run of tool activity: `entry.text` is already "worked · N steps · Xs"
/// (`ChatView.collapse`, mirroring `toChatView`); expand shows `entry.activity.entries`.
struct ActivityRow: View {
    let entry: LogEntry
    @State private var expanded = false

    private var steps: [LogEntry] { entry.activity?.entries ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.snappy) { expanded.toggle() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "wrench.and.screwdriver").font(.caption).foregroundStyle(.secondary)
                    Text(entry.text).font(.caption).foregroundStyle(.secondary)
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .buttonStyle(.plain)
            if expanded {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(steps) { e in StepRow(entry: e) }
                }
                .padding(.leading, 4)
            }
        }
        .padding(.horizontal, 16)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(entry.text)
        .accessibilityHint(expanded ? "Collapses the steps" : "Expands the steps")
    }
}

/// A single, uncollapsed tool/read/edit/bash/search/task entry (`toChatView` leaves a lone one as
/// itself rather than wrapping it — "worked · 1 step" reads worse than just showing the read).
struct StepRow: View {
    let entry: LogEntry

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol).foregroundStyle(.secondary).frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.label.isEmpty ? entry.kind.rawValue : entry.label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text(entry.text).font(.caption.monospaced()).lineLimit(4).textSelection(.enabled)
            }
            Spacer()
            Text(Format.time(entry.at)).font(.caption2).foregroundStyle(.tertiary)
        }
    }

    private var symbol: String {
        switch entry.kind {
        case .read: return "doc.text.magnifyingglass"
        case .edit: return "pencil"
        case .bash: return "terminal"
        case .search: return "magnifyingglass"
        case .task: return "person.2"
        default: return "wrench"
        }
    }
}

/// The employee is running: an iMessage-style "…is working" bubble until the next reply or idle.
struct WorkingBubble: View {
    let name: String
    var body: some View {
        HStack {
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text("\(name) is working…").font(.subheadline).foregroundStyle(.secondary)
            }
            .padding(10)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
            Spacer(minLength: 48)
        }
        .padding(.horizontal, 12)
        .accessibilityElement(children: .combine)
    }
}

struct LogRow: View {
    let entry: LogEntry

    var body: some View {
        switch entry.kind {
        case .user:
            HStack {
                Spacer(minLength: 48)
                Text(entry.text)
                    .padding(10)
                    .background(Color.accentColor.opacity(0.85), in: RoundedRectangle(cornerRadius: 14))
                    .foregroundStyle(.white)
                    .textSelection(.enabled)
            }
            .padding(.horizontal, 12)
        case .assistant:
            HStack(alignment: .bottom) {
                CompactRow(text: entry.text, summary: entry.summary, details: entry.details)
                    .padding(10)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
                Spacer(minLength: 48)
            }
            .padding(.horizontal, 12)
        case .error:
            Label(entry.text, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.subheadline).padding(.horizontal, 16)
        case .system:
            Text(entry.text).font(.caption).italic().foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.horizontal, 16)
        case .image:
            HStack {
                Label("Image", systemImage: "photo").font(.caption).foregroundStyle(.secondary)
                    .padding(10).background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
                Spacer(minLength: 48)
            }
            .padding(.horizontal, 12)
        case .read, .edit, .bash, .search, .task, .tool:
            StepRow(entry: entry).padding(.horizontal, 16)
        case .activity:
            ActivityRow(entry: entry)
        }
    }
}

/// An assistant message: one line by default, the whole text on tap.
struct CompactRow: View {
    let text: String
    var summary: String? = nil
    var details: String? = nil
    @State private var expanded = false

    var body: some View {
        let c = CompactText(text: text, summary: summary, details: details)
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 6) {
                if expanded {
                    Prose(text: c.details ?? text)
                } else {
                    Text(c.line).font(.body).lineLimit(1)
                }
                if c.hasDetails {
                    Spacer(minLength: 0)
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption).foregroundStyle(.secondary).padding(.top, 4)
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { if c.hasDetails { withAnimation(.snappy) { expanded.toggle() } } }
        .accessibilityElement(children: .combine)
        .accessibilityHint(c.hasDetails ? (expanded ? "Collapses the message" : "Expands the message") : "")
    }
}

/// What this employee is waiting on you for: each item with what approve and deny do, and its options.
struct NeedsYouSection: View {
    @Environment(AppModel.self) private var model
    let items: [InboxItem]
    let name: String
    /// Collapsed by default when the list would push the conversation off the screen.
    @State private var collapsed: Bool
    init(items: [InboxItem], name: String) {
        self.items = items; self.name = name
        _collapsed = State(initialValue: items.count > 2)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.snappy) { collapsed.toggle() } } label: {
                HStack {
                    Label("Needs you · \(items.count)", systemImage: "exclamationmark.circle.fill").font(.subheadline.weight(.semibold)).foregroundStyle(.orange)
                    Spacer()
                    Image(systemName: collapsed ? "chevron.down" : "chevron.up").font(.caption).foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
            if !collapsed {
                ForEach(items) { item in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            StateLabel(glyph: item.kind.glyph, compact: true)
                            Spacer()
                            Button("Open") { model.router.openInbox(item.id) }.font(.caption)
                        }
                        Text(item.title).font(.subheadline.weight(.semibold))
                        if let a = item.onApprove, !a.isEmpty { Label(a, systemImage: "checkmark.circle").font(.caption).foregroundStyle(.secondary) }
                        if let d = item.onDeny, !d.isEmpty { Label(d, systemImage: "xmark.circle").font(.caption).foregroundStyle(.secondary) }
                        AnswerOptions(item: item, compact: true)
                    }
                    .padding(10)
                    .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.orange.opacity(0.4)))
                }
            }
        }
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
            catch { onError(error.localizedDescription) }
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
        do { charter = try await rest.charter(summary.id); error = nil } catch { self.error = error.localizedDescription }
    }
}
