import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmRepair = false
    @State private var confirmSignOut = false
    @State private var showDeveloper = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("Reached through", value: model.mode == .relay ? "Relay" : "LAN (developer)")
                    LabeledContent("Server", value: model.config.baseURL.absoluteString)
                    LabeledContent("Connection") { connection }
                    if let h = model.health {
                        LabeledContent("Server version", value: h.version)
                        LabeledContent("Data directory", value: h.workplace.dataDir).lineLimit(2)
                        LabeledContent("Daily cap", value: Format.inr(h.workplace.capInr))
                        LabeledContent("Telegram bridge", value: h.workplace.telegram ? "on" : "off")
                    }
                    LabeledContent(model.mode == .relay ? "Session" : "Token", value: "in the Keychain")
                } header: {
                    SectionHeader(text: "Workplace")
                } footer: {
                    if model.mode == .relay {
                        Text("Sessions end after 12 hours idle or 7 days; the app then asks you to sign in again.")
                    }
                }
                if let e = model.lastSocketError {
                    Section {
                        Label(e, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                    } header: { SectionHeader(text: "Last socket error") }
                }
                Section {
                    Button("Reconnect now") { model.foreground() }
                    if model.mode == .relay {
                        Button("Sign out", role: .destructive) { confirmSignOut = true }
                    } else {
                        Button("Re-pair this phone", role: .destructive) { confirmRepair = true }
                    }
                } footer: {
                    Text(model.mode == .relay
                         ? "Signing out forgets the session on this phone. Sign in again with your passkey or a Telegram code."
                         : "Re-pairing forgets the LAN token and address and returns to the relay. You will need a new one-time code from the Mac to pair again.")
                }
                Section {
                    Button("Developer options") { showDeveloper = true }
                } footer: {
                    Text("LAN pairing for a Workplace on the same network, without the relay.")
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
            .confirmationDialog("Forget the LAN token and pair again?", isPresented: $confirmRepair, titleVisibility: .visible) {
                Button("Re-pair", role: .destructive) { model.unpair(); dismiss() }
                Button("Cancel", role: .cancel) {}
            }
            .confirmationDialog("Sign out of the Workplace on this phone?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { model.signOut(); dismiss() }
                Button("Cancel", role: .cancel) {}
            }
            .sheet(isPresented: $showDeveloper) { DeveloperOptionsView() }
        }
    }

    private var connection: some View {
        let (text, symbol, tint): (String, String, Color) = {
            switch model.connection {
            case .online: return ("Online", "checkmark.circle.fill", .green)
            case .connecting: return ("Connecting…", "antenna.radiowaves.left.and.right", .secondary)
            case .offline(let reason, _): return (reason, "wifi.exclamationmark", .orange)
            case .macOffline: return ("Mac offline", "desktopcomputer.trianglebadge.exclamationmark", .red)
            case .accessOff: return ("Access switched off", "lock.slash", .red)
            case .unauthorized: return (model.mode == .relay ? "Session ended" : "Token refused", "key.slash", .red)
            case .signedOut: return (model.mode == .relay ? "Signed out" : "Not paired", "circle.dotted", .secondary)
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
