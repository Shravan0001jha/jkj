import SwiftUI

/// Assign work: to one employee (or a charter's holder), optionally under a feature, and start
/// the session at once.
struct AssignView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var employeeId: String? = nil
    var featureId: String? = nil
    @State private var title = ""
    @State private var body_ = ""
    @State private var target: String = ""
    @State private var startNow = true
    @State private var busy = false
    @State private var error: String?
    @State private var created: WorkItem?

    var body: some View {
        NavigationStack {
            Form {
                if let w = created {
                    Section {
                        HStack { Image(systemName: w.state.glyph.symbol).foregroundStyle(w.state.glyph.tint); Text(w.title).font(.subheadline.weight(.semibold)) }
                        Text("\(model.employeeName(w.employeeId)) has it" + (startNow ? "; the session started." : ".")).font(.subheadline).foregroundStyle(.secondary)
                        Button("Open Talk with \(model.employeeName(w.employeeId))") { dismiss(); if let e = w.employeeId { model.router.talk(to: e) } }
                    } header: { SectionHeader(text: "Assigned") }
                } else {
                    Section {
                        TextField("Title", text: $title)
                        TextField("What to do, and what done looks like", text: $body_, axis: .vertical).lineLimit(3...8)
                    } header: { SectionHeader(text: "Work") }
                    Section {
                        Picker("Employee", selection: $target) {
                            ForEach(model.office.data?.units ?? []) { u in
                                ForEach(u.employees) { c in Text("\(c.employee.name) · \(c.charters.map(\.title).joined(separator: ", "))").tag(c.employee.id) }
                            }
                        }
                        Toggle("Start the session now", isOn: $startNow)
                    } header: { SectionHeader(text: "Who") } footer: {
                        Text(featureId != nil ? "The feature id goes in the brief, so the assignee sees it." : "To give a feature to several charters at once, state it as a request: Asha routes it through the ownership map.")
                    }
                    if let error { Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red) } }
                }
            }
            .navigationTitle(created == nil ? "Assign" : "Assigned")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(created == nil ? "Cancel" : "Close") { dismiss() } }
                if created == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(busy ? "Assigning…" : "Assign") { Task { await assign() } }
                            .disabled(busy || title.trimmingCharacters(in: .whitespaces).isEmpty || target.isEmpty)
                    }
                }
            }
            .onAppear { target = employeeId ?? model.office.data?.chiefOfStaff ?? "" }
        }
    }

    private func assign() async {
        guard let rest = model.rest else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            // The contract has no featureId on CreateWorkRequest; the feature goes in the body so the assignee sees it.
            var text = body_.trimmingCharacters(in: .whitespacesAndNewlines)
            if let featureId { text = (text.isEmpty ? "" : text + "\n\n") + "Feature: \(featureId)" }
            let req = CreateWorkRequest(kind: .assignment, title: title.trimmingCharacters(in: .whitespaces), body: text, employeeId: target)
            let w = try await rest.createWork(req)
            if startNow { _ = try await rest.startWork(w.id) }
            created = w
        } catch { if let m = error.userMessage { self.error = m } }
    }
}
