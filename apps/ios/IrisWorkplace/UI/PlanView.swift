import SwiftUI

/// Home (v2): what is assigned to the owner on top, then each area with its epics as cards, or
/// a board by state. From here the owner creates an epic or story, reorders epics, reassigns
/// anything to anyone (himself too) and sets the focus.
struct PlanView: View {
    @Environment(AppModel.self) private var model
    @State private var path = NavigationPath()
    @State private var editMode: EditMode = .inactive
    @State private var creating: NewItemView.Draft?
    @State private var actionError: String?
    @State private var showDone = false
    /// The Plan's collapsed "Done (N)" section of finished epics.
    @State private var showFinished = false
    @State private var query = PlanQuery()

    private var store: PlanStore { model.plan }

    var body: some View {
        @Bindable var router = model.router
        NavigationStack(path: $path) {
            Group {
                if query.showsFlatResults { resultsList } else if router.planBoard { boardList } else { areasList }
            }
            .listStyle(.insetGrouped)
            .searchable(text: $query.text, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search epics, stories, tasks")
            .onChange(of: query.showsFlatResults) { _, flat in
                // Stories and tasks live on the board: fetch it the first time a search needs them.
                if flat, store.board == nil, let rest = model.rest { Task { await store.loadBoard(rest) } }
            }
            .refreshable { await reload() }
            .navigationTitle("Plan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .environment(\.editMode, $editMode)
            .v2Destinations()
            .safeAreaInset(edge: .top, spacing: 0) { ConnectionStrip() }
            .task { if !store.loaded { await reload() } }
            .onChange(of: router.planBoard, initial: true) { _, board in
                if board, store.board == nil, let rest = model.rest { Task { await store.loadBoard(rest) } }
            }
            .onChange(of: router.itemId, initial: true) { _, id in
                guard let id else { return }
                path = NavigationPath([ItemRoute(id: id)])
                router.itemId = nil
            }
            .sheet(item: $creating) { draft in
                NewItemView(draft: draft) { id in path.append(ItemRoute(id: id)) }
            }
            .alert("Couldn't do that", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(actionError ?? "") }
        }
    }

    // MARK: areas

    private var areasList: some View {
        List {
            if let e = store.error, store.plan == nil {
                ErrorRow(message: e) { Task { await reload() } }
            } else if store.plan == nil {
                HStack { Spacer(); ProgressView("Loading the plan…"); Spacer() }
            }
            if let plan = store.plan {
                Section {
                    if plan.mine.isEmpty {
                        Label("Nothing is assigned to you", systemImage: "checkmark.circle").font(.subheadline).foregroundStyle(.secondary)
                    }
                    ForEach(plan.mine) { item in
                        NavigationLink(value: ItemRoute(id: item.id)) { ItemRow(item: item, showEpic: true) }
                    }
                } header: {
                    HStack { Label("Assigned to you", systemImage: "person.crop.circle.fill"); Spacer(); if !plan.mine.isEmpty { Text("\(plan.mine.count)") } }
                        .font(.subheadline.weight(.semibold)).foregroundStyle(Color.accentColor).textCase(nil)
                }
                .accessibilityIdentifier("plan.mine")

                if query.isFiltering || query.sort != .plan {
                    Section { activeFilters }
                }
                ForEach(plan.areas) { a in
                    let shown = query.openEpics(a.epics)
                    Section {
                        if a.epics.isEmpty {
                            Button { creating = .init(level: .epic, areaId: a.area.id) } label: {
                                Label("No epics yet — add one", systemImage: "plus.circle").font(.subheadline)
                            }
                        }
                        else if shown.isEmpty {
                            Text(a.epics.allSatisfy(\.isFinished) ? "Every epic here is done" : "No epics match the filter").font(.caption).foregroundStyle(.tertiary)
                        }
                        ForEach(shown) { card in epicRow(card) }
                            .onMove(perform: query.allowsReorder ? { from, to in
                                guard let rest = model.rest else { return }
                                Task { do { try await store.move(rest, areaId: a.area.id, shown: shown, from: from, to: to) } catch { if let m = error.userMessage { actionError = m } } }
                            } : nil)
                    } header: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(a.area.title).font(.title3.weight(.bold)).foregroundStyle(.primary).textCase(nil)
                            if let d = a.area.description, !d.isEmpty { Text(d).font(.caption).foregroundStyle(.secondary).textCase(nil).lineLimit(1) }
                        }
                    }
                }
                if !query.openEpics(plan.unfiled).isEmpty {
                    Section {
                        ForEach(query.openEpics(plan.unfiled)) { card in epicRow(card) }
                    } header: { SectionHeader(text: "No area yet") }
                }
                let finished = query.finishedEpics(plan)
                if !finished.isEmpty {
                    Section {
                        Button { withAnimation(.snappy) { showFinished.toggle() } } label: {
                            HStack {
                                Image(systemName: ItemStatus.done.glyph.symbol).foregroundStyle(ItemStatus.done.glyph.tint)
                                Text("Done (\(finished.count))").font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                                Spacer()
                                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                                    .rotationEffect(.degrees(showFinished ? 90 : 0))
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Done, \(finished.count) finished epics")
                        .accessibilityHint(showFinished ? "Collapses" : "Expands")
                        .accessibilityIdentifier("plan.done")
                        if showFinished || query.status == .done {
                            ForEach(finished) { card in epicRow(card) }
                        }
                    } footer: { if !showFinished { Text("Finished epics, out of the way.") } }
                }
                Section {
                    HStack(spacing: 14) {
                        ForEach(ItemStatus.order.filter { !ItemStatus.rework.contains($0) || plan.counts[$0.rawValue] != nil }, id: \.self) { s in
                            VStack(spacing: 2) {
                                Image(systemName: s.glyph.symbol).foregroundStyle(s.glyph.tint)
                                Text("\(plan.counts[s.rawValue] ?? 0)").font(.caption.monospacedDigit().weight(.semibold))
                            }
                            .accessibilityElement(children: .combine)
                            .accessibilityLabel("\(plan.counts[s.rawValue] ?? 0) \(s.glyph.label)")
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                    .onTapGesture { model.router.planBoard = true }
                } header: { SectionHeader(text: "Stories and tasks by state") }
            }
            if let e = store.error, store.plan != nil {
                Section { ErrorRow(message: e) { Task { await reload() } } }
            }
        }
    }

    private func epicRow(_ card: EpicCard) -> some View {
        NavigationLink(value: ItemRoute(id: card.epic.id)) { EpicCardView(card: card) }
            .contextMenu {
                Button { toggleFocus(card) } label: {
                    Label(card.inFocus ? "Remove from focus" : "Set as focus", systemImage: "scope")
                }
                PersonMenu(title: "Owner", current: card.epic.ownerId) { who in
                    update(card.epic.id, UpdateItemRequest(ownerId: who ?? "owner"))
                } label: { Label("Reassign owner", systemImage: "person.crop.circle") }
                Button { creating = .init(level: .story, parentId: card.epic.id) } label: { Label("Add a story", systemImage: "plus") }
                if query.allowsReorder {
                    Button { editMode = .active } label: { Label("Reorder epics", systemImage: "arrow.up.arrow.down") }
                }
            }
            .swipeActions(edge: .leading) {
                Button { toggleFocus(card) } label: { Label(card.inFocus ? "Unfocus" : "Focus", systemImage: "scope") }.tint(.orange)
            }
    }

    // MARK: board

    private var boardList: some View {
        List {
            if store.board == nil {
                if let e = store.error { ErrorRow(message: e) { Task { await reload() } } }
                else { HStack { Spacer(); ProgressView("Loading the board…"); Spacer() } }
            }
            if query.isFiltering || query.sort != .plan { Section { activeFilters } }
            ForEach(boardColumns, id: \.status) { col in
                Section {
                    if col.status == .done && !showDone && query.status != .done {
                        Button("Show \(col.items.count) done") { showDone = true }.font(.subheadline)
                    } else {
                        if col.items.isEmpty { Text("None").font(.caption).foregroundStyle(.tertiary) }
                        ForEach(col.items) { item in
                            NavigationLink(value: ItemRoute(id: item.id)) { ItemRow(item: item, showEpic: true) }
                        }
                    }
                } header: {
                    HStack {
                        Image(systemName: col.status.glyph.symbol).foregroundStyle(col.status.glyph.tint)
                        SectionHeader(text: col.status.glyph.label)
                        Spacer()
                        Text("\(col.items.count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    /// The board's columns after the filter: a status filter hides the columns it excludes.
    private var boardColumns: [(status: ItemStatus, items: [Item])] {
        store.columns.compactMap { col in
            switch query.status {
            case .open where col.status == .done: return nil
            case .done where col.status != .done: return nil
            default: return (col.status, query.column(col.items))
            }
        }
    }

    // MARK: results (a search, or a story/task level filter)

    private var resultsList: some View {
        let results = query.results(plan: store.plan, board: store.board)
        return List {
            if query.isFiltering || query.sort != .plan { Section { activeFilters } }
            Section {
                if results.isEmpty {
                    if store.board == nil && store.error == nil {
                        HStack { Spacer(); ProgressView("Searching…"); Spacer() }
                    } else {
                        Text(query.trimmedText.isEmpty ? "Nothing matches the filter" : "No results for “\(query.trimmedText)”")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                ForEach(results) { item in
                    NavigationLink(value: ItemRoute(id: item.id)) {
                        if item.level == .epic, let card = store.epic(item.id) { EpicCardView(card: card) } else { ItemRow(item: item, showEpic: true) }
                    }
                    .accessibilityIdentifier("plan.result.\(item.id)")
                }
            } header: {
                SectionHeader(text: "\(results.count) result\(results.count == 1 ? "" : "s")")
            }
        }
    }

    // MARK: filter

    /// One line naming what is narrowing the plan, with a Clear.
    private var activeFilters: some View {
        HStack(spacing: 6) {
            Image(systemName: "line.3.horizontal.decrease.circle.fill").foregroundStyle(Color.accentColor)
            Text(filterSummary).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            Spacer()
            Button("Clear") { withAnimation(.snappy) { let t = query.text; query = PlanQuery(); query.text = t } }
                .font(.caption.weight(.semibold)).buttonStyle(.borderless)
                .accessibilityIdentifier("plan.filter.clear")
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("plan.filter.summary")
    }

    private var filterSummary: String {
        var parts: [String] = []
        if query.status != .all { parts.append(query.status.label) }
        if let l = query.level { parts.append(l.label + "s") }
        if let p = query.personId { parts.append(model.employeeName(p)) }
        if query.sort != .plan { parts.append("by " + query.sort.label.lowercased()) }
        return parts.joined(separator: " · ")
    }

    private var filterMenu: some View {
        Menu {
            Picker("Status", selection: $query.status) {
                ForEach(PlanQuery.StatusFilter.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.inline)
            Menu {
                Picker("Level", selection: $query.level) {
                    Text("Every level").tag(ItemLevel?.none)
                    ForEach([ItemLevel.epic, .story, .task], id: \.self) { l in Text(l.label + "s").tag(Optional(l)) }
                }
            } label: { Label("Level: " + (query.level.map { $0.label + "s" } ?? "all"), systemImage: "square.stack.3d.up") }
            Menu {
                Picker("Owner", selection: $query.personId) {
                    Text("Anyone").tag(String?.none)
                    ForEach(model.assignees, id: \.id) { p in Text(p.name).tag(Optional(p.id)) }
                }
            } label: { Label("Owner: " + (query.personId.map { model.employeeName($0) } ?? "anyone"), systemImage: "person.crop.circle") }
            Menu {
                Picker("Sort", selection: $query.sort) {
                    ForEach(PlanQuery.Sort.allCases) { Text($0.label).tag($0) }
                }
            } label: { Label("Sort: " + query.sort.label, systemImage: "arrow.up.arrow.down") }
            if query.isFiltering || query.sort != .plan {
                Button(role: .destructive) { let t = query.text; query = PlanQuery(); query.text = t } label: { Label("Clear filter", systemImage: "xmark.circle") }
            }
        } label: {
            Image(systemName: query.isFiltering || query.sort != .plan ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
        }
        .accessibilityLabel("Filter and sort")
        .accessibilityIdentifier("plan.filter")
    }

    // MARK: toolbar

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Menu {
                Button { model.router.showOffice = true } label: { Label("Office", systemImage: "building.2") }
                Button { model.router.showAlerts = true } label: { Label(model.alerts.unread > 0 ? "Alerts (\(model.alerts.unread))" : "Alerts", systemImage: "bell") }
                Button { model.router.showNewRequest = true } label: { Label("New request to Asha", systemImage: "text.bubble") }
                Button { model.router.showSpend = true } label: { Label("Spend", systemImage: "indianrupeesign.circle") }
                Button { model.router.showReleases = true } label: { Label("Ship a release", systemImage: "shippingbox") }
                Button { model.router.showFeatures = true } label: { Label("Features (v1)", systemImage: "square.grid.2x2") }
                Button { model.router.showSettings = true } label: { Label("Settings", systemImage: "gearshape") }
            } label: { Image(systemName: model.alerts.unread > 0 ? "line.3.horizontal.circle.fill" : "line.3.horizontal.circle") }
            .accessibilityLabel("More")
        }
        ToolbarItem(placement: .principal) {
            Picker("View", selection: Bindable(model.router).planBoard) {
                Text("Areas").tag(false)
                Text("Board").tag(true)
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 200)
        }
        ToolbarItem(placement: .topBarTrailing) {
            if !editMode.isEditing { filterMenu }
        }
        ToolbarItem(placement: .topBarTrailing) {
            if editMode.isEditing {
                Button("Done") { editMode = .inactive }
            } else {
                Menu {
                    Button { creating = .init(level: .epic, areaId: store.plan?.areas.first?.area.id) } label: { Label("New epic", systemImage: "flag") }
                    Button { creating = .init(level: .story, parentId: store.plan?.focus.epicIds.first) } label: { Label("New story", systemImage: "doc.badge.plus") }
                    if !model.router.planBoard && query.allowsReorder {
                        Button { editMode = .active } label: { Label("Reorder epics", systemImage: "arrow.up.arrow.down") }
                    }
                } label: { Image(systemName: "plus.circle.fill") }
                .accessibilityLabel("New")
            }
        }
    }

    // MARK: actions

    private func reload() async {
        guard let rest = model.rest else { return }
        await store.load(rest)
        if model.router.planBoard { await store.loadBoard(rest) }
        if model.office.data == nil { await model.office.load(rest) }
    }

    private func toggleFocus(_ card: EpicCard) {
        guard let rest = model.rest else { return }
        Task { do { try await store.setFocus(rest, epicId: card.epic.id, on: !card.inFocus) } catch { if let m = error.userMessage { actionError = m } } }
    }

    private func update(_ id: String, _ req: UpdateItemRequest) {
        guard let rest = model.rest else { return }
        Task {
            do { try await model.items.update(rest, id: id, req); await store.load(rest) }
            catch { if let m = error.userMessage { actionError = m } }
        }
    }
}

/// Create an epic (in an area, with an owner) or a story/task (under a parent, with an assignee
/// and points). The new item opens once the server has made it.
struct NewItemView: View {
    struct Draft: Identifiable {
        let id = UUID()
        var level: ItemLevel
        var areaId: String? = nil
        var parentId: String? = nil
    }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let onCreated: (String) -> Void
    @State private var level: ItemLevel
    @State private var title = ""
    @State private var text = ""
    @State private var acceptance = ""
    @State private var areaId: String?
    @State private var parentId: String?
    @State private var assigneeId: String?
    @State private var points: Int?
    @State private var busy = false
    @State private var error: String?

    init(draft: Draft, onCreated: @escaping (String) -> Void) {
        self.onCreated = onCreated
        _level = State(initialValue: draft.level)
        _areaId = State(initialValue: draft.areaId)
        _parentId = State(initialValue: draft.parentId)
    }

    private var epics: [EpicCard] { model.plan.plan.map { $0.areas.flatMap(\.epics) + $0.unfiled } ?? [] }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Kind", selection: $level) {
                        Text("Epic").tag(ItemLevel.epic)
                        Text("Story").tag(ItemLevel.story)
                        Text("Task").tag(ItemLevel.task)
                    }
                    .pickerStyle(.segmented)
                    TextField(level == .epic ? "The outcome, e.g. Iris works while music plays" : "One shippable change", text: $title, axis: .vertical)
                        .lineLimit(1...3)
                        .accessibilityIdentifier("newItem.title")
                    TextField("Description (optional)", text: $text, axis: .vertical).lineLimit(2...6)
                }
                if level == .epic {
                    Section {
                        Picker("Area", selection: $areaId) {
                            Text("No area yet").tag(String?.none)
                            ForEach(model.plan.plan?.areas ?? []) { a in Text(a.area.title).tag(Optional(a.area.id)) }
                        }
                        Picker("Owner", selection: $assigneeId) {
                            Text("Asha (default)").tag(String?.none)
                            ForEach(model.assignees, id: \.id) { p in Text(p.name).tag(Optional(p.id)) }
                        }
                    }
                } else {
                    Section {
                        Picker(level == .task ? "Story" : "Epic", selection: $parentId) {
                            Text("Choose…").tag(String?.none)
                            if level == .story {
                                ForEach(epics) { c in Text(c.epic.title).lineLimit(1).tag(Optional(c.epic.id)) }
                            } else {
                                ForEach(stories) { s in Text(s.title).lineLimit(1).tag(Optional(s.id)) }
                            }
                        }
                        Picker("Assignee", selection: $assigneeId) {
                            Text("Unassigned").tag(String?.none)
                            ForEach(model.assignees, id: \.id) { p in Text(p.name).tag(Optional(p.id)) }
                        }
                        Picker("Points", selection: $points) {
                            Text("Not yet").tag(Int?.none)
                            ForEach(Points.allCases, id: \.self) { p in Text("\(p.rawValue)").tag(Optional(p.rawValue)) }
                        }
                    }
                    Section {
                        TextField("One per line", text: $acceptance, axis: .vertical).lineLimit(2...6)
                    } header: { SectionHeader(text: "Acceptance criteria") }
                }
                if let error { Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red) } }
            }
            .navigationTitle("New \(level.label.lowercased())")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Creating…" : "Create") { Task { await create() } }
                        .disabled(busy || title.trimmingCharacters(in: .whitespaces).isEmpty || (level != .epic && parentId == nil))
                }
            }
        }
    }

    /// Stories a task can go under: those of the loaded board, else of the focus epic's page.
    private var stories: [Item] {
        let fromBoard = (model.plan.board ?? [:]).values.flatMap { $0 }.filter { $0.level == .story && $0.status != .done }
        if !fromBoard.isEmpty { return fromBoard.sorted { $0.title < $1.title } }
        return model.items.details.values.flatMap(\.children).filter { $0.level == .story && $0.status != .done }
    }

    private func create() async {
        guard let rest = model.rest else { return }
        busy = true; error = nil
        defer { busy = false }
        let criteria = acceptance.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        var req = CreateItemRequest(level: level, title: title.trimmingCharacters(in: .whitespacesAndNewlines))
        if !text.isEmpty { req.body = text }
        if level == .epic {
            req.areaId = areaId
            req.ownerId = assigneeId
        } else {
            req.parentId = parentId
            req.assigneeId = assigneeId
            req.points = points
            if !criteria.isEmpty { req.acceptance = criteria }
        }
        do {
            let d = try await model.items.create(rest, req)
            await model.plan.load(rest)
            dismiss()
            onCreated(d.item.id)
        } catch {
            if let m = error.userMessage { self.error = m }
        }
    }
}
