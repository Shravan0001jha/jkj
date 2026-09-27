import SwiftUI

/// Socket `alert` events received this session. Tapping one with an Inbox id opens the item.
struct AlertsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if model.alerts.alerts.isEmpty {
                    EmptyState(symbol: "bell", title: "No alerts yet",
                               text: "When an employee needs you, is blocked, or the spend cap is reached, it shows here and as a banner. With the app closed, alerts need push (not built yet).")
                }
                ForEach(model.alerts.alerts) { a in
                    let g = a.event.level.glyph
                    Button {
                        if let id = a.event.inboxId { dismiss(); model.router.openInbox(id) }
                    } label: {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: g.symbol).foregroundStyle(g.tint).font(.title3).frame(width: 26)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(a.event.title).font(.subheadline.weight(a.read ? .regular : .semibold))
                                if !a.event.body.isEmpty { Text(a.event.body).font(.caption).foregroundStyle(.secondary) }
                                HStack(spacing: 6) {
                                    Text(g.label)
                                    Text("·")
                                    Text(a.at.formatted(date: .omitted, time: .shortened))
                                    if a.event.inboxId != nil { Text("·"); Text("open in Inbox") }
                                }
                                .font(.caption2).foregroundStyle(.tertiary)
                            }
                            Spacer()
                            if a.event.inboxId != nil { Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary) }
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(a.event.inboxId == nil)
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Alerts")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Clear") { model.alerts.clear() }.disabled(model.alerts.alerts.isEmpty)
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .onAppear { model.alerts.markAllRead() }
            .onChange(of: model.alerts.alerts.count) { _, _ in model.alerts.markAllRead() }
        }
    }
}
