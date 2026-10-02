import SwiftUI

/// Newest-first one-line events: started, shipped, blocked, unblocked, decided, the brief and the
/// weekly review. Tapping one opens what it is about.
struct UpdatesView: View {
    @Environment(AppModel.self) private var model
    @State private var path = NavigationPath()

    private var store: UpdatesStore { model.updates }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if let e = store.error, !store.loaded {
                    ErrorRow(message: e) { Task { await reload() } }
                } else if !store.loaded {
                    HStack { Spacer(); ProgressView("Loading updates…"); Spacer() }
                }
                if store.loaded && store.updates.isEmpty {
                    EmptyState(symbol: "bolt.horizontal", title: "No updates yet",
                               text: "When work starts, ships, gets blocked or a decision lands, it shows here in one line.")
                }
                ForEach(groups, id: \.day) { g in
                    Section {
                        ForEach(g.updates) { u in UpdateRow(update: u) { open(u) } }
                    } header: { SectionHeader(text: g.day) }
                }
                if store.hasMore && store.loaded && !store.updates.isEmpty {
                    HStack { Spacer(); ProgressView(); Spacer() }
                        .task { if let rest = model.rest { await store.loadMore(rest) } }
                }
                if let e = store.error, store.loaded { Section { ErrorRow(message: e) { Task { await reload() } } } }
            }
            .listStyle(.insetGrouped)
            .refreshable { await reload() }
            .navigationTitle("Updates")
            .v2Destinations()
            .safeAreaInset(edge: .top, spacing: 0) { ConnectionStrip() }
            .task { if !store.loaded { await reload() } }
            .onAppear { store.markSeen() }
            .onChange(of: store.unseen) { _, n in if n > 0, model.router.tab == .updates { store.markSeen() } }
        }
    }

    /// Today / Yesterday / "30 Sep" headers over the newest-first list.
    private var groups: [(day: String, updates: [Update])] {
        var out: [(day: String, updates: [Update])] = []
        for u in store.updates {
            let day = Self.day(u.at)
            if out.last?.day == day { out[out.count - 1].updates.append(u) } else { out.append((day, [u])) }
        }
        return out
    }

    static func day(_ iso: String) -> String {
        guard let d = Format.date(iso) else { return "Earlier" }
        if Calendar.current.isDateInToday(d) { return "Today" }
        if Calendar.current.isDateInYesterday(d) { return "Yesterday" }
        return d.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
    }

    private func reload() async {
        guard let rest = model.rest else { return }
        await store.load(rest)
        if model.office.data == nil { await model.office.load(rest) }
    }

    /// `href` is an app route (LLD §19.8): item/<id>, inbox/<id>, room/<threadId>, releases/<postId>, plan.
    private func open(_ u: Update) {
        switch AppLink.parse(u.href) {
        case .item(let id)?: path.append(ItemRoute(id: id))
        case .releasePost(let id)?: path.append(ReleasePostRoute(id: id))
        case .room(let id)?: path.append(ThreadRoute(id: id))
        case .inbox(let id, _)?: model.router.openInbox(id)
        case .plan?: model.router.tab = .plan
        default:
            if let id = u.itemId { path.append(ItemRoute(id: id)) } else if let id = u.inboxId { model.router.openInbox(id) }
        }
    }
}

/// One event: kind glyph and colour, the line (names, never a bare count), who and when. A brief
/// or review carries details: they expand in place, and "Open" goes where the href points.
struct UpdateRow: View {
    @Environment(AppModel.self) private var model
    let update: Update
    let open: () -> Void
    @State private var expanded = false

    var body: some View {
        let g = update.kind.glyph
        VStack(alignment: .leading, spacing: 6) {
            Button {
                if update.details != nil && update.itemId == nil && update.inboxId == nil { withAnimation(.snappy) { expanded.toggle() } } else { open() }
            } label: {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: g.symbol).foregroundStyle(g.tint).font(.body).frame(width: 24)
                        .accessibilityLabel(g.label)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(update.line).font(.subheadline).lineLimit(expanded ? nil : 2).multilineTextAlignment(.leading)
                        HStack(spacing: 4) {
                            Text(g.label).foregroundStyle(g.tint)
                            Text("·")
                            Text(model.employeeName(update.by))
                            Text("·")
                            Text(Format.time(update.at))
                            if update.push { Image(systemName: "bell.fill").font(.caption2).accessibilityLabel("pushed") }
                        }
                        .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: update.details != nil && update.itemId == nil && update.inboxId == nil ? (expanded ? "chevron.up" : "chevron.down") : "chevron.right")
                        .font(.caption).foregroundStyle(.tertiary).padding(.top, 3)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded, let d = update.details {
                Prose(text: d).font(.caption).padding(.leading, 34)
                if update.href != "plan" { Button("Open", action: open).font(.caption.weight(.semibold)).padding(.leading, 34) }
            }
        }
        .accessibilityIdentifier("update.\(update.id)")
    }
}

// MARK: - Releases

/// The Releases room: each release as a post, newest first.
struct ReleasePostsView: View {
    @Environment(AppModel.self) private var model
    private var store: ReleasePostsStore { model.releasePosts }

    var body: some View {
        List {
            if let e = store.error, !store.loaded { ErrorRow(message: e) { Task { await reload() } } }
            else if !store.loaded { HStack { Spacer(); ProgressView(); Spacer() } }
            if store.loaded && store.posts.isEmpty {
                EmptyState(symbol: "shippingbox", title: "No releases posted yet",
                           text: "Each release posts here with every story and fix that shipped in it, grouped by area.")
            }
            ForEach(store.posts) { p in
                NavigationLink(value: ReleasePostRoute(id: p.id)) {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(p.title).font(.headline).lineLimit(2)
                            Spacer()
                            Pill(text: p.version, symbol: "shippingbox", tint: .brown)
                        }
                        let n = p.groups.reduce(0) { $0 + $1.items.count }
                        Text("\(n) change\(n == 1 ? "" : "s") · \(p.groups.map(\.areaTitle).joined(separator: ", "))").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        Text("\(Format.ago(p.at)) · \(model.employeeName(p.by))").font(.caption2).foregroundStyle(.tertiary)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await reload() }
        .navigationTitle("Releases")
        .navigationBarTitleDisplayMode(.inline)
        .task { if !store.loaded { await reload() } }
    }

    private func reload() async { if let rest = model.rest { await store.load(rest) } }
}

/// One release: what shipped, grouped by area; tapping a change opens its story.
struct ReleasePostView: View {
    @Environment(AppModel.self) private var model
    let id: String
    @State private var loaded: ReleasePost?
    @State private var error: String?

    private var post: ReleasePost? { model.releasePosts.post(id) ?? loaded }

    var body: some View {
        List {
            if let p = post {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(p.title).font(.title3.weight(.semibold))
                        HStack(spacing: 6) {
                            Pill(text: p.version, symbol: "shippingbox", tint: .brown)
                            if let s = p.shippable { Pill(text: s, tint: .secondary) }
                        }
                        Text("\(Format.ago(p.at)) · posted by \(model.employeeName(p.by))").font(.caption).foregroundStyle(.secondary)
                        if !p.text.isEmpty { Text(p.text).font(.subheadline) }
                    }
                    .padding(.vertical, 4)
                }
                ForEach(Array(p.groups.enumerated()), id: \.offset) { _, g in
                    Section {
                        ForEach(g.items) { i in
                            NavigationLink(value: ItemRoute(id: i.id)) {
                                HStack(spacing: 8) {
                                    Pill(text: i.kind == .fix ? "Fix" : "Story", tint: i.kind == .fix ? .orange : .green)
                                    Text(i.title).font(.subheadline).lineLimit(2)
                                }
                            }
                        }
                    } header: { SectionHeader(text: g.areaTitle) }
                }
                Section { NavigationLink(value: ThreadRoute(id: p.threadId)) { Label("Ask what changed", systemImage: "bubble.left.and.text.bubble.right") } }
            } else if let error {
                ErrorRow(message: error) { Task { await load() } }
            } else {
                HStack { Spacer(); ProgressView(); Spacer() }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(post?.version ?? "Release")
        .navigationBarTitleDisplayMode(.inline)
        .task { if post == nil { await load() } }
    }

    private func load() async {
        guard let rest = model.rest else { return }
        do { loaded = try await rest.releasePost(id); error = nil } catch { if let m = error.userMessage { self.error = m } }
    }
}
