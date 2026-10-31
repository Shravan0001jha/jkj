import SwiftUI

/// The command palette (docs/THEMES.md §3): type to jump to any epic, story, decision, person or
/// room, or to run an action. Searches what the phone already has; no server call.
struct CommandPaletteView: View {
    @Environment(AppModel.self) private var model
    @Environment(SciFiCX.self) private var cx
    @Environment(\.themeStore) private var store
    @Environment(\.theme) private var theme
    @State private var query = ""
    @FocusState private var focused: Bool

    private var entries: [CommandEntry] {
        CommandSearch.entries(plan: model.plan.plan, board: model.plan.board, open: model.inbox.open,
                              people: model.office.cards.map { ($0.employee.id, $0.employee.name) },
                              rooms: model.rooms.rooms, currentTheme: store?.selected ?? .default)
    }

    var body: some View {
        NavigationStack {
            List {
                let results = CommandSearch.rank(query, entries, limit: 40)
                if results.isEmpty {
                    Text("No match for “\(query)”").foregroundStyle(.secondary)
                }
                ForEach(results) { e in
                    Button { run(e.target) } label: {
                        HStack(spacing: 12) {
                            Image(systemName: symbol(e)).frame(width: 24).foregroundStyle(Color.accentColor)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(e.title).lineLimit(2).foregroundStyle(.primary)
                                Text([e.kind.label, e.subtitle].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption.monospaced()).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .accessibilityIdentifier("palette.\(e.id)")
                }
                .themedRows()
            }
            .listStyle(.insetGrouped)
            .themedList()
            .safeAreaInset(edge: .top, spacing: 0) {
                HStack(spacing: 8) {
                    Text(">").font(.title3.monospaced().weight(.bold)).foregroundStyle(Color.accentColor)
                    TextField("Jump to an epic, decision, person…", text: $query)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($focused)
                        .submitLabel(.go)
                        .onSubmit { if let first = CommandSearch.rank(query, entries, limit: 1).first { run(first.target) } }
                        .accessibilityIdentifier("palette.query")
                }
                .padding(.horizontal, 16).padding(.vertical, 12)
                .themedBar(Material.bar)
            }
            .navigationTitle("Command")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { cx.showPalette = false } } }
            .onAppear { focused = true }
        }
        .presentationDetents([.large])
    }

    private func symbol(_ e: CommandEntry) -> String {
        switch e.target {
        case .action(let a): return a.symbol
        case .talk: return "person.crop.circle"
        case .inbox: return "tray"
        case .room: return "person.3"
        case .item: return e.kind == .epic ? ItemLevel.epic.symbol : e.kind == .task ? ItemLevel.task.symbol : ItemLevel.story.symbol
        }
    }

    private func run(_ t: CommandTarget) {
        cx.showPalette = false
        // Let the sheet go before another one (Settings, Spend…) is presented.
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            let r = model.router
            switch t {
            case .item(let id): r.openItem(id)
            case .inbox(let id): r.openInbox(id)
            case .talk(let id): r.talk(to: id)
            case .room(let id): r.openRoom(id)
            case .action(let a):
                switch a {
                case .settings: r.showSettings = true
                case .spend: r.showSpend = true
                case .alerts: r.showAlerts = true
                case .office: r.showOffice = true
                case .releases: r.showReleases = true
                case .newRequest: r.showNewRequest = true
                case .features: r.showFeatures = true
                case .board: r.closeSheets(); r.tab = .plan; r.planBoard = true
                case .theme(let id): store?.selected = id
                }
            }
        }
    }
}
