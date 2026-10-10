import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmRepair = false
    @State private var confirmSignOut = false
    @State private var showDeveloper = false
    @State private var devices: [PushDevice] = []
    @State private var devicesError: String?
    @State private var choosingFocus = false
    @State private var actionError: String?

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
                superFocusSection
                macQueueSection
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
            .confirmationDialog("Super focus for how long?", isPresented: $choosingFocus, titleVisibility: .visible) {
                ForEach(SuperFocusStore.choices, id: \.self) { h in Button("\(h) hours") { setFocus(h) } }
                Button("Cancel", role: .cancel) {}
            } message: { Text("Pushes reach you even in quiet hours until it ends.") }
            .alert("Couldn't do that", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(actionError ?? "") }
            .task {
                guard let rest = model.rest else { return }
                async let focus: Void = model.superFocus.load(rest)
                async let queue: Void = model.macQueue.load(rest)
                _ = await (focus, queue)
            }
            .task {
                guard model.mode == .relay, let rest = model.rest else { return }
                do { devices = try await rest.pushDevices().devices } catch { if let m = error.userMessage { devicesError = m } }
            }
        }
    }

    // MARK: super focus

    /// On: pushes ignore quiet hours until the chosen time (2, 4 or 8 hours). Off clears it.
    @ViewBuilder private var superFocusSection: some View {
        let store = model.superFocus
        if store.supported || store.error != nil {
            Section {
                let active = store.isActive()
                Toggle(isOn: Binding(get: { active }, set: { on in if on { choosingFocus = true } else { setFocus(0) } })) {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Super focus")
                            if active, let d = store.untilDate() {
                                Text("On until \(d.formatted(date: Calendar.current.isDateInToday(d) ? .omitted : .abbreviated, time: .shortened))")
                                    .font(.caption).foregroundStyle(.orange)
                                    .accessibilityIdentifier("settings.superFocus.until")
                            }
                        }
                    } icon: { Image(systemName: "bolt.badge.clock") }
                }
                .disabled(store.busy || model.rest == nil)
                .accessibilityIdentifier("settings.superFocus")
                if active {
                    Menu("Change the length") {
                        ForEach(SuperFocusStore.choices, id: \.self) { h in Button("\(h) hours from now") { setFocus(h) } }
                    }
                    .font(.subheadline)
                }
                if let e = store.error { Text(e).font(.caption).foregroundStyle(.secondary) }
            } header: { SectionHeader(text: "Super focus") } footer: {
                Text("While it is on, pushes reach you even in quiet hours. Choose 2, 4 or 8 hours; it switches itself off.")
            }
        }
    }

    private func setFocus(_ hours: Int) {
        guard let rest = model.rest else { return }
        Task {
            do { try await model.superFocus.set(rest, hours: hours) } catch { if let m = error.userMessage { actionError = m } }
        }
    }

    // MARK: Mac queue

    /// Who has the Mac and who is waiting for it; the next in line can be let in now.
    @ViewBuilder private var macQueueSection: some View {
        let store = model.macQueue
        if store.supported || store.error != nil {
            Section {
                if store.shown.isEmpty {
                    Text(store.error ?? "Nobody is waiting for the Mac.").font(.subheadline).foregroundStyle(.secondary)
                }
                ForEach(store.shown) { e in
                    HStack(alignment: .top, spacing: 10) {
                        HStack(alignment: .top, spacing: 10) {
                        Image(systemName: e.state == .granted ? "desktopcomputer" : "clock")
                            .foregroundStyle(e.state == .granted ? .green : .secondary).frame(width: 22)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(model.employeeName(e.emp)).font(.subheadline.weight(.semibold))
                                if e.state == .granted { Pill(text: "Has the Mac", tint: .green) }
                            }
                            let meta = [e.minutes.map { "\($0) min" }, e.itemId, e.at.map { Format.ago($0) }].compactMap { $0 }
                            if !meta.isEmpty { Text(meta.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary) }
                            if let why = e.why, !why.isEmpty { Text(why).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                        }
                        }
                        .accessibilityElement(children: .combine)
                        Spacer(minLength: 0)
                        if e.id == store.head?.id {
                            if store.granting == e.id { ProgressView() } else {
                                Button("Grant now") { grant(e.id) }
                                    .buttonStyle(.borderedProminent).controlSize(.small)
                                    .accessibilityIdentifier("settings.macQueue.grant")
                            }
                        }
                    }
                }
            } header: {
                HStack { SectionHeader(text: "Mac queue"); Spacer()
                    Button { Task { if let rest = model.rest { await store.load(rest) } } } label: { Image(systemName: "arrow.clockwise") }
                        .accessibilityLabel("Refresh the Mac queue")
                }
            } footer: { Text("Employees ask for the Mac to run real tests. Grant now lets the next one in without waiting.") }
        }
    }

    private func grant(_ id: String) {
        guard let rest = model.rest else { return }
        Task {
            do { try await model.macQueue.grant(rest, id: id) } catch { if let m = error.userMessage { actionError = m } }
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
