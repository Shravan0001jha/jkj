import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmRepair = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("Server", value: model.config?.baseURL.absoluteString ?? "—")
                    LabeledContent("Connection") { connection }
                    if let h = model.health {
                        LabeledContent("Server version", value: h.version)
                        LabeledContent("Data directory", value: h.workplace.dataDir).lineLimit(2)
                        LabeledContent("Daily cap", value: Format.inr(h.workplace.capInr))
                        LabeledContent("Telegram bridge", value: h.workplace.telegram ? "on" : "off")
                    }
                    LabeledContent("Token", value: "in the Keychain")
                } header: {
                    SectionHeader(text: "Workplace")
                }
                if let e = model.lastSocketError {
                    Section {
                        Label(e, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                    } header: { SectionHeader(text: "Last socket error") }
                }
                Section {
                    Button("Reconnect now") { model.foreground() }
                    Button("Re-pair this phone", role: .destructive) { confirmRepair = true }
                } footer: {
                    Text("Re-pairing forgets the token and the server address. You will need a new one-time code from the Mac.")
                }
                Section {
                    LabeledContent("App", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—")
                    Text("Alerts reach this phone while the app is open or was just backgrounded. Notifications with the app closed need push (APNs), which is not built yet.")
                        .font(.footnote).foregroundStyle(.secondary)
                } header: { SectionHeader(text: "About") }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("Forget the token and pair again?", isPresented: $confirmRepair, titleVisibility: .visible) {
                Button("Re-pair", role: .destructive) { model.unpair(); dismiss() }
                Button("Cancel", role: .cancel) {}
            }
        }
    }

    @ViewBuilder private var connection: some View {
        switch model.connection {
        case .online(let v): Label(v.isEmpty ? "Online" : "Online", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        case .connecting: Label("Connecting…", systemImage: "antenna.radiowaves.left.and.right").foregroundStyle(.secondary)
        case .offline(let reason, _): Label(reason, systemImage: "wifi.exclamationmark").foregroundStyle(.orange)
        case .unauthorized: Label("Token refused", systemImage: "key.slash").foregroundStyle(.red)
        case .unpaired: Label("Not paired", systemImage: "circle.dotted").foregroundStyle(.secondary)
        }
    }
}
