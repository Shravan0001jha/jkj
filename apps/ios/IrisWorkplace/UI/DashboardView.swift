import SwiftUI

/// The mini dashboard (HLD-dashboard §7, app side): features with their health, and the top three
/// gap causes. Always shows what the phone has — the cached snapshot with its age — and refreshes
/// on its own (launch, foreground, background refresh); there is nothing to pull or tap to reload.
struct DashboardView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let store = model.dashboard
        NavigationStack {
            DashboardContent(snapshot: store.snapshot, availability: store.availability,
                             error: store.error, loading: store.loading || model.rest == nil)
                .navigationTitle("Dashboard")
                .navigationDestination(for: DashFeatureRoute.self) { r in
                    if let f = store.snapshot?.features.first(where: { $0.id == r.id }) {
                        DashFeatureDetail(feature: f)
                    } else {
                        EmptyState(symbol: "questionmark.circle", title: "Feature not in this snapshot",
                                   text: "It was in an older copy of the dashboard.")
                    }
                }
                .safeAreaInset(edge: .top, spacing: 0) { ConnectionStrip() }
        }
    }
}

struct DashFeatureRoute: Hashable { let id: String }

/// The Dashboard tab: the dashboard and Updates, one segmented switch apart (see `Tab`).
struct DashboardTab: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var router = model.router
        let unseen = model.updates.unseen
        VStack(spacing: 0) {
            Picker("Show", selection: $router.tab) {
                Text("Dashboard").tag(Tab.dashboard)
                Text(unseen > 0 ? "Updates (\(unseen))" : "Updates").tag(Tab.updates)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .themedBar(Color(.systemGroupedBackground))
            if router.tab == .updates { UpdatesView() } else { DashboardView() }
        }
    }
}

/// The screen's content for a given state, separate from the model so previews can show every state.
struct DashboardContent: View {
    let snapshot: DashboardSnapshot?
    let availability: DashAvailability
    let error: String?
    let loading: Bool

    var body: some View {
        List { Group {
            if let snapshot {
                Section { status(snapshot) }
                ForEach(Self.groups(snapshot.features), id: \.title) { g in
                    Section {
                        ForEach(g.features) { f in
                            NavigationLink(value: DashFeatureRoute(id: f.id)) { DashFeatureRow(feature: f) }
                        }
                    } header: { SectionHeader(text: g.title) }
                }
                if snapshot.features.isEmpty {
                    Section { Text("No features in this snapshot.").foregroundStyle(.secondary) }
                }
                gaps(snapshot)
            } else if availability == .notYet {
                notYet
            } else if let error, !loading {
                EmptyState(symbol: "chart.bar.xaxis", title: "No dashboard on this phone yet",
                           text: "\(error)\nIt loads on its own when the Workplace answers.")
            } else {
                HStack { Spacer(); ProgressView("Loading dashboard…"); Spacer() }
                    .listRowBackground(Color.clear)
            }
        }.themedRows() }
        .themedList()
        .listStyle(.insetGrouped)
    }

    private var notYet: some View {
        EmptyState(symbol: "chart.bar.xaxis", title: "Dashboard data not available yet",
                   text: "The Workplace does not publish the dashboard yet. It shows here on its own once it does.")
    }

    /// Age first (it always shows), then why it may be old.
    @ViewBuilder private func status(_ s: DashboardSnapshot) -> some View {
        TimelineView(.periodic(from: .now, by: 60)) { ctx in
            let stale = DashboardStore.isStale(s.generatedAt, now: ctx.date)
            Label(DashboardStore.updatedText(s.generatedAt, now: ctx.date),
                  systemImage: stale ? "clock.badge.exclamationmark" : "clock")
                .font(.subheadline)
                .foregroundStyle(stale ? Color.orange : Color.secondary)
        }
        if availability == .notYet {
            Label("Dashboard data not available yet — showing the last copy on this phone.", systemImage: "info.circle")
                .font(.footnote).foregroundStyle(.secondary)
        } else if let error {
            Label("Couldn't refresh: \(error)", systemImage: "wifi.exclamationmark")
                .font(.footnote).foregroundStyle(.secondary).lineLimit(2)
        }
    }

    @ViewBuilder private func gaps(_ s: DashboardSnapshot) -> some View {
        let top = s.topGaps
        Section {
            if top.isEmpty {
                Text("No lost days recorded.").foregroundStyle(.secondary)
            }
            let maxDays = top.map(\.days).max() ?? 1
            ForEach(Array(top.enumerated()), id: \.offset) { i, g in
                DashGapRow(rank: i + 1, gap: g, fraction: maxDays > 0 ? g.days / maxDays : 0)
            }
        } header: {
            SectionHeader(text: "Gaps · lost days, last \(Self.window(s.gaps?.window))")
        } footer: {
            if let u = s.unknownShare, u > 0 {
                Text("\(Int((u * 100).rounded()))% of waiting time could not be classified.")
            }
        }
    }

    /// "30d" → "30 days".
    static func window(_ w: String?) -> String {
        guard let w, w.hasSuffix("d"), let n = Int(w.dropLast()) else { return w ?? "30 days" }
        return "\(n) days"
    }

    /// In progress first (late, then at risk, then on track), then planned, then delivered.
    static func groups(_ features: [DashFeature]) -> [(title: String, features: [DashFeature])] {
        let rank: (DashFeature) -> Int = { f in
            switch f.health { case .late?: return 0; case .atRisk?: return 1; default: return 2 }
        }
        let inProgress = features.filter { $0.state == .inProgress || $0.state == .unknown || $0.state == nil }
            .enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map(\.element)
        return [("In progress", inProgress),
                ("Planned", features.filter { $0.state == .planned }),
                ("Delivered", features.filter { $0.state == .delivered })]
            .filter { !$0.1.isEmpty }
    }
}

struct DashFeatureRow: View {
    let feature: DashFeature

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(feature.name).font(.headline).lineLimit(2)
                Spacer(minLength: 8)
                if let h = feature.health { DashHealthPill(health: h) }
            }
            Text(DashDate.datesLine(feature)).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
            if let r = feature.healthReason, !r.isEmpty {
                Text(r).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

struct DashHealthPill: View {
    let health: DashHealth
    var body: some View {
        let g = health.glyph
        Pill(text: g.label, symbol: g.symbol, tint: g.tint).accessibilityLabel("Health: \(g.label)")
    }
}

extension DashHealth {
    var glyph: Glyph {
        switch self {
        case .onTrack: return Glyph(symbol: "checkmark.circle.fill", tint: .green, label: "On track")
        case .atRisk: return Glyph(symbol: "exclamationmark.triangle.fill", tint: .orange, label: "At risk")
        case .late: return Glyph(symbol: "clock.badge.exclamationmark.fill", tint: .red, label: "Late")
        case .unknown: return Glyph(symbol: "questionmark.circle", tint: .secondary, label: "Unknown")
        }
    }
}

extension DashScopeStatus {
    var glyph: Glyph {
        switch self {
        case .notStarted: return Glyph(symbol: "circle", tint: .secondary, label: "Not started")
        case .building: return Glyph(symbol: "hammer.circle", tint: .blue, label: "Building")
        case .merged: return Glyph(symbol: "arrow.triangle.merge", tint: .purple, label: "Merged")
        case .staging: return Glyph(symbol: "shippingbox.circle", tint: .orange, label: "On staging")
        case .verified: return Glyph(symbol: "checkmark.circle.fill", tint: .green, label: "Verified")
        case .unknown: return Glyph(symbol: "questionmark.circle", tint: .secondary, label: "Unknown")
        }
    }
}

struct DashGapRow: View {
    let rank: Int
    let gap: DashLostCause
    let fraction: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("\(rank). \(DashboardSnapshot.causeLabel(gap.cause))").font(.subheadline.weight(.medium))
                Spacer()
                Text(DashDate.days(gap.days)).font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color(.tertiarySystemFill))
                    Capsule().fill(Color.orange).frame(width: max(4, geo.size.width * min(1, max(0, fraction))))
                }
            }
            .frame(height: 5)
            .accessibilityHidden(true)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// A feature: its dates, its scope checklist and every date change with its reason.
struct DashFeatureDetail: View {
    let feature: DashFeature

    var body: some View {
        List { Group {
            Section {
                if let h = feature.health {
                    HStack(alignment: .firstTextBaseline) {
                        DashHealthPill(health: h)
                        if let r = feature.healthReason, !r.isEmpty { Text(r).font(.subheadline) }
                    }
                }
                row("Committed", DashDate.short(feature.committedDate))
                if let f = feature.forecast, f.p50 != nil || f.p90 != nil { row("Forecast", DashDate.forecast(f)) }
                if let o = feature.originalDate, o != feature.committedDate { row("First promised", DashDate.short(o)) }
                if let s = feature.startedAt { row("Started", DashDate.short(s)) }
                if let d = feature.deliveredAt { row("Delivered", DashDate.short(d)) }
                if let c = feature.costInr, c > 0 { row("Cost", Format.inr(c)) }
                if let e = feature.escapes, e > 0 { row("Bugs that escaped", "\(e)") }
            }
            Section {
                if feature.scope.isEmpty { Text("No scope recorded yet.").foregroundStyle(.secondary) }
                ForEach(Array(feature.scope.enumerated()), id: \.offset) { _, item in
                    let g = (item.status ?? .unknown).glyph
                    HStack(spacing: 10) {
                        Image(systemName: g.symbol).foregroundStyle(g.tint).frame(width: 22)
                        Text(item.label.isEmpty ? "—" : item.label)
                        Spacer(minLength: 8)
                        Text(g.label).font(.caption).foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            } header: {
                SectionHeader(text: "Scope · \(feature.scope.filter { $0.status == .verified }.count) of \(feature.scope.count) verified")
            }
            Section {
                if feature.dateHistory.isEmpty { Text("The date has not moved.").foregroundStyle(.secondary) }
                ForEach(Array(feature.dateHistory.enumerated().reversed()), id: \.offset) { _, c in
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(DashDate.short(c.from)) → \(DashDate.short(c.to))").font(.subheadline.weight(.medium))
                        if let r = c.reason, !r.isEmpty { Text(r).font(.subheadline) }
                        let who = c.approvedBy.map { "Approved by \($0 == "owner" ? "you" : $0)" }
                        let when = c.at.map { DashDate.short($0) }
                        let meta = [who, when].compactMap { $0 }.joined(separator: " · ")
                        if !meta.isEmpty { Text(meta).font(.caption).foregroundStyle(.secondary) }
                    }
                    .padding(.vertical, 2)
                    .accessibilityElement(children: .combine)
                }
            } header: { SectionHeader(text: "Date history") }
            if let lost = feature.lostDays, !lost.isEmpty {
                Section {
                    ForEach(lost.sorted { $0.value > $1.value }, id: \.key) { k, v in
                        row(DashboardSnapshot.causeLabel(k), DashDate.days(v))
                    }
                } header: { SectionHeader(text: "Lost days") }
            }
        }.themedRows() }
        .themedList()
        .listStyle(.insetGrouped)
        .navigationTitle(feature.name)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ label: String, _ value: String) -> some View {
        LabeledContent(label, value: value).font(.subheadline)
    }
}

/// Snapshot dates: `YYYY-MM-DD` (committed, forecast) or full ISO times, shown as "6 Nov".
enum DashDate {
    private static let dayOnly: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func parse(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        return dayOnly.date(from: s) ?? Format.date(s)
    }

    static func short(_ s: String?) -> String {
        guard let s else { return "—" }
        guard let d = parse(s) else { return s }
        return d.formatted(.dateTime.day().month(.abbreviated))
    }

    /// "6–8 Nov", "30 Nov – 2 Dec", or one date when both agree.
    static func forecast(_ f: DashForecast) -> String {
        guard let a = parse(f.p50) ?? parse(f.p90) else { return short(f.p50 ?? f.p90) }
        guard let b = parse(f.p90), b > a else { return short(f.p50 ?? f.p90) }
        let cal = Calendar.current
        if cal.isDate(a, equalTo: b, toGranularity: .month) {
            return "\(cal.component(.day, from: a))–\(b.formatted(.dateTime.day().month(.abbreviated)))"
        }
        return "\(short(f.p50)) – \(short(f.p90))"
    }

    /// The row's second line: "Due 6 Nov · forecast 6–8 Nov", or "Delivered 21 Oct".
    static func datesLine(_ f: DashFeature) -> String {
        if f.state == .delivered, let d = f.deliveredAt { return "Delivered \(short(d))" }
        var parts: [String] = []
        if let c = f.committedDate { parts.append("Due \(short(c))") }
        if let fc = f.forecast, fc.p50 != nil || fc.p90 != nil { parts.append("forecast \(forecast(fc))") }
        return parts.isEmpty ? "No date yet" : parts.joined(separator: " · ")
    }

    /// 6.5 → "6.5 d", 2 → "2 d".
    static func days(_ v: Double) -> String {
        let r = (v * 10).rounded() / 10
        return r == r.rounded() ? "\(Int(r)) d" : String(format: "%.1f d", r)
    }
}

#if DEBUG
#Preview("Dashboard") {
    NavigationStack {
        DashboardContent(snapshot: .preview, availability: .available, error: nil, loading: false)
            .navigationTitle("Dashboard")
            .navigationDestination(for: DashFeatureRoute.self) { r in
                DashFeatureDetail(feature: DashboardSnapshot.preview.features.first { $0.id == r.id }!)
            }
    }
}

#Preview("Not available yet, cached copy") {
    NavigationStack {
        DashboardContent(snapshot: .preview, availability: .notYet, error: nil, loading: false).navigationTitle("Dashboard")
    }
}

#Preview("Not available yet, nothing cached") {
    DashboardContent(snapshot: nil, availability: .notYet, error: nil, loading: false)
}

#Preview("Feature") {
    NavigationStack { DashFeatureDetail(feature: DashboardSnapshot.preview.features[2]) }
}
#endif
