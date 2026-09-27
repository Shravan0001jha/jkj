import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var router = model.router
        Group {
            if !model.isPaired {
                PairingView()
            } else if model.connection == .unauthorized {
                UnauthorizedView()
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
                    FeaturesView()
                        .tabItem { Label("Features", systemImage: "square.grid.2x2") }
                        .tag(Tab.features)
                    AlertsView()
                        .tabItem { Label("Alerts", systemImage: "bell") }
                        .badge(model.alerts.unread)
                        .tag(Tab.alerts)
                }
                .overlay(alignment: .top) { AlertBanner() }
                .sheet(isPresented: $router.showSettings) { SettingsView() }
            }
        }
    }
}

/// A slim strip under the navigation bar while the socket is not open.
struct ConnectionStrip: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.connection {
        case .online, .unpaired, .unauthorized:
            EmptyView()
        case .connecting:
            strip("Connecting…", symbol: "antenna.radiowaves.left.and.right", tint: .secondary)
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
                if let id = b.event.inboxId { model.router.openInbox(id) } else { model.router.tab = .alerts }
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

struct UnauthorizedView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "key.slash").font(.system(size: 44)).foregroundStyle(.orange)
            Text("This phone is no longer paired").font(.title3.weight(.semibold))
            Text("The Workplace refused the token. Pair again with a new code from the Mac.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary)
            Button("Re-pair") { model.unpair() }.buttonStyle(.borderedProminent)
        }
        .padding(24)
    }
}
