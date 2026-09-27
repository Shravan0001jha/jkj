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

    private var connection: some View {
        let (text, symbol, tint): (String, String, Color) = {
            switch model.connection {
            case .online: return ("Online", "checkmark.circle.fill", .green)
            case .connecting: return ("Connecting…", "antenna.radiowaves.left.and.right", .secondary)
            case .offline(let reason, _): return (reason, "wifi.exclamationmark", .orange)
            case .unauthorized: return ("Token refused", "key.slash", .red)
            case .unpaired: return ("Not paired", "circle.dotted", .secondary)
            }
        }()
        return HStack(spacing: 6) {
            Image(systemName: symbol)
            Text(text)
        }
        .foregroundStyle(tint)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Connection \(text)")
    }
}
