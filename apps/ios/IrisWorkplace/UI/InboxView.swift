import SwiftUI

struct InboxView: View {
    @Environment(AppModel.self) private var model
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if let error = model.inbox.error, !model.inbox.loaded {
                    ErrorRow(message: error) { Task { await reload() } }
                }
                if model.inbox.loaded && model.inbox.items.isEmpty {
                    EmptyState(symbol: "tray", title: "Nothing waiting",
                               text: "Approvals, decisions and questions from the employees arrive here.")
                }
                if !model.inbox.open.isEmpty {
                    Section {
                        ForEach(model.inbox.open) { item in
                            NavigationLink(value: item.id) { InboxRow(item: item) }
                        }
                    } header: { SectionHeader(text: "Needs you") }
                } else if model.inbox.loaded && !model.inbox.items.isEmpty {
                    Section { Label("No open items", systemImage: "checkmark.circle").foregroundStyle(.secondary) }
                }
                if !model.inbox.closed.isEmpty {
                    Section {
                        ForEach(model.inbox.closed) { item in
                            NavigationLink(value: item.id) { InboxRow(item: item) }
                        }
                    } header: { SectionHeader(text: "Answered") }
                }
                if let error = model.inbox.error, model.inbox.loaded {
                    Section { ErrorRow(message: error) { Task { await reload() } } }
                }
            }
            .listStyle(.insetGrouped)
            .refreshable { await reload() }
            .navigationTitle("Inbox")
            .navigationDestination(for: String.self) { id in InboxItemView(id: id) }
            .safeAreaInset(edge: .top, spacing: 0) { ConnectionStrip() }
            .task { if !model.inbox.loaded { await reload() } }
            .onChange(of: model.router.inboxItemId, initial: true) { _, id in
                guard let id else { return }
                path = [id]
                model.router.inboxItemId = nil
            }
        }
    }

    private func reload() async {
        guard let rest = model.rest else { return }
        await model.inbox.load(rest)
    }
}

struct InboxRow: View {
    @Environment(AppModel.self) private var model
    let item: InboxItem

    var body: some View {
        let g = item.kind.glyph
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: g.symbol).foregroundStyle(g.tint).font(.title3).frame(width: 26)
                .accessibilityLabel(g.label)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title).font(.subheadline.weight(item.state == .open ? .semibold : .regular)).lineLimit(2)
                HStack(spacing: 6) {
                    Text(g.label)
                    Text("·")
                    Text(model.employeeName(item.raisedBy))
                    Text("·")
                    Text(Format.ago(item.createdAt))
                }
                .font(.caption).foregroundStyle(.secondary)
                if let a = item.answer, let opt = item.options.first(where: { $0.id == a.optionId }) {
                    Label("\(opt.label) · via \(a.via.rawValue)", systemImage: "checkmark").font(.caption).foregroundStyle(.secondary)
                } else if item.state == .expired {
                    Label("Expired", systemImage: "clock.badge.xmark").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

/// The item with its context and one button per option. `danger` confirms; `needsNote` asks for a note.
struct InboxItemView: View {
    @Environment(AppModel.self) private var model
    let id: String
    @State private var confirming: InboxOption?
    @State private var noting: InboxOption?
    @State private var note = ""
    @State private var error: String?

    private var item: InboxItem? { model.inbox.item(id) }

    var body: some View {
        Group {
            if let item {
                List {
                    Section {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                StateLabel(glyph: item.kind.glyph)
                                Spacer()
                                Text("\(model.employeeName(item.raisedBy)) · \(Format.ago(item.createdAt))").font(.caption).foregroundStyle(.secondary)
                            }
                            Text(item.title).font(.title3.weight(.semibold))
                            Prose(text: item.body)
                        }
                        .padding(.vertical, 4)
                    }
                    if !item.context.isEmpty {
                        Section {
                            ForEach(item.context.keys.sorted(), id: \.self) { key in
                                ContextRow(key: key, value: item.context[key]!)
                            }
                        } header: { SectionHeader(text: "Context") }
                    }
                    Section {
                        if item.state == .open {
                            ForEach(item.options) { opt in
                                Button(role: opt.danger == true ? .destructive : nil) { tap(opt) } label: {
                                    HStack {
                                        Image(systemName: opt.danger == true ? "exclamationmark.triangle" : opt.needsNote == true ? "text.bubble" : "checkmark.circle")
                                        Text(opt.label).fontWeight(.semibold)
                                        Spacer()
                                        if model.inbox.answering.contains(item.id) { ProgressView() }
                                    }
                                }
                                .disabled(model.inbox.answering.contains(item.id))
                            }
                        } else if let a = item.answer {
                            let label = item.options.first { $0.id == a.optionId }?.label ?? a.optionId
                            Label("\(label) · \(Format.ago(a.at)) via \(a.via.rawValue)", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                            if let n = a.note, !n.isEmpty { Text(n).font(.subheadline).foregroundStyle(.secondary) }
                        } else {
                            Label("Expired without an answer", systemImage: "clock.badge.xmark").foregroundStyle(.secondary)
                        }
                        if let error { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.subheadline) }
                    } header: { SectionHeader(text: item.state == .open ? "Your answer" : "Answered") }
                }
                .listStyle(.insetGrouped)
            } else {
                EmptyState(symbol: "tray", title: "Not in the inbox", text: "This item is not loaded. Pull to refresh the Inbox.")
            }
        }
        .navigationTitle(item?.kind.glyph.label ?? "Inbox item")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(confirming.map { "\($0.label)?" } ?? "", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible) {
            if let opt = confirming {
                Button(opt.label, role: .destructive) { confirming = nil; proceed(opt) }
                Button("Cancel", role: .cancel) { confirming = nil }
            }
        } message: {
            Text("This is an outward action. It runs as soon as you confirm.")
        }
        .alert(noting.map { $0.label } ?? "", isPresented: Binding(get: { noting != nil }, set: { if !$0 { noting = nil } })) {
            TextField(noting?.id == "raise-today" ? "New cap for today, in ₹" : "Note", text: $note)
            Button("Send") { if let opt = noting { noting = nil; Task { await answer(opt, note: note) } } }
                .disabled(note.trimmingCharacters(in: .whitespaces).isEmpty)
            Button("Cancel", role: .cancel) { noting = nil }
        } message: {
            Text("This answer needs a note.")
        }
    }

    private func tap(_ opt: InboxOption) {
        error = nil
        if opt.danger == true { confirming = opt } else { proceed(opt) }
    }

    private func proceed(_ opt: InboxOption) {
        if opt.needsNote == true { note = ""; noting = opt } else { Task { await answer(opt, note: nil) } }
    }

    private func answer(_ opt: InboxOption, note: String?) async {
        guard let rest = model.rest else { return }
        do {
            try await model.inbox.answer(rest, id: id, optionId: opt.id, note: note)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// One key of the structured context. Diffs are monospace; links are tappable; lists are lines.
struct ContextRow: View {
    let key: String
    let value: JSONValue

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(key.replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression).capitalized)
                .font(.caption).foregroundStyle(.secondary)
            switch value {
            case .string(let s) where key.lowercased().contains("diff"):
                ScrollView(.horizontal) { Text(s).font(.caption.monospaced()).textSelection(.enabled) }
            case .string(let s):
                EvidenceLine(text: s)
            case .array(let items):
                ForEach(Array(items.enumerated()), id: \.offset) { _, v in
                    HStack(alignment: .top, spacing: 6) { Text("•"); EvidenceLine(text: v.display) }
                }
            default:
                Text(value.display).font(.subheadline)
            }
        }
        .padding(.vertical, 2)
    }
}
