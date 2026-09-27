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
                model.router.talkEmployeeId = nil
                Task { await model.talk.select(rest, employeeId: id) }
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
        .navigationTitle("Talk")
        .task { if model.office.data == nil, let r = model.rest { await model.office.load(r) } }
    }
}

struct ConversationView: View {
    @Environment(AppModel.self) private var model
    @State private var draft = ""
    @State private var error: String?
    @State private var showProfile = false
    @State private var confirmEnd = false
    @FocusState private var composing: Bool

    private var talk: TalkStore { model.talk }
    private var name: String { talk.detail?.employee.name ?? model.employeeName(talk.employeeId) }

    var body: some View {
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
                        ForEach(talk.log) { entry in
                            LogRow(entry: entry).id(entry.id)
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
                .onChange(of: talk.pendingApproval) { _, a in if a != nil { withAnimation { proxy.scrollTo("approval") } } }
                .onAppear { proxy.scrollTo("bottom") }
            }
            composer
        }
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { model.talk.deselect() } label: { Label("Employees", systemImage: "person.2") }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { showProfile = true } label: { Label("Charter and status", systemImage: "doc.text") }
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
        .sheet(isPresented: $showProfile) { EmployeeProfileView() }
        .confirmationDialog("End \(name)'s session?", isPresented: $confirmEnd, titleVisibility: .visible) {
            Button("End and write handoff", role: .destructive) {
                Task { do { if let r = model.rest { try await model.talk.endSession(r) } } catch { self.error = error.localizedDescription } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The employee writes status and handoff, then the session closes. The next message starts a fresh one from the files.")
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

struct LogRow: View {
    let entry: LogEntry

    var body: some View {
        switch entry.kind {
        case .user:
            HStack {
                Spacer(minLength: 48)
                Text(entry.text)
                    .padding(10)
                    .background(Color.accentColor.opacity(0.18), in: RoundedRectangle(cornerRadius: 14))
                    .textSelection(.enabled)
            }
            .padding(.horizontal, 12)
        case .assistant:
            CompactRow(text: entry.text).padding(.horizontal, 16)
        case .error:
            Label(entry.text, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.subheadline).padding(.horizontal, 16)
        case .system:
            Text(entry.text).font(.caption).italic().foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.horizontal, 16)
        case .image:
            Label("Image", systemImage: "photo").font(.caption).foregroundStyle(.secondary).padding(.horizontal, 16)
        case .read, .edit, .bash, .search, .task, .tool:
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: symbol).foregroundStyle(.secondary).frame(width: 18)
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.label.isEmpty ? entry.kind.rawValue : entry.label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Text(entry.text).font(.caption.monospaced()).lineLimit(4).textSelection(.enabled)
                }
                Spacer()
                Text(Format.time(entry.at)).font(.caption2).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 16)
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

/// An assistant message: one line by default, the whole text on tap.
struct CompactRow: View {
    let text: String
    @State private var expanded = false

    var body: some View {
        let c = CompactText(text: text)
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 6) {
                if expanded {
                    Prose(text: text)
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
    @State private var collapsed = false

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
