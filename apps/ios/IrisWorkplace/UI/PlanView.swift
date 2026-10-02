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

    private var store: PlanStore { model.plan }

    var body: some View {
        @Bindable var router = model.router
        NavigationStack(path: $path) {
            Group {
                if router.planBoard { boardList } else { areasList }
            }
            .listStyle(.insetGrouped)
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

                ForEach(plan.areas) { a in
                    Section {
                        if a.epics.isEmpty {
                            Button { creating = .init(level: .epic, areaId: a.area.id) } label: {
                                Label("No epics yet — add one", systemImage: "plus.circle").font(.subheadline)
                            }
                        }
                        ForEach(a.epics) { card in epicRow(card) }
                            .onMove { from, to in
                                guard let rest = model.rest else { return }
                                Task { do { try await store.move(rest, areaId: a.area.id, from: from, to: to) } catch { if let m = error.userMessage { actionError = m } } }
                            }
                    } header: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(a.area.title).font(.title3.weight(.bold)).foregroundStyle(.primary).textCase(nil)
                            if let d = a.area.description, !d.isEmpty { Text(d).font(.caption).foregroundStyle(.secondary).textCase(nil).lineLimit(1) }
                        }
                    }
                }
                if !plan.unfiled.isEmpty {
                    Section {
                        ForEach(plan.unfiled) { card in epicRow(card) }
                    } header: { SectionHeader(text: "No area yet") }
                }
                Section {
                    HStack(spacing: 14) {
                        ForEach(ItemStatus.order, id: \.self) { s in
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
                Button { editMode = .active } label: { Label("Reorder epics", systemImage: "arrow.up.arrow.down") }
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
            ForEach(store.columns, id: \.status) { col in
                Section {
                    if col.status == .done && !showDone {
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
            if editMode.isEditing {
                Button("Done") { editMode = .inactive }
            } else {
                Menu {
                    Button { creating = .init(level: .epic, areaId: store.plan?.areas.first?.area.id) } label: { Label("New epic", systemImage: "flag") }
                    Button { creating = .init(level: .story, parentId: store.plan?.focus.epicIds.first) } label: { Label("New story", systemImage: "doc.badge.plus") }
                    if !model.router.planBoard {
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
