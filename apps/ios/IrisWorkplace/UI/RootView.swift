import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var router = model.router
        Group {
            if !model.hasCredential {
                if model.mode == .relay { SignInView() } else { PairingView() }
            } else if model.connection == .unauthorized {
                ReauthView()
            } else if model.connection == .accessOff && model.office.data == nil {
                AccessOffView()
                    .sheet(isPresented: $router.showSettings) { SettingsView() }
            } else if model.connection == .macOffline && model.office.data == nil {
                MacOfflineView()
                    .sheet(isPresented: $router.showSettings) { SettingsView() }
            } else {
                TabView(selection: $router.tab) {
                    OfficeView()
                        .tabItem { Label("Office", systemImage: "building.2") }
                        .tag(Tab.office)
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
                    FeaturesView()
                        .tabItem { Label("Features", systemImage: "square.grid.2x2") }
                        .tag(Tab.features)
                }
                .overlay(alignment: .top) { AlertBanner() }
                .sheet(isPresented: $router.showSettings) { SettingsView() }
                .sheet(isPresented: $router.showAlerts) { AlertsView() }
                .sheet(isPresented: $router.showSpend) { SpendView() }
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
        case .online, .signedOut, .unauthorized:
            EmptyView()
        case .connecting:
            strip("Connecting…", symbol: "antenna.radiowaves.left.and.right", tint: .secondary)
        case .macOffline:
            strip("Your Mac is offline — Workplace unavailable", symbol: "desktopcomputer.trianglebadge.exclamationmark", tint: .red)
        case .accessOff:
            strip("Access is switched off — turn it on from your Mac or Telegram", symbol: "lock.slash", tint: .red)
        case .offline(let reason, let retryAt):
            let when = retryAt.map { " · retrying \($0.formatted(.relative(presentation: .numeric)))" } ?? ""
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
        .background(.bar)
        .accessibilityElement(children: .combine)
    }
}

/// The in-app banner for a socket `alert`. Tapping one with an Inbox id opens it.
struct AlertBanner: View {
    @Environment(AppModel.self) private var model

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
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(g.tint.opacity(0.5)))
                .padding(.horizontal, 12)
                .padding(.top, 4)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.primary)
            .transition(.move(edge: .top).combined(with: .opacity))
            .animation(.snappy, value: b.id)
            .accessibilityLabel("\(g.label): \(b.event.title). \(b.event.body)")
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
    }
}
