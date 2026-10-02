import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmRepair = false
    @State private var confirmSignOut = false
    @State private var showDeveloper = false
    @State private var devices: [PushDevice] = []
    @State private var devicesError: String?

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
                if let h = model.health {
                    Section {
                        if let r = h.resilience {
                            LabeledContent("Mac", value: r.macLine())
                            if let t = r.tunnel {
                                LabeledContent("Tunnel to the relay") {
                                    HStack(spacing: 6) {
                                        Image(systemName: t.status == "connected" ? "checkmark.circle.fill" : "exclamationmark.triangle").foregroundStyle(t.status == "connected" ? .green : .orange)
                                        Text(t.status)
                                    }
                                }
                                if let rc = t.reconnects, rc.halfOpen + rc.afterSleep > 0 {
                                    LabeledContent("Reconnects", value: "\(rc.afterSleep) after sleep · \(rc.halfOpen) half-open")
                                }
                                if let e = t.lastError, !e.isEmpty { Text(e).font(.caption).foregroundStyle(.secondary) }
                            }
                            if let b = r.boots { LabeledContent("Workplace restarts", value: "\(b.last24h) in 24 h") }
                            if let w = r.watchdog { LabeledContent("Watchdog", value: w.link + ((w.incidents ?? 0) > 0 ? " · \(w.incidents!) incidents" : "")) }
                            if let u = r.uptimeSeconds { LabeledContent("Up for", value: Format.duration(u)) }
                        } else {
                            Text("This server does not report the Mac's health yet.").font(.footnote).foregroundStyle(.secondary)
                        }
                        if let p = h.workplace.push {
                            LabeledContent("Push from the Mac", value: p.enabled ? "on · \(p.sentToday) sent today" + (p.suppressedToday > 0 ? " · \(p.suppressedToday) suppressed" : "") : "off")
                        }
                    } header: { SectionHeader(text: "The Mac") } footer: {
                        Text("On battery the Mac may sleep and the tunnel drops; the Workplace notices the wake and reconnects on its own.")
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
                if model.mode == .relay {
                    Section {
                        LabeledContent("This phone gets pushes", value: model.pushStatusLine).lineLimit(3)
                        if devices.isEmpty {
                            Text(devicesError ?? "No devices registered yet.").font(.footnote).foregroundStyle(.secondary)
                        }
                        ForEach(Array(devices.enumerated()), id: \.offset) { _, d in
                            HStack {
                                Label(d.device ?? "Device", systemImage: d.thisDevice == true ? "iphone.gen3" : "iphone")
                                if d.thisDevice == true { Pill(text: "this phone", tint: .accentColor) }
                                Spacer()
                                Text(d.env).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    } header: { SectionHeader(text: "Notifications") } footer: {
                        Text("Pushes come from the relay for Inbox items that need you. They stop when you sign out.")
                    }
                }
                Section {
                    Button("Developer options") { showDeveloper = true }
                } footer: {
                    Text("LAN pairing for a Workplace on the same network, without the relay.")
                }
                Section {
                    LabeledContent("App", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—")
                    Text("Alerts reach this phone while the app is open or was just backgrounded. With the app closed, Inbox items that need you arrive as notifications through the relay.")
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
            .task {
                guard model.mode == .relay, let rest = model.rest else { return }
                do { devices = try await rest.pushDevices().devices } catch { if let m = error.userMessage { devicesError = m } }
            }
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
