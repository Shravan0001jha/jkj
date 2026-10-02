import SwiftUI

/// The v1 Features board, pivot and requests: opened from the Plan's menu as a sheet.
struct FeaturesView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var mode: Mode = .board
    @State private var pivotRows: PivotRows = .charter
    @State private var path: [String] = []

    private enum Mode: String, CaseIterable { case requests = "Requests", board = "Board", pivot = "Pivot" }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                switch mode {
                case .requests: RequestsList()
                case .board: board
                case .pivot: PivotView(rows: $pivotRows)
                }
            }
            .navigationDestination(for: String.self) { id in FeatureDetailView(id: id) }
            .navigationTitle("Features")
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Picker("View", selection: $mode) {
                        ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .frame(maxWidth: 260)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .top, spacing: 0) { ConnectionStrip() }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .task { if model.features.board == nil { await reload() } }
            .onChange(of: model.router.featuresSegment, initial: true) { _, seg in
                if seg == "requests" { mode = .requests; model.router.featuresSegment = nil }
            }
            .onChange(of: model.router.featureId, initial: true) { _, id in
                guard let id else { return }
                mode = .board
                path = [id]
                model.router.featureId = nil
            }
            .onChange(of: model.router.pivot, initial: true) { _, rows in
                guard let rows else { return }
                pivotRows = rows
                mode = .pivot
                model.router.pivot = nil
            }
        }
    }

    private var board: some View {
        List {
            if let e = model.features.error, model.features.board == nil {
                ErrorRow(message: e) { Task { await reload() } }
            }
            if let b = model.features.board, b.features.isEmpty {
                EmptyState(symbol: "square.grid.2x2", title: "No features yet", text: "State a feature on the Mac and the Chief of Staff turns it into work here.")
            }
            ForEach(model.features.byState, id: \.state) { group in
                Section {
                    ForEach(group.features) { f in
                        NavigationLink(value: f.id) { FeatureRow(feature: f) }
                    }
                } header: {
                    HStack {
                        Image(systemName: group.state.glyph.symbol).foregroundStyle(group.state.glyph.tint)
                        SectionHeader(text: group.state.glyph.label)
                        Spacer()
                        Text("\(group.features.count)").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if let e = model.features.error, model.features.board != nil {
                Section { ErrorRow(message: e) { Task { await reload() } } }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await reload() }
    }

    private func reload() async {
        guard let rest = model.rest else { return }
        await model.features.load(rest)
        if let b = model.features.board { model.requests.absorb(b) }
    }
}

struct FeatureRow: View {
    let feature: WorkItem

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(feature.title).font(.subheadline.weight(.medium)).lineLimit(2)
            HStack(spacing: 6) {
                if !feature.platformIds.isEmpty {
                    Pill(text: feature.platformIds.joined(separator: " "), symbol: "square.stack.3d.up", tint: .secondary)
                }
                if !feature.requirementIds.isEmpty {
                    Pill(text: "\(feature.requirementIds.count) req", symbol: "list.bullet.rectangle", tint: .secondary)
                }
                Spacer()
                Text(Format.ago(feature.updatedAt)).font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// The feature with its spec, requirements, assignments (with evidence) and the route through the map.
struct FeatureDetailView: View {
    @Environment(AppModel.self) private var model
    let id: String
    @State private var showAssign = false

    private var detail: FeatureDetail? { model.features.details[id] }
    private var feature: WorkItem? { detail?.feature ?? model.features.board?.features.first { $0.id == id } }

    var body: some View {
        List {
            if let f = feature {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        StateLabel(glyph: f.state.glyph)
                        Text(f.title).font(.title3.weight(.semibold))
                        Prose(text: f.body)
                        HStack {
                            ForEach(f.platformIds, id: \.self) { Pill(text: $0, tint: .secondary) }
                        }
                    }
                    .padding(.vertical, 4)
                }
                if let st = detail?.status ?? model.requests.status(for: f.id) {
                    Section {
                        HStack { Image(systemName: st.stage.glyph.symbol).foregroundStyle(st.stage.glyph.tint); Text(st.stage.glyph.label).font(.subheadline.weight(.semibold)); Spacer(); Text(st.line).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.trailing) }
                        if let a = st.askedAgentId { Button("Asha's session for this") { model.router.talk(to: model.office.data?.chiefOfStaff ?? "asha"); _ = a } .font(.subheadline) }
                    } header: { SectionHeader(text: "Where it stands") }
                }
                if let spec = f.spec, !spec.isEmpty {
                    Section { Prose(text: spec) } header: { SectionHeader(text: "Spec") }
                }
            }
            if let d = detail {
                if !d.assignments.isEmpty {
                    Section {
                        ForEach(d.assignments) { a in AssignmentRow(item: a) }
                    } header: { SectionHeader(text: "Assignments") }
                }
                if !d.requirements.isEmpty {
                    Section {
                        ForEach(d.requirements) { r in
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(alignment: .firstTextBaseline) {
                                    Image(systemName: r.status.glyph.symbol).foregroundStyle(r.status.glyph.tint)
                                    Text(r.title).font(.subheadline)
                                }
                                HStack(spacing: 6) {
                                    Text(r.id).font(.caption.monospaced())
                                    Text("·").foregroundStyle(.secondary)
                                    Text(r.group).font(.caption)
                                    Text("·").foregroundStyle(.secondary)
                                    Text(r.status.glyph.label).font(.caption)
                                    if let c = r.charterId { Text("·"); Text(model.charterTitle(c)).font(.caption) }
                                }
                                .foregroundStyle(.secondary)
                                ForEach(r.evidence, id: \.self) { EvidenceLine(text: $0) }
                            }
                            .padding(.vertical, 2)
                        }
                    } header: { SectionHeader(text: "Requirements") }
                }
                Section {
                    if d.route.primaries.isEmpty {
                        Text("Not routed yet.").foregroundStyle(.secondary)
                    }
                    ForEach(d.route.primaries, id: \.charterId) { hit in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(model.charterTitle(hit.charterId)).font(.subheadline.weight(.medium))
                            Text(hit.because.map { "\($0.kind.rawValue) \($0.key)" }.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if !d.route.consulted.isEmpty {
                        LabeledContent("Consulted", value: d.route.consulted.map { model.charterTitle($0) }.joined(separator: ", "))
                    }
                    if !d.route.unresolved.isEmpty {
                        Label("Unowned: " + d.route.unresolved.map(\.key).joined(separator: ", "), systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange).font(.subheadline)
                    }
                } header: { SectionHeader(text: "Route through the ownership map") }
            } else if let e = model.features.error {
                ErrorRow(message: e) { Task { await load() } }
            } else {
                HStack { Spacer(); ProgressView(); Spacer() }
            }
            if let f = feature, !f.history.isEmpty {
                Section {
                    ForEach(Array(f.history.enumerated()), id: \.offset) { _, h in
                        HStack(alignment: .top) {
                            Image(systemName: h.to.glyph.symbol).foregroundStyle(h.to.glyph.tint)
                            VStack(alignment: .leading, spacing: 1) {
                                Text("\(h.to.glyph.label) · \(model.employeeName(h.by))").font(.caption)
                                if let n = h.note { Text(n).font(.caption).foregroundStyle(.secondary) }
                            }
                            Spacer()
                            Text(Format.ago(h.at)).font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                } header: { SectionHeader(text: "History") }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Feature")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showAssign = true } label: { Label("Assign", systemImage: "tray.and.arrow.down") }
            }
        }
        .sheet(isPresented: $showAssign) { AssignView(featureId: id) }
        .refreshable { await load() }
        .task { if detail == nil { await load() } }
    }

    private func load() async {
        guard let rest = model.rest else { return }
        await model.features.loadDetail(rest, id: id)
    }
}

struct AssignmentRow: View {
    @Environment(AppModel.self) private var model
    let item: WorkItem
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            if let p = item.plan, !p.isEmpty {
                Prose(text: p).padding(.vertical, 4)
            }
            if let e = item.evidence {
                EvidenceView(evidence: e)
            } else {
                Text("No evidence attached yet.").font(.caption).foregroundStyle(.secondary)
            }
            if let v = item.verifiedBy {
                Label("Verified by \(model.employeeName(v))", systemImage: "checkmark.seal").font(.caption).foregroundStyle(.green)
            }
            if let last = item.history.last, let n = last.note {
                Label(n, systemImage: "text.quote").font(.caption).foregroundStyle(.secondary)
            }
        } label: {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: item.state.glyph.symbol).foregroundStyle(item.state.glyph.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title).font(.subheadline)
                    HStack(spacing: 6) {
                        Text(item.state.glyph.label)
                        Text("·")
                        Text(model.employeeName(item.employeeId))
                        if let c = item.charterId { Text("·"); Text(model.charterTitle(c)) }
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// Tests, commits, live-verified, not verified, notes. Anything that is a URL is a link.
struct EvidenceView: View {
    let evidence: Evidence

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: evidence.tests.failed == 0 ? "checkmark.circle.fill" : "xmark.octagon.fill")
                    .foregroundStyle(evidence.tests.failed == 0 ? .green : .red)
                Text("\(evidence.tests.passed) passed, \(evidence.tests.failed) failed").font(.subheadline)
                if let c = evidence.tests.command { Text(c).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1) }
            }
            block("Commits", evidence.commits, symbol: "arrow.triangle.merge", mono: true)
            block("Live verified", evidence.liveVerified, symbol: "checkmark.seal", tint: .green)
            block("Not verified", evidence.notVerified, symbol: "questionmark.circle", tint: .orange)
            if let n = evidence.notes, !n.isEmpty {
                EvidenceLine(text: n)
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder private func block(_ title: String, _ items: [String], symbol: String, tint: Color = .secondary, mono: Bool = false) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Label(title, systemImage: symbol).font(.caption.weight(.semibold)).foregroundStyle(tint)
                ForEach(items, id: \.self) { s in
                    if mono { Text(s).font(.caption.monospaced()).lineLimit(2) } else { EvidenceLine(text: s) }
                }
            }
        }
    }
}

/// The progress pivot: rows by charter / platform / team, columns per feature, a cell per state.
struct PivotView: View {
    @Environment(AppModel.self) private var model
    @Binding var rows: PivotRows

    var body: some View {
        VStack(spacing: 0) {
            Picker("Rows", selection: $rows) {
                Text("By charter").tag(PivotRows.charter)
                Text("By platform").tag(PivotRows.platform)
                Text("By team").tag(PivotRows.team)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16).padding(.vertical, 8)
            if let p = model.features.pivots[rows] {
                if p.rows.isEmpty || p.cols.isEmpty {
                    EmptyState(symbol: "tablecells", title: "Nothing to pivot", text: "Assignments appear here once a feature is decomposed.")
                } else {
                    PivotGrid(pivot: p, rowTitle: rowTitle)
                }
            } else if let e = model.features.error {
                ErrorRow(message: e) { Task { await load() } }.padding()
                Spacer()
            } else {
                ProgressView().padding()
                Spacer()
            }
        }
        .task(id: rows) { await load() }
        .refreshable { await load() }
    }

    private func rowTitle(_ id: String) -> String {
        switch rows {
        case .charter: return model.charterTitle(id)
        case .team: return model.office.data?.units.first { $0.unit.id == id }?.unit.title ?? id
        case .platform: return id
        }
    }

    private func load() async {
        guard let rest = model.rest else { return }
        await model.features.loadPivot(rest, rows: rows)
    }
}

struct PivotGrid: View {
    @Environment(AppModel.self) private var model
    let pivot: Pivot
    let rowTitle: (String) -> String

    private let cellWidth: CGFloat = 96
    private let rowWidth: CGFloat = 120
    @State private var selected: PivotSelection?

    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    Text("").frame(width: rowWidth)
                    ForEach(pivot.cols, id: \.self) { col in
                        Text(featureTitle(col)).font(.caption.weight(.semibold)).lineLimit(3).multilineTextAlignment(.leading)
                            .frame(width: cellWidth, alignment: .leading).padding(6)
                    }
                }
                Divider()
                ForEach(pivot.rows, id: \.self) { row in
                    GridRow {
                        Text(rowTitle(row)).font(.subheadline.weight(.medium)).lineLimit(2)
                            .frame(width: rowWidth, alignment: .leading).padding(6)
                        ForEach(pivot.cols, id: \.self) { col in
                            Button { if let c = pivot.cells[row]?[col], !c.items.isEmpty { selected = PivotSelection(row: rowTitle(row), col: featureTitle(col), cell: c) } } label: {
                                PivotCellView(cell: pivot.cells[row]?[col]).frame(width: cellWidth).padding(6)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    Divider()
                }
            }
            .padding(.horizontal, 10)
        }
        .sheet(item: $selected) { sel in PivotItemsView(selection: sel) }
    }

    private func featureTitle(_ id: String) -> String {
        model.features.board?.features.first { $0.id == id }?.title ?? id
    }
}

/// A cell: the total, and one glyph per state with its count. Empty cells stay empty.
struct PivotCellView: View {
    let cell: PivotCell?

    var body: some View {
        if let cell, cell.total > 0 {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(cell.total)").font(.headline.monospacedDigit())
                ForEach(cell.byState.keys.sorted(), id: \.self) { key in
                    let g = WorkState(rawValue: key)?.glyph ?? Glyph(symbol: "circle", tint: .secondary, label: key)
                    HStack(spacing: 3) {
                        Image(systemName: g.symbol).foregroundStyle(g.tint)
                        Text("\(cell.byState[key]!) \(g.label.lowercased())")
                    }
                    .font(.caption2)
                }
            }
            .accessibilityElement(children: .combine)
        } else {
            Text("—").foregroundStyle(.quaternary).accessibilityLabel("none")
        }
    }
}


struct PivotSelection: Identifiable {
    let row: String
    let col: String
    let cell: PivotCell
    var id: String { row + "|" + col }
}

/// The assignments behind one pivot cell, with their evidence and a link to the assignee's page.
struct PivotItemsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let selection: PivotSelection

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(selection.cell.items) { it in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(alignment: .top, spacing: 8) {
                                Image(systemName: it.state.glyph.symbol).foregroundStyle(it.state.glyph.tint)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(it.title).font(.subheadline)
                                    Text("\(it.state.glyph.label) · \(model.employeeName(it.employeeId))").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            if let e = it.evidence {
                                HStack(spacing: 8) {
                                    Pill(text: e.tests, symbol: "checkmark.circle", tint: e.tests.contains(", 0 failed") ? .green : .red)
                                    Pill(text: "\(e.commits.count) commits", symbol: "arrow.triangle.merge", tint: .secondary)
                                    Pill(text: "\(e.liveVerified) live", symbol: "checkmark.seal", tint: .green)
                                    if e.notVerified > 0 { Pill(text: "\(e.notVerified) not verified", symbol: "questionmark.circle", tint: .orange) }
                                }
                                .font(.caption2)
                                ForEach(e.commits, id: \.self) { Text($0).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1) }
                            } else {
                                Text("No evidence yet").font(.caption).foregroundStyle(.secondary)
                            }
                            if let emp = it.employeeId {
                                Button("Open \(model.employeeName(emp))'s page") { dismiss(); model.router.talk(to: emp) }.font(.caption)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                } header: { SectionHeader(text: "\(selection.row) × \(selection.col)") }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("\(selection.cell.total) item\(selection.cell.total == 1 ? "" : "s")")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
