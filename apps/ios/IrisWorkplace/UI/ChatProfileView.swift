import SwiftUI
import SafariServices

// The chat profile, Telegram's "info" screen (CHAT-NOTIFY-CONTRACT §3, §6.6): who this is, the
// chat's notification switch, and what was shared (Media / Files / Links). Pushed from the chat's
// header. Built from the theme modifiers, so Default reads as an iOS settings page and Sci-fi as
// glass rows; nothing here exists on an older screen.

struct ChatProfileRoute: Hashable {
    let threadId: String
    var isRoom = false
}

// MARK: - Mute

/// The mute choices as menu items: Unmute (when muted), then 1 h / 8 h / 1 day / Forever.
struct MuteMenuItems: View {
    @Environment(AppModel.self) private var model
    let threadId: String
    var isRoom = false

    var body: some View {
        let prefs = model.chatPrefs
        let muted = prefs.isMuted(threadId, isRoom: isRoom)
        if muted {
            Button { set(.unmute) } label: { Label("Unmute", systemImage: "bell") }
                .accessibilityIdentifier("mute.unmute")
        }
        Section(muted ? "Mute for longer" : "Mute notifications") {
            ForEach(MuteOption.muting) { o in
                Button { set(o) } label: { Text(o.title) }
                    .accessibilityIdentifier("mute.\(o.rawValue)")
            }
        }
        if prefs.localOnly {
            Section(ChatPrefsStore.localNote) {}
        }
    }

    private func set(_ o: MuteOption) {
        let rest = model.rest
        Task { try? await model.chatPrefs.set(rest, threadId: threadId, option: o) }
    }
}

/// A small muted mark after a chat's name (Telegram's speaker-off).
struct MutedMark: View {
    var body: some View {
        Image(systemName: "bell.slash.fill")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .accessibilityLabel("Muted")
            .accessibilityIdentifier("chat.muted")
    }
}

// MARK: - The screen

struct ChatProfileView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    let route: ChatProfileRoute

    @State private var detail: EmployeeDetail?
    @State private var shared: ChatSharedStore
    @State private var tab: SharedKind = .media
    @State private var showCharter = false
    @State private var safari: URL?
    @State private var loadError: String?

    init(route: ChatProfileRoute) {
        self.route = route
        _shared = State(initialValue: ChatSharedStore(threadId: route.threadId))
    }

    private var threadId: String { route.threadId }
    private var isCoo: Bool { !route.isRoom && (threadId == "coo" || model.office.card(threadId)?.employee.virtual == true) }

    private var info: ChatProfileInfo {
        if route.isRoom { return ChatProfileInfo.room(model.room.thread(threadId), id: threadId) { model.employeeName($0) } }
        if isCoo { return ChatProfileInfo.coo(presence: model.coo.presence, name: model.office.card(threadId)?.employee.name ?? ChatProfileInfo.cooName) }
        return ChatProfileInfo.employee(id: threadId, detail: detail, card: model.office.card(threadId)) { model.employeeName($0) }
    }

    private var tint: Color { isCoo ? .indigo : .accentColor }

    var body: some View {
        let info = info
        List {
            header(info)
            Group {
                if let about = info.about {
                    Section { Text(about).font(.body) } header: { SectionHeader(text: isCoo ? "About" : route.isRoom ? "About" : "Now") }
                }
                Section {
                    ForEach(info.facts, id: \.self) { f in
                        LabeledContent(f.label, value: f.value)
                            .accessibilityIdentifier("profile.fact.\(f.label)")
                    }
                    if let loadError { Label(loadError, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.red) }
                } header: { SectionHeader(text: "Info") }
                Section {
                    notificationsRow
                    if !isCoo && !route.isRoom {
                        Button { showCharter = true } label: {
                            HStack {
                                Label { Text("Charter, status and handoff").foregroundStyle(.primary) } icon: { Image(systemName: "doc.text").foregroundStyle(theme.palette.accent) }
                                Spacer()
                                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                            }
                        }
                        .tint(.primary)
                        .accessibilityIdentifier("profile.charter")
                    }
                } footer: {
                    if model.chatPrefs.localOnly { Text(ChatPrefsStore.localNote).accessibilityIdentifier("profile.localNote") }
                }
                sharedSection
            }
            .themedRows()
        }
        .themedList()
        .listStyle(.insetGrouped)
        .navigationTitle("Info")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .tabBar)
        .sheet(isPresented: $showCharter) { EmployeeProfileView() }
        .sheet(item: Binding(get: { safari.map(SafariLink.init) }, set: { if $0 == nil { safari = nil } })) { l in SafariView(url: l.url).ignoresSafeArea() }
        .task(id: threadId) { await loadInfo() }
        .onDisappear { if isCoo { model.coo.stopPolling() } }
        .task(id: tab) { await shared.load(model.rest, kind: tab, sources: sources) }
        .accessibilityIdentifier("chat.profile")
    }

    // MARK: header

    private func header(_ info: ChatProfileInfo) -> some View {
        Section {
            VStack(spacing: 10) {
                ZStack(alignment: .bottomTrailing) {
                    if route.isRoom {
                        Image(systemName: "bubble.left.and.bubble.right.fill")
                            .font(.system(size: 38, weight: .semibold)).foregroundStyle(.white)
                            .frame(width: 96, height: 96)
                            .background(LinearGradient(colors: [tint.opacity(0.85), tint], startPoint: .top, endPoint: .bottom), in: Circle())
                            .accessibilityHidden(true)
                    } else {
                        InitialsAvatar(name: info.name, size: 96, tint: tint, vivid: true)
                        PresenceDot(online: info.online).scaleEffect(1.6).offset(x: -6, y: -6)
                    }
                }
                .glow(theme.hasChrome, theme.palette.accent, radius: 14)
                VStack(spacing: 3) {
                    HStack(spacing: 6) {
                        Text(info.name).font(.title2.weight(.semibold)).themedTitle().multilineTextAlignment(.center)
                        if model.chatPrefs.isMuted(threadId, isRoom: route.isRoom) { MutedMark() }
                    }
                    Text(info.subtitle).font(.subheadline).foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("profile.name")
                HStack(spacing: 10) {
                    actionButton("Message", symbol: "bubble.left.fill") { dismiss() }
                        .accessibilityIdentifier("profile.message")
                    Menu { MuteMenuItems(threadId: threadId, isRoom: route.isRoom) } label: {
                        let muted = model.chatPrefs.isMuted(threadId, isRoom: route.isRoom)
                        actionLabel(muted ? "Unmute" : "Mute", symbol: muted ? "bell.slash.fill" : "bell.fill")
                    }
                    .accessibilityIdentifier("profile.mute")
                }
                .padding(.top, 4)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
        }
    }

    private func actionButton(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { actionLabel(title, symbol: symbol) }.buttonStyle(.plain)
    }

    private func actionLabel(_ title: String, symbol: String) -> some View {
        VStack(spacing: 4) {
            Image(systemName: symbol).font(.title3)
            Text(title).font(.caption.weight(.medium))
        }
        .foregroundStyle(theme.palette.accent)
        .frame(width: 96, height: 58)
        .themedCard(radius: 12, fill: Color(.secondarySystemGroupedBackground))
    }

    private var notificationsRow: some View {
        let muted = model.chatPrefs.isMuted(threadId, isRoom: route.isRoom)
        return Menu { MuteMenuItems(threadId: threadId, isRoom: route.isRoom) } label: {
            HStack {
                Label { Text("Notifications").foregroundStyle(.primary) } icon: {
                    Image(systemName: muted ? "bell.slash" : "bell").foregroundStyle(theme.palette.accent)
                }
                Spacer()
                Text(model.chatPrefs.statusText(threadId, isRoom: route.isRoom))
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("profile.notifications.status")
                Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(.tertiary)
            }
        }
        .tint(.primary)
        .accessibilityIdentifier("profile.notifications")
    }

    // MARK: shared

    private var sharedSection: some View {
        let state = shared.state(tab)
        return Section {
            Picker("Shared", selection: $tab) {
                ForEach([SharedKind.media, .files, .links], id: \.self) { k in Text(k.title).tag(k) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("profile.sharedTabs")
            if state.loading && state.items.isEmpty {
                HStack { Spacer(); ProgressView(); Spacer() }
            } else if state.items.isEmpty {
                Text(emptyText).font(.subheadline).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.vertical, 12)
                    .accessibilityIdentifier("profile.shared.empty")
            } else {
                switch tab {
                case .media: SharedMediaGrid(items: state.items)
                case .files: ForEach(state.items) { SharedFileRow(item: $0) }
                case .links: ForEach(state.items) { item in SharedLinkRow(item: item) { safari = $0 } }
                case .unknown: EmptyView()
                }
                if state.hasMore {
                    Button(state.loading ? "Loading…" : "Load more") { Task { await shared.loadMore(model.rest, kind: tab) } }
                        .disabled(state.loading)
                }
            }
            if let e = state.error { Label(e, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.orange) }
        } header: {
            SectionHeader(text: "Shared")
        } footer: {
            if state.derived && state.loaded { Text("Showing recent").accessibilityIdentifier("profile.shared.recent") }
        }
    }

    private var emptyText: String {
        switch tab {
        case .media: return "No photos or videos yet"
        case .files: return "No files yet"
        default: return "No links yet"
        }
    }

    /// The messages this phone has for the chat (the route's fallback).
    private func sources() -> [SharedSource] {
        if route.isRoom { return (model.room.messages[threadId] ?? []).map(SharedSource.init(room:)) }
        if let talk = model.talkThreads.messages[threadId], !talk.isEmpty { return talk.map(SharedSource.init(talk:)) }
        if isCoo { return model.coo.log.map(SharedSource.init(coo:)) }
        return model.talk.employeeId == threadId ? model.talk.log.map(SharedSource.init(log:)) : []
    }

    private func loadInfo() async {
        guard let rest = model.rest else { return }
        if route.isRoom {
            if model.room.messages[threadId] == nil { await model.room.loadThread(rest, id: threadId) }
        } else if isCoo {
            model.coo.pollPresence(rest)
        } else {
            do { detail = try await rest.employee(threadId); loadError = nil }
            catch { if model.office.card(threadId) == nil { loadError = error.userMessage } }
        }
    }
}

// MARK: - Shared rows

/// Photos and videos, three to a row; a tap opens the file full screen (QuickLook: zoom, play, share).
struct SharedMediaGrid: View {
    let items: [SharedItem]
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 3), count: 3)

    var body: some View {
        LazyVGrid(columns: columns, spacing: 3) {
            ForEach(items) { SharedThumb(item: $0) }
        }
        .listRowInsets(EdgeInsets(top: 6, leading: 6, bottom: 6, trailing: 6))
    }
}

extension SharedItem {
    var chatAttachment: ChatAttachment {
        ChatAttachment(id: attachmentId ?? id, kind: kind == .media ? .image : .file, name: name ?? "file",
                       mediaType: mime ?? "application/octet-stream", size: size, path: attachmentPath)
    }
}

struct SharedThumb: View {
    @Environment(AppModel.self) private var model
    let item: SharedItem
    @State private var image: UIImage?
    @State private var file: URL?
    @State private var preview: URL?
    @State private var failed = false

    private var isVideo: Bool { (item.mime ?? "").hasPrefix("video/") }

    var body: some View {
        Color(.tertiarySystemFill)
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                if let image {
                    Image(uiImage: image).resizable().scaledToFill()
                } else if failed || isVideo && file != nil {
                    Image(systemName: isVideo ? "film" : "photo").font(.title2).foregroundStyle(.secondary)
                } else {
                    ProgressView()
                }
            }
            .overlay(alignment: .bottomLeading) {
                if isVideo { Image(systemName: "play.fill").font(.caption).foregroundStyle(.white).padding(5).shadow(radius: 2) }
            }
            .clipped()
            .contentShape(Rectangle())
            .onTapGesture { if let file { preview = file } }
            .quickLookPreview($preview)
            .accessibilityLabel("\(isVideo ? "Video" : "Photo") \(item.name ?? "")")
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("profile.media")
            .task(id: item.id) {
                do {
                    let url = try await model.attachments.url(for: item.chatAttachment)
                    file = url
                    if !isVideo {
                        image = await Task.detached { UIImage(contentsOfFile: url.path)?.preparingThumbnail(of: CGSize(width: 360, height: 360)) }.value
                        failed = image == nil
                    }
                } catch { failed = true }
            }
    }
}

struct SharedFileRow: View {
    @Environment(AppModel.self) private var model
    let item: SharedItem
    @State private var preview: URL?
    @State private var loading = false
    @State private var error: String?

    private var symbol: String {
        let t = item.mime ?? ""
        if t.contains("pdf") { return "doc.richtext" }
        if t.hasPrefix("text/") || t.contains("json") || t.contains("markdown") { return "doc.text" }
        if t.contains("zip") { return "doc.zipper" }
        return "doc"
    }

    var body: some View {
        Button { Task { await open() } } label: {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8).fill(Color.accentColor.opacity(0.12))
                    if loading { ProgressView().controlSize(.small) } else { Image(systemName: symbol).foregroundStyle(Color.accentColor) }
                }
                .frame(width: 40, height: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.name ?? "File").font(.subheadline.weight(.medium)).foregroundStyle(.primary).lineLimit(1).truncationMode(.middle)
                    Text(error ?? subtitle).font(.caption).foregroundStyle(error == nil ? Color.secondary : Color.red).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
        }
        .buttonStyle(.plain)
        .quickLookPreview($preview)
        .accessibilityIdentifier("profile.file")
    }

    private var subtitle: String {
        var parts: [String] = []
        if let s = item.size { parts.append(ByteCountFormatter.string(fromByteCount: Int64(s), countStyle: .file)) }
        parts.append(Format.ago(item.at))
        return parts.joined(separator: " · ")
    }

    private func open() async {
        loading = true; error = nil
        defer { loading = false }
        do { preview = try await model.attachments.url(for: item.chatAttachment) } catch { self.error = error.userMessage }
    }
}

struct SharedLinkRow: View {
    let item: SharedItem
    let open: (URL) -> Void

    private var host: String { item.url.map(SharedDerivation.host) ?? "" }

    var body: some View {
        Button { if let u = item.url.flatMap(URL.init(string:)) { open(u) } } label: {
            HStack(spacing: 12) {
                Text(String(host.prefix(1)).uppercased())
                    .font(.headline).foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(LinearGradient(colors: [AvatarPalette.colors(for: host).0, AvatarPalette.colors(for: host).1],
                                               startPoint: .top, endPoint: .bottom), in: RoundedRectangle(cornerRadius: 8))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.name ?? host).font(.subheadline.weight(.medium)).foregroundStyle(.primary).lineLimit(1)
                    Text(item.url ?? "").font(.caption).foregroundStyle(Color.accentColor).lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: 0)
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("profile.link")
    }
}

struct SafariLink: Identifiable { let url: URL; var id: URL { url } }

/// In-app Safari for a shared link (Done returns to the profile).
struct SafariView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ vc: SFSafariViewController, context: Context) {}
}
