import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(SciFiCX.self) private var cx
    @Environment(\.theme) private var theme

    var body: some View {
        @Bindable var router = model.router
        Group {
            if !model.hasCredential {
                if model.mode == .relay { SignInView() } else { PairingView() }
            } else if model.connection == .unauthorized && model.mode == .lan {
                // Relay: the session ended, but the cached lists stay on screen under a "Sign in again"
                // strip (ConnectionStrip). LAN: the Mac refused its token; only re-pairing fixes that.
                ReauthView()
            } else if model.connection == .accessOff && model.office.data == nil {
                AccessOffView()
                    .sheet(isPresented: $router.showSettings) { SettingsView() }
            } else if model.connection == .macOffline && model.office.data == nil {
                MacOfflineView()
                    .sheet(isPresented: $router.showSettings) { SettingsView() }
            } else {
                TabView(selection: $router.barSelection) {
                    PlanView()
                        .tabItem { Label("Plan", systemImage: "list.bullet.rectangle.portrait") }
                        .tag(Tab.plan)
                    InboxView()
                        .tabItem { Label("Inbox", systemImage: "tray") }
                        .badge(model.inbox.open.count)
                        .tag(Tab.inbox)
                    TalkView()
                        .tabItem { Label("Talk", systemImage: "bubble.left.and.bubble.right") }
                        .tag(Tab.talk)
                    RoomView()
                        .tabItem { Label("Room", systemImage: "person.3") }
                        .badge(model.room.unread.count)
                        .tag(Tab.room)
                    DashboardTab()
                        .tabItem { Label("Dashboard", systemImage: "gauge.with.dots.needle.33percent") }
                        .badge(model.updates.unseen)
                        .tag(Tab.dashboard)
                }
                .themedTabChrome(index: Tab.bar.firstIndex(of: router.barSelection) ?? 0, count: Tab.bar.count)
                .overlay(alignment: .bottom) { if theme.has(.decisionQueue) { StagedDecisionsBar() } }
                .overlay(alignment: .top) { AlertBanner() }
                .sheet(isPresented: Bindable(cx).showPalette) { CommandPaletteView() }
                .sheet(isPresented: $router.showSettings) { SettingsView() }
                .sheet(isPresented: $router.showAlerts) { AlertsView() }
                .sheet(isPresented: $router.showSpend) { SpendView() }
                .sheet(isPresented: $router.showNewRequest) { NewRequestView() }
                .sheet(isPresented: $router.showReleases) { ReleasesView() }
                .sheet(isPresented: $router.showOffice) { OfficeView() }
                .sheet(isPresented: $router.showFeatures) { FeaturesView() }
                // A mute that did not save was rolled back (CHAT-NOTIFY-CONTRACT §6.5): say so once.
                .alert("Couldn't change notifications", isPresented: Binding(get: { model.chatPrefs.error != nil },
                                                                              set: { if !$0 { model.chatPrefs.clearError() } })) {
                    Button("OK", role: .cancel) {}
                } message: { Text(model.chatPrefs.error ?? "") }
            }
        }
        .onOpenURL { url in model.handleOpenURL(url) }
    }
}

/// A slim strip under the navigation bar while the socket is not open.
struct ConnectionStrip: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.connection {
        case .online, .signedOut:
            EmptyView()
        case .unauthorized:
            ReauthStrip()
        case .connecting:
            strip("Connecting…", symbol: "antenna.radiowaves.left.and.right", tint: .secondary)
        case .macOffline:
            strip("Your Mac is offline — Workplace unavailable", symbol: "desktopcomputer.trianglebadge.exclamationmark", tint: .red)
        case .accessOff:
            strip("Access is switched off — turn it on from your Mac or Telegram", symbol: "lock.slash", tint: .red)
        case .offline(let reason, let retryAt):
            let when = retryAt.map { $0.timeIntervalSinceNow > 1 ? " · retrying \($0.formatted(.relative(presentation: .numeric)))" : " · retrying now" } ?? ""
            strip("\(reason)\(when)", symbol: "wifi.exclamationmark", tint: .orange)
        }
    }

    private func strip(_ text: String, symbol: String, tint: Color) -> some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
            Text(text).lineLimit(1)
            Spacer()
            Button("Settings") { model.router.showSettings = true }.font(.caption.weight(.semibold))
        }
        .font(.caption)
        .foregroundStyle(tint)
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .themedBar(Material.bar)
        .accessibilityElement(children: .combine)
    }
}

/// The relay ended the session: one tap signs in again, over whatever the screen already shows.
/// Nothing is cleared here; Sign out (Settings) is the only thing that forgets the cached lists.
struct ReauthStrip: View {
    @Environment(AppModel.self) private var model
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "key.slash")
                Text("Your session has ended").lineLimit(1)
                Spacer()
                Button(busy ? "Signing in…" : "Sign in again") { signIn() }
                    .font(.caption.weight(.semibold)).themedProminent().controlSize(.mini).disabled(busy)
            }
            .foregroundStyle(.orange)
            if let error { Text(error).foregroundStyle(.red).lineLimit(2) }
        }
        .font(.caption)
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .themedBar(Material.bar)
    }

    private func signIn() {
        Task {
            busy = true; error = nil
            defer { busy = false }
            do { try await model.signIn() } catch WebAuthError.cancelled {} catch { if let m = error.userMessage { self.error = m } }
        }
    }
}

/// The in-app banner for a socket `alert`. Tapping one with an Inbox id opens it.
struct AlertBanner: View {
    @Environment(AppModel.self) private var model
    @Environment(\.theme) private var theme

    var body: some View {
        if let b = model.alerts.banner {
            let g = b.event.level.glyph
            Button {
                model.alerts.dismissBanner()
                if let id = b.event.inboxId { model.router.openInbox(id) } else { model.router.showAlerts = true }
            } label: {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: g.symbol).foregroundStyle(g.tint).font(.title3)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(b.event.title).font(.subheadline.weight(.semibold))
                        if !b.event.body.isEmpty { Text(b.event.body).font(.caption).lineLimit(2) }
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "xmark").font(.caption).foregroundStyle(.secondary)
                }
                .padding(12)
                .themedCard(radius: theme.radii.card, fill: Material.regularMaterial, accent: g.tint)
                .overlay(RoundedRectangle(cornerRadius: theme.radii.card).strokeBorder(g.tint.opacity(0.5)))
                .padding(.horizontal, 12)
                .padding(.top, 4)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.primary)
            .transition(.move(edge: .top).combined(with: .opacity))
            .animation(.snappy, value: b.id)
            .accessibilityLabel("\(g.label): \(b.event.title). \(b.event.body)")
            .accessibilityIdentifier("alert.banner")
        }
    }
}

/// The owner switched published access off: distinct from the Mac being offline.
struct AccessOffView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "lock.slash").font(.system(size: 48)).foregroundStyle(.red)
            Text("Access is switched off").font(.title2.weight(.semibold))
            Text("Published access to the Workplace is off. Turn it back on from your Mac or Telegram; the app reconnects on its own.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary)
            HStack(spacing: 8) { ProgressView(); Text("Checking every few seconds").font(.caption).foregroundStyle(.secondary) }
            Button("Check now") { model.foreground() }.buttonStyle(.bordered)
            Button("Settings") { model.router.showSettings = true }.font(.footnote)
        }
        .padding(24)
        .themedScreen()
    }
}
