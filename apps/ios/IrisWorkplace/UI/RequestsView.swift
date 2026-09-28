import SwiftUI

/// State a feature or ask Asha in one box; the status comes back in the owner's terms and keeps
/// updating over the socket (`work.updated`).
struct NewRequestView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var platforms: Set<String> = []
    @State private var busy = false
    @State private var error: String?
    @State private var result: RequestResponse?

    private let allPlatforms = ["mac", "intel", "windows", "ios", "android", "server", "web"]

    var body: some View {
        NavigationStack {
            Form {
                if let r = result {
                    Section {
                        RequestStatusRow(feature: model.requests.latestFeature(r.feature), status: model.requests.status(for: r.feature.id) ?? r.status)
                        Text("Asha has it. This line keeps updating; the feature is also on the Features board.")
                            .font(.footnote).foregroundStyle(.secondary)
                    } header: { SectionHeader(text: "Status") }
                } else {
                    Section {
                        TextField("What should Iris do, or what do you want to know?", text: $text, axis: .vertical)
                            .lineLimit(4...10)
                    } header: { SectionHeader(text: "Your request") } footer: {
                        Text("One message. Asha writes the spec, routes the work through the ownership map, and the assignees reply with plans. You will see who has it and where it stands.")
                    }
                    Section {
                        ForEach(allPlatforms, id: \.self) { p in
                            Toggle(p, isOn: Binding(get: { platforms.contains(p) }, set: { on in if on { platforms.insert(p) } else { platforms.remove(p) } }))
                        }
                    } header: { SectionHeader(text: "Platforms (optional)") }
                    if let error { Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red) } }
                }
            }
            .navigationTitle(result == nil ? "New request" : "Request sent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(result == nil ? "Cancel" : "Close") { dismiss() } }
                if result == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(busy ? "Sending…" : "Send to Asha") { Task { await send() } }
                            .disabled(busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
    }

    private func send() async {
        guard let rest = model.rest else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            result = try await model.requests.create(rest, text: text.trimmingCharacters(in: .whitespacesAndNewlines), platformIds: platforms.isEmpty ? nil : Array(platforms).sorted())
        } catch { self.error = error.localizedDescription }
    }
}

/// One request: the feature title and the status line, with the stage glyph.
struct RequestStatusRow: View {
    @Environment(AppModel.self) private var model
    let feature: WorkItem
    let status: RequestStatus

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Image(systemName: status.stage.glyph.symbol).foregroundStyle(status.stage.glyph.tint)
                Text(feature.title).font(.subheadline.weight(.semibold)).lineLimit(2)
            }
            Text(status.line).font(.subheadline).foregroundStyle(.secondary)
            if !status.assignments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(status.assignments) { a in
                            Pill(text: (a.employeeId.map { model.employeeName($0) } ?? model.charterTitle(a.charterId)) + " · " + a.state.glyph.label, symbol: a.state.glyph.symbol, tint: a.state.glyph.tint)
                                .lineLimit(1).fixedSize()
                        }
                    }
                }
            }
            Text(Format.ago(feature.updatedAt)).font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
    }
}

extension RequestStage {
    var glyph: Glyph {
        switch self {
        case .withAsha: return Glyph(symbol: "person.crop.circle.badge.clock", tint: .blue, label: "With Asha")
        case .specced: return Glyph(symbol: "doc.text", tint: .blue, label: "Specced")
        case .routed: return Glyph(symbol: "arrow.triangle.branch", tint: .indigo, label: "Routed")
        case .building: return Glyph(symbol: "play.circle.fill", tint: .green, label: "Building")
        case .review: return Glyph(symbol: "magnifyingglass.circle", tint: .purple, label: "In review")
        case .blocked: return Glyph(symbol: "octagon.fill", tint: .red, label: "Blocked")
        case .built: return Glyph(symbol: "hammer.circle.fill", tint: .mint, label: "Built")
        case .released: return Glyph(symbol: "checkmark.seal.fill", tint: .green, label: "Released")
        }
    }
}

/// The requests list: newest first, each with its status line.
struct RequestsList: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            if let e = model.requests.error, !model.requests.loaded { ErrorRow(message: e) { Task { await reload() } } }
            if model.requests.loaded && model.requests.items.isEmpty {
                EmptyState(symbol: "text.bubble", title: "No requests yet", text: "Tap + to state a feature or ask Asha. The status comes back here.")
            }
            ForEach(model.requests.items) { r in
                NavigationLink(value: r.feature.id) {
                    RequestStatusRow(feature: model.requests.latestFeature(r.feature), status: model.requests.status(for: r.feature.id) ?? r.status)
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await reload() }
        .task { if !model.requests.loaded { await reload() } }
    }

    private func reload() async {
        guard let rest = model.rest else { return }
        await model.requests.load(rest)
    }
}
