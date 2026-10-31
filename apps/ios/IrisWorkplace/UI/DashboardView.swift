import Charts
import SwiftUI

/// The mini dashboard: the same snapshot as https://dash.irisforu.com, compact and graphical.
/// Tiles, a products grid, delivery and bug trends, and where the Workplace waits. Always shows what
/// the phone has — the cached snapshot with its age — and refreshes on its own (launch, foreground,
/// background refresh); there is nothing to pull or tap to reload.
struct DashboardView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let store = model.dashboard
        NavigationStack {
            DashboardContent(snapshot: store.snapshot, availability: store.availability,
                             error: store.error, loading: store.loading || model.rest == nil)
                .navigationTitle("Dashboard")
                // Inline: the segmented switch above already names the pane; small phones keep the room for charts.
                .navigationBarTitleDisplayMode(.inline)
                .navigationDestination(for: DashProductRoute.self) { r in
                    if let s = store.snapshot, let p = s.products.first(where: { $0.id == r.id }) {
                        DashProductDetail(product: p, weeks: s.trends.weeks)
                    } else {
                        EmptyState(symbol: "questionmark.circle", title: "Not in this snapshot",
                                   text: "It was in an older copy of the dashboard.")
                    }
                }
                .safeAreaInset(edge: .top, spacing: 0) { ConnectionStrip() }
        }
    }
}

struct DashProductRoute: Hashable { let id: String }

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
            .background(Color(.systemGroupedBackground))
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
        Group {
            if let snapshot {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        status(snapshot)
                        DashTiles(snapshot: snapshot)
                        DashSection(title: "Products") { DashProductGrid(snapshot: snapshot) }
                        DashSection(title: "Trends") { DashTrendCharts(snapshot: snapshot) }
                        DashSection(title: "Workplace") { DashWorkplace(snapshot: snapshot) }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 24)
                }
            } else if availability == .notYet {
                EmptyState(symbol: "chart.bar.xaxis", title: "Dashboard data not available yet",
                           text: "The Workplace does not publish the dashboard yet. It shows here on its own once it does.")
            } else if let error, !loading {
                EmptyState(symbol: "chart.bar.xaxis", title: "No dashboard on this phone yet",
                           text: "\(error)\nIt loads on its own when the Workplace answers.")
            } else {
                ProgressView("Loading dashboard…").frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
    }

    /// Age first (it always shows), then why it may be old.
    @ViewBuilder private func status(_ s: DashboardSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            TimelineView(.periodic(from: .now, by: 60)) { ctx in
                let stale = DashboardStore.isStale(s.generatedAt, now: ctx.date)
                Label(DashboardStore.updatedText(s.generatedAt, now: ctx.date),
                      systemImage: stale ? "clock.badge.exclamationmark" : "clock")
                    .font(.footnote)
                    .foregroundStyle(stale ? Color.orange : Color.secondary)
            }
            if availability == .notYet {
                Label("Not published yet — showing the last copy on this phone", systemImage: "info.circle")
                    .font(.caption).foregroundStyle(.secondary)
            } else if let error {
                Label("Couldn't refresh: \(error)", systemImage: "wifi.exclamationmark")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.top, 4)
    }
}

// MARK: - Building blocks

/// A titled group of cards.
struct DashSection<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.title3.weight(.semibold)).accessibilityAddTraits(.isHeader)
            content
        }
    }
}

/// The app's card: a rounded tile on the grouped background.
struct DashCard<Content: View>: View {
    var title: String? = nil
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title { Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary) }
            content
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

// MARK: - Top row

struct DashTiles: View {
    let snapshot: DashboardSnapshot

    var body: some View {
        let pc = snapshot.productsComplete
        let dw = snapshot.deliveredThisWeek
        let bugs = snapshot.bugsOpen
        HStack(alignment: .top, spacing: 8) {
            DashTile(symbol: "checkmark.seal.fill", tint: .blue, value: "\(pc.done)/\(pc.total)", caption: "products done",
                     badge: nil)
                .accessibilityLabel("\(pc.done) of \(pc.total) products complete")
                .accessibilityIdentifier("dash.tile.products")
            DashTile(symbol: "shippingbox.fill", tint: .green, value: dw.map { DashNum.count($0.value) } ?? "—",
                     caption: "delivered this week", badge: dw?.change.map(DashTileBadge.change))
                .accessibilityLabel(dw.map { "\(DashNum.count($0.value)) stories delivered this week\($0.change.map { ", \(DashNum.signed($0)) on last week" } ?? "")" } ?? "No deliveries recorded")
                .accessibilityIdentifier("dash.tile.delivered")
            DashTile(symbol: "ladybug.fill", tint: .orange, value: bugs.map { DashNum.count($0.value) } ?? "—",
                     caption: "open bugs", badge: bugs.map { DashTileBadge.direction($0.direction) })
                .accessibilityLabel(bugs.map { "\(DashNum.count($0.value)) open bugs, \(DashTileBadge.word($0.direction))" } ?? "No bug data")
                .accessibilityIdentifier("dash.tile.bugs")
        }
    }
}

/// A small coloured note under a tile's number: "+24" or a rising/falling arrow.
struct DashTileBadge {
    let symbol: String
    let text: String?
    let tint: Color

    /// Deliveries: more is good.
    static func change(_ d: Double) -> DashTileBadge {
        DashTileBadge(symbol: d > 0 ? "arrow.up.right" : d < 0 ? "arrow.down.right" : "equal",
                      text: DashNum.signed(d), tint: d > 0 ? .green : d < 0 ? .orange : .secondary)
    }

    /// Open bugs: rising is bad.
    static func direction(_ d: DashDirection) -> DashTileBadge {
        switch d {
        case .rising: return DashTileBadge(symbol: "arrow.up", text: "rising", tint: .red)
        case .falling: return DashTileBadge(symbol: "arrow.down", text: "falling", tint: .green)
        case .flat: return DashTileBadge(symbol: "equal", text: "flat", tint: .secondary)
        }
    }

    static func word(_ d: DashDirection) -> String {
        switch d { case .rising: return "rising"; case .falling: return "falling"; case .flat: return "flat" }
    }
}

struct DashTile: View {
    let symbol: String
    let tint: Color
    let value: String
    let caption: String
    let badge: DashTileBadge?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(systemName: symbol).font(.subheadline).foregroundStyle(tint)
            Text(value).font(.title2.weight(.bold)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.6)
            Text(caption).font(.caption).foregroundStyle(.secondary).lineLimit(2, reservesSpace: true)
            if let badge {
                HStack(spacing: 2) {
                    Image(systemName: badge.symbol)
                    if let t = badge.text { Text(t) }
                }
                .font(.caption2.weight(.semibold))
                .foregroundStyle(badge.tint)
                .lineLimit(1)
            } else {
                Text(" ").font(.caption2)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .ignore)
    }
}

// MARK: - Products

struct DashProductGrid: View {
    let snapshot: DashboardSnapshot

    var body: some View {
        if snapshot.products.isEmpty {
            DashCard { Text("No products in this snapshot.").font(.subheadline).foregroundStyle(.secondary) }
        } else {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                ForEach(snapshot.products) { p in
                    NavigationLink(value: DashProductRoute(id: p.id)) { DashProductCard(product: p) }
                        .buttonStyle(.plain)
                }
            }
        }
    }
}

struct DashProductCard: View {
    let product: DashProduct

    var body: some View {
        let health = product.health ?? .unknown
        VStack(alignment: .leading, spacing: 8) {
            Text(product.name).font(.subheadline.weight(.semibold)).lineLimit(2, reservesSpace: true)
                .multilineTextAlignment(.leading)
            HStack(spacing: 8) {
                DashRing(done: product.done, total: product.total, tint: health.glyph.tint)
                    .frame(width: 44, height: 44)
                DashBurnupChart(burnup: product.burnup, weeks: [], tint: health.glyph.tint, compact: true)
                    .frame(height: 44)
            }
            DashHealthPill(health: health)
            VStack(alignment: .leading, spacing: 1) {
                Text("Due \(DashDate.short(product.committedDate))")
                Text("ETA \(DashDate.short(product.forecast?.p50))")
            }
            .font(.caption).foregroundStyle(.secondary).monospacedDigit()
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(product.name), \(health.glyph.label), \(product.done) of \(product.total) stories done, due \(DashDate.short(product.committedDate)), forecast \(DashDate.short(product.forecast?.p50))")
        .accessibilityAddTraits(.isButton)
    }
}

/// done / total as a ring, the count inside.
struct DashRing: View {
    let done: Int
    let total: Int
    var tint: Color = .accentColor
    var lineWidth: CGFloat = 5
    var font: Font = .caption2.weight(.semibold)

    var body: some View {
        let p = total > 0 ? min(1, Double(done) / Double(total)) : 0
        ZStack {
            Circle().stroke(Color(.tertiarySystemFill), lineWidth: lineWidth)
            Circle().trim(from: 0, to: p)
                .stroke(tint, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text("\(done)/\(total)").font(font).monospacedDigit().minimumScaleFactor(0.5).lineLimit(1)
                .padding(.horizontal, lineWidth + 1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(done) of \(total) done")
    }
}

/// Burn-up: done as a solid line against the total scope dashed. Compact = a sparkline (no axes).
struct DashBurnupChart: View {
    let burnup: DashBurnup
    let weeks: [String]
    var tint: Color = .accentColor
    var compact = false

    private struct Point: Identifiable { let i: Int; let series: String; let v: Double; var id: String { "\(series)\(i)" } }

    var body: some View {
        let pts = burnup.total.enumerated().map { Point(i: $0.offset, series: "Scope", v: $0.element) }
            + burnup.done.enumerated().map { Point(i: $0.offset, series: "Done", v: $0.element) }
        Chart(pts) { p in
            LineMark(x: .value("Week", DashDate.weekLabel(weeks, p.i)), y: .value("Stories", p.v), series: .value("Series", p.series))
                .foregroundStyle(p.series == "Done" ? tint : Color.secondary)
                .lineStyle(p.series == "Done" ? StrokeStyle(lineWidth: 2, lineCap: .round)
                                              : StrokeStyle(lineWidth: 1.5, lineCap: .round, dash: [3, 3]))
                .interpolationMethod(.monotone)
            if !compact, p.series == "Done", p.i == burnup.done.count - 1 {
                PointMark(x: .value("Week", DashDate.weekLabel(weeks, p.i)), y: .value("Stories", p.v))
                    .foregroundStyle(tint).symbolSize(40)
                    .annotation(position: .top, alignment: .trailing) {
                        Text(DashNum.count(p.v)).font(.caption2.weight(.semibold)).foregroundStyle(.primary)
                    }
            }
        }
        .chartYScale(domain: 0...max(1, ((burnup.total + burnup.done).max() ?? 1) * (compact ? 1.05 : 1.15)))
        .chartXAxis(compact ? .hidden : .automatic)
        .chartYAxis(compact ? .hidden : .automatic)
        .chartLegend(.hidden)
        .accessibilityLabel("Burn-up: \(DashNum.count(burnup.done.last ?? 0)) done of \(DashNum.count(burnup.total.last ?? 0))")
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
        case .delivered: return Glyph(symbol: "checkmark.seal.fill", tint: .blue, label: "Delivered")
        case .noDate: return Glyph(symbol: "calendar", tint: .secondary, label: "No date")
        case .unknown: return Glyph(symbol: "questionmark.circle", tint: .secondary, label: "Unknown")
        }
    }
}

// MARK: - Trends

struct DashTrendCharts: View {
    let snapshot: DashboardSnapshot

    var body: some View {
        let weeks = snapshot.trends.weeks
        VStack(spacing: 8) {
            DashCard(title: "Stories delivered per week") {
                DashWeekBars(values: snapshot.deliveredPerWeek, weeks: weeks, tint: .green, unit: "stories")
                    .frame(height: 150)
            }
            DashCard(title: "Open bugs") {
                DashWeekLine(values: snapshot.trends.bugsOpenTotal, weeks: weeks, tint: .orange, unit: "open bugs")
                    .frame(height: 140)
            }
        }
    }
}

/// One bar per week, each labelled (six bars, so every value fits).
struct DashWeekBars: View {
    let values: [Double]
    let weeks: [String]
    var tint: Color = .accentColor
    var unit: String = ""

    var body: some View {
        Chart(Array(values.enumerated()), id: \.offset) { i, v in
            BarMark(x: .value("Week", DashDate.weekLabel(weeks, i)), y: .value(unit, v), width: .ratio(0.6))
                .foregroundStyle(tint.gradient)
                .clipShape(UnevenRoundedRectangle(topLeadingRadius: 4, topTrailingRadius: 4))
                .annotation(position: .top, spacing: 2) {
                    Text(DashNum.count(v)).font(.caption2).foregroundStyle(.secondary)
                }
        }
        .chartYAxis(.hidden)
        .chartXAxis { AxisMarks { _ in AxisValueLabel().font(.caption2) } }
        .chartYScale(domain: 0...max(1, (values.max() ?? 1) * 1.15))
        .accessibilityLabel("\(unit) per week: " + values.enumerated().map { "\(DashDate.weekLabel(weeks, $0.offset)) \(DashNum.count($0.element))" }.joined(separator: ", "))
    }
}

/// A weekly line, the last value marked and labelled.
struct DashWeekLine: View {
    let values: [Double]
    let weeks: [String]
    var tint: Color = .accentColor
    var unit: String = ""

    var body: some View {
        Chart(Array(values.enumerated()), id: \.offset) { i, v in
            LineMark(x: .value("Week", DashDate.weekLabel(weeks, i)), y: .value(unit, v))
                .foregroundStyle(tint)
                .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round))
                .interpolationMethod(.monotone)
            AreaMark(x: .value("Week", DashDate.weekLabel(weeks, i)), y: .value(unit, v))
                .foregroundStyle(tint.opacity(0.12))
                .interpolationMethod(.monotone)
            if i == values.count - 1 {
                PointMark(x: .value("Week", DashDate.weekLabel(weeks, i)), y: .value(unit, v))
                    .foregroundStyle(tint).symbolSize(50)
                    .annotation(position: .top, alignment: .trailing, spacing: 4) {
                        Text(DashNum.count(v)).font(.caption.weight(.semibold))
                    }
            }
        }
        .chartYScale(domain: 0...max(1, (values.max() ?? 1) * 1.25))
        .chartXAxis { AxisMarks { _ in AxisValueLabel().font(.caption2) } }
        .chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { _ in
            AxisGridLine(); AxisValueLabel().font(.caption2)
        } }
        .accessibilityLabel("\(unit) per week: " + values.enumerated().map { "\(DashDate.weekLabel(weeks, $0.offset)) \(DashNum.count($0.element))" }.joined(separator: ", "))
    }
}

// MARK: - Workplace

struct DashWorkplace: View {
    let snapshot: DashboardSnapshot

    var body: some View {
        let weeks = snapshot.trends.weeks
        let legend = snapshot.waitLegend
        let colors = DashboardSnapshot.waitColorsHex.prefix(legend.count).map { Color(hex: $0) }
        let labels = legend.map(DashboardSnapshot.causeLabel)
        let totals = legend.map { c in snapshot.waitStack.filter { $0.cause == c }.reduce(0) { $0 + $1.days } }
        VStack(spacing: 8) {
            DashCard(title: "Waiting, story-days per week") {
                if legend.isEmpty {
                    Text("No waiting recorded.").font(.subheadline).foregroundStyle(.secondary)
                } else {
                    Chart(snapshot.waitStack) { s in
                        BarMark(x: .value("Week", DashDate.weekLabel(weeks, s.week)), y: .value("Story-days", s.days), width: .ratio(0.6))
                            .foregroundStyle(by: .value("Cause", DashboardSnapshot.causeLabel(s.cause)))
                    }
                    .chartForegroundStyleScale(domain: labels, range: colors)
                    .chartLegend(.hidden)
                    .chartXAxis { AxisMarks { _ in AxisValueLabel().font(.caption2) } }
                    .chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { _ in
                        AxisGridLine(); AxisValueLabel().font(.caption2)
                    } }
                    .frame(height: 170)
                    .accessibilityLabel("Waiting by cause: " + zip(labels, totals).map { "\($0) \(DashDate.days($1))" }.joined(separator: ", "))
                    // The legend carries each cause's six-week total, so no colour is read alone.
                    LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)],
                              alignment: .leading, spacing: 4) {
                        ForEach(Array(legend.enumerated()), id: \.offset) { i, _ in
                            HStack(spacing: 6) {
                                RoundedRectangle(cornerRadius: 2).fill(colors[i]).frame(width: 10, height: 10)
                                Text(labels[i]).font(.caption).lineLimit(1)
                                Text(DashDate.days(totals[i])).font(.caption).foregroundStyle(.secondary).monospacedDigit()
                                    .lineLimit(1).layoutPriority(1)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                }
            }
            HStack(spacing: 8) {
                DashTile(symbol: "person.crop.circle.badge.checkmark", tint: .blue,
                         value: DashNum.minutes(snapshot.gaps?.reviewWait?.approval1Minutes?.p50),
                         caption: "approval 1, median", badge: nil)
                    .accessibilityLabel("Approval 1 median wait \(DashNum.minutes(snapshot.gaps?.reviewWait?.approval1Minutes?.p50))")
                    .accessibilityIdentifier("dash.review.approval1")
                DashTile(symbol: "checkmark.shield.fill", tint: .blue,
                         value: DashNum.minutes(snapshot.gaps?.reviewWait?.approval2Minutes?.p50),
                         caption: "approval 2, median", badge: nil)
                    .accessibilityLabel("Approval 2 median wait \(DashNum.minutes(snapshot.gaps?.reviewWait?.approval2Minutes?.p50))")
                    .accessibilityIdentifier("dash.review.approval2")
            }
        }
    }
}

// MARK: - Product detail

/// A product: bigger burn-up, then delivered and bugs per week.
struct DashProductDetail: View {
    let product: DashProduct
    let weeks: [String]

    var body: some View {
        let health = product.health ?? .unknown
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                DashCard {
                    HStack(spacing: 14) {
                        DashRing(done: product.done, total: product.total, tint: health.glyph.tint,
                                 lineWidth: 8, font: .subheadline.weight(.semibold))
                            .frame(width: 76, height: 76)
                        VStack(alignment: .leading, spacing: 6) {
                            DashHealthPill(health: health)
                            dateRow("flag", "Due", DashDate.short(product.committedDate))
                            dateRow("scope", "Forecast", product.forecast.map(DashDate.forecast) ?? "—")
                        }
                    }
                }
                DashCard(title: "Burn-up") {
                    DashBurnupChart(burnup: product.burnup, weeks: weeks, tint: health.glyph.tint)
                        .frame(height: 180)
                    HStack(spacing: 14) {
                        legendLine(dashed: false, tint: health.glyph.tint, "Done")
                        legendLine(dashed: true, tint: .secondary, "Scope")
                    }
                    .font(.caption)
                }
                DashCard(title: "Delivered per week") {
                    DashWeekBars(values: product.weekly.delivered, weeks: weeks, tint: .green, unit: "stories").frame(height: 140)
                }
                DashCard(title: "Bugs opened per week") {
                    DashWeekBars(values: product.weekly.bugs, weeks: weeks, tint: .orange, unit: "bugs").frame(height: 140)
                }
            }
            .padding(16)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(product.name)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func dateRow(_ symbol: String, _ label: String, _ value: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: symbol).foregroundStyle(.secondary).frame(width: 16)
            Text(label).foregroundStyle(.secondary)
            Text(value).monospacedDigit()
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
    }

    private func legendLine(dashed: Bool, tint: Color, _ label: String) -> some View {
        HStack(spacing: 6) {
            Path { p in p.move(to: CGPoint(x: 0, y: 5)); p.addLine(to: CGPoint(x: 18, y: 5)) }
                .stroke(tint, style: StrokeStyle(lineWidth: 2, dash: dashed ? [3, 3] : []))
                .frame(width: 18, height: 10)
            Text(label).foregroundStyle(.secondary)
        }
    }
}

// MARK: - Formatting

enum DashNum {
    /// 41 → "41", 2.5 → "2.5".
    static func count(_ v: Double) -> String {
        v == v.rounded() ? "\(Int(v))" : String(format: "%.1f", v)
    }

    /// 24 → "+24", -3 → "−3", 0 → "0".
    static func signed(_ v: Double) -> String {
        v > 0 ? "+\(count(v))" : v < 0 ? "−\(count(-v))" : "0"
    }

    /// A median wait in minutes: 45 → "45 min", 132.6 → "2.2 h", nil → "—".
    static func minutes(_ m: Double?) -> String {
        guard let m else { return "—" }
        if m < 60 { return "\(Int(m.rounded())) min" }
        let h = m / 60
        return h < 48 ? String(format: "%.1f h", h) : String(format: "%.1f d", h / 24)
    }
}

/// Snapshot dates: `YYYY-MM-DD` (committed, forecast, weeks) or full ISO times, shown as "6 Nov".
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

    /// The x label of week `i`: its Monday ("26 Oct"), or "W3" when the snapshot has no week list.
    static func weekLabel(_ weeks: [String], _ i: Int) -> String {
        weeks[safe: i].map(short) ?? "W\(i + 1)"
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

    /// 6.5 → "6.5 d", 2 → "2 d".
    static func days(_ v: Double) -> String {
        let r = (v * 10).rounded() / 10
        return r == r.rounded() ? "\(Int(r)) d" : String(format: "%.1f d", r)
    }
}

extension Color {
    /// "#3987e5" → the sRGB colour.
    init(hex: String) {
        let s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let v = UInt64(s, radix: 16) ?? 0
        self.init(.sRGB, red: Double((v >> 16) & 0xff) / 255, green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255)
    }
}

#if DEBUG
#Preview("Dashboard") {
    NavigationStack {
        DashboardContent(snapshot: .preview, availability: .available, error: nil, loading: false)
            .navigationTitle("Dashboard")
            .navigationDestination(for: DashProductRoute.self) { r in
                DashProductDetail(product: DashboardSnapshot.preview.products.first { $0.id == r.id }!,
                                  weeks: DashboardSnapshot.preview.trends.weeks)
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

#Preview("Product") {
    NavigationStack { DashProductDetail(product: DashboardSnapshot.preview.products[2], weeks: DashboardSnapshot.preview.trends.weeks) }
}
#endif
