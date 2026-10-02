import SwiftUI

/// Per shippable: what is merged but unreleased, the release in flight, the last one. Approving or
/// rejecting is the Inbox item (`open.inboxId`); once approved, Run starts the real script.
struct ReleasesView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var ready: [ReleaseReadiness] = []
    @State private var error: String?
    @State private var loaded = false
    @State private var running: Set<String> = []
    @State private var confirmRun: Release?

    var body: some View {
        NavigationStack {
            List {
                if let error, !loaded { ErrorRow(message: error) { Task { await load() } } }
                if loaded && ready.isEmpty {
                    EmptyState(symbol: "shippingbox", title: "Nothing to release", text: "When work is merged but unreleased, it shows here per app or service.")
                }
                ForEach(ready) { r in
                    Section {
                        if r.unreleased.isEmpty {
                            Label("Nothing unreleased", systemImage: "checkmark.circle").foregroundStyle(.secondary)
                        } else {
                            ForEach(r.unreleased, id: \.self) { Text($0).font(.caption.monospaced()) }
                        }
                        if let open = r.open {
                            let rel = model.releases[open.id] ?? open
                            HStack {
                                StateLabel(glyph: rel.state.glyph, compact: true)
                                Text("v\(rel.version)").font(.subheadline.weight(.semibold))
                                Spacer()
                                switch rel.state {
                                case .proposed:
                                    Button("Approve or reject") { dismiss(); model.router.openInbox(rel.inboxId) }.font(.subheadline)
                                case .approved:
                                    Button {
                                        confirmRun = rel
                                    } label: { HStack { if running.contains(rel.id) { ProgressView() }; Text("Run") } }
                                    .buttonStyle(.borderedProminent).disabled(running.contains(rel.id))
                                default:
                                    EmptyView()
                                }
                            }
                            if let log = rel.log, !log.isEmpty {
                                ScrollView(.horizontal) { Text(log).font(.caption2.monospaced()).textSelection(.enabled) }.frame(maxHeight: 80)
                            }
                            if let line = model.releaseLog[rel.id]?.last { Text(line).font(.caption.monospaced()).foregroundStyle(.secondary) }
                        }
                        if let last = r.last {
                            Label("Last: v\(last.version) · \(last.state.glyph.label) · \(Format.ago(last.createdAt))", systemImage: "clock.arrow.circlepath").font(.caption).foregroundStyle(.secondary)
                        }
                    } header: { SectionHeader(text: name(r.shippable)) }
                }
                if let error, loaded { Section { ErrorRow(message: error) { Task { await load() } } } }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Releases")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .refreshable { await load() }
            .task { await load() }
            .confirmationDialog(confirmRun.map { "Run the \(name($0.shippable)) \($0.version) release now?" } ?? "", isPresented: Binding(get: { confirmRun != nil }, set: { if !$0 { confirmRun = nil } }), titleVisibility: .visible) {
                if let rel = confirmRun {
                    Button("Run the release script", role: .destructive) { confirmRun = nil; Task { await run(rel) } }
                    Button("Cancel", role: .cancel) { confirmRun = nil }
                }
            } message: { Text("This runs the real release script on the Mac. It cannot be undone from the phone.") }
        }
    }

    private func name(_ s: Shippable) -> String {
        switch s {
        case .desktopMac: return "Desktop (Mac)"
        case .desktopIntel: return "Desktop (Intel)"
        case .windows: return "Windows"
        case .ios: return "iPhone / iPad"
        case .android: return "Android"
        case .serverApi: return "Server API"
        case .serverAgent: return "Cloud agent"
        case .website: return "Website"
        }
    }

    private func load() async {
        guard let rest = model.rest else { return }
        do { ready = try await rest.releasesReady(); error = nil; loaded = true } catch { if let m = error.userMessage { self.error = m } }
    }

    private func run(_ rel: Release) async {
        guard let rest = model.rest else { return }
        let ok = await model.deviceAuth.verify(reason: "Run the \(rel.version) release")
        guard ok else { error = "Not confirmed on this phone."; return }
        running.insert(rel.id)
        defer { running.remove(rel.id) }
        do { try await rest.runRelease(rel.id); error = nil } catch { if let m = error.userMessage { self.error = m } }
    }
}

extension ReleaseState {
    var glyph: Glyph {
        switch self {
        case .proposed: return Glyph(symbol: "circle.dotted", tint: .orange, label: "Proposed")
        case .approved: return Glyph(symbol: "checkmark.circle", tint: .green, label: "Approved")
        case .rejected: return Glyph(symbol: "xmark.circle", tint: .red, label: "Rejected")
        case .running: return Glyph(symbol: "play.circle.fill", tint: .green, label: "Running")
        case .done: return Glyph(symbol: "checkmark.seal.fill", tint: .green, label: "Done")
        case .failed: return Glyph(symbol: "exclamationmark.triangle.fill", tint: .red, label: "Failed")
        }
    }
}

/// An org-change proposal: the readable diff, the lint of the result, and the Inbox item that decides it.
struct ProposalDetailView: View {
    @Environment(AppModel.self) private var model
    let id: String
    @State private var detail: ProposalDetail?
    @State private var error: String?

    var body: some View {
        List {
            if let d = detail {
                Section {
                    HStack {
                        Pill(text: d.proposal.kind.rawValue, symbol: "person.2.badge.gearshape", tint: .indigo)
                        Pill(text: d.proposal.state.rawValue, tint: d.proposal.state == .pending ? .orange : d.proposal.state == .rejected ? .red : .green)
                        Spacer()
                        Text("by \(model.employeeName(d.proposal.proposedBy)) · \(Format.ago(d.proposal.createdAt))").font(.caption).foregroundStyle(.secondary)
                    }
                    Text(d.proposal.reason).font(.body)
                } header: { SectionHeader(text: "Why") }
                Section {
                    DiffView(diff: d.proposal.diff)
                } header: { SectionHeader(text: "The change, as a diff of the org files") }
                Section {
                    if d.proposal.lint.isEmpty {
                        Label("Lint clean after the change", systemImage: "checkmark.circle").foregroundStyle(.green)
                    }
                    ForEach(Array(d.proposal.lint.enumerated()), id: \.offset) { _, f in
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: f.severity == .error ? "xmark.octagon.fill" : "exclamationmark.triangle").foregroundStyle(f.severity == .error ? .red : .orange)
                            VStack(alignment: .leading) { Text(f.subject).font(.subheadline.weight(.medium)); Text(f.message).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                } header: { SectionHeader(text: "Lint of the result") } footer: { if d.proposal.lint.contains(where: { $0.severity == .error }) { Text("Errors block approval.") } }
                Section {
                    OrgDelta(before: d.proposal.before, after: d.proposal.after)
                } header: { SectionHeader(text: "Before → after") }
                Section {
                    AnswerOptions(item: model.inbox.item(d.item.id) ?? d.item)
                } header: { SectionHeader(text: (model.inbox.item(d.item.id) ?? d.item).state == .open ? "Your decision" : "Decided") }
            } else if let error {
                ErrorRow(message: error) { Task { await load() } }
            } else {
                HStack { Spacer(); ProgressView(); Spacer() }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Org change")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        guard let rest = model.rest else { return }
        do { detail = try await rest.proposal(id); error = nil } catch { if let m = error.userMessage { self.error = m } }
    }
}

/// A unified diff, coloured by line kind, shape first: +/− stay in the text.
struct DiffView: View {
    let diff: String

    var body: some View {
        ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(diff.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, line in
                    let s = String(line)
                    Text(s.isEmpty ? " " : s)
                        .font(.caption.monospaced())
                        .foregroundStyle(s.hasPrefix("+") && !s.hasPrefix("+++") ? .green : s.hasPrefix("-") && !s.hasPrefix("---") ? .red : s.hasPrefix("@@") ? .purple : .primary)
                }
            }
            .textSelection(.enabled)
        }
    }
}

/// What changes in the org: employees and charters added, removed or moved.
struct OrgDelta: View {
    @Environment(AppModel.self) private var model
    let before: OrgSnapshot
    let after: OrgSnapshot

    var body: some View {
        let b = Set(before.employees.map(\.id)), a = Set(after.employees.map(\.id))
        let bc = Set(before.charters.map(\.id)), ac = Set(after.charters.map(\.id))
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(a.subtracting(b)).sorted(), id: \.self) { id in
                Label("Hire \(after.employees.first(where: { $0.id == id })?.name ?? id)", systemImage: "person.badge.plus").foregroundStyle(.green)
            }
            ForEach(Array(b.subtracting(a)).sorted(), id: \.self) { id in
                Label("Retire \(model.employeeName(id))", systemImage: "person.badge.minus").foregroundStyle(.red)
            }
            ForEach(Array(ac.subtracting(bc)).sorted(), id: \.self) { id in
                Label("New charter \(after.charters.first(where: { $0.id == id })?.title ?? id)", systemImage: "doc.badge.plus").foregroundStyle(.green)
            }
            ForEach(Array(bc.subtracting(ac)).sorted(), id: \.self) { id in
                Label("Charter removed: \(model.charterTitle(id))", systemImage: "doc.badge.minus").foregroundStyle(.red)
            }
            let moved = after.map.count - before.map.count
            if moved != 0 { Label("\(abs(moved)) map entries \(moved > 0 ? "added" : "removed")", systemImage: "map").foregroundStyle(.secondary) }
            if a == b && ac == bc && moved == 0 { Text("Same people and charters; the diff above has the detail.").font(.caption).foregroundStyle(.secondary) }
        }
        .font(.subheadline)
    }
}
