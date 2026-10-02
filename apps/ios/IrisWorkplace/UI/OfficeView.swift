import SwiftUI

/// The employees, the COO, spend and coverage: opened from the Plan's menu as a sheet (v2:
/// Plan is home and Updates replaces the counters). Alerts, Spend, Settings and New request open
/// from the Plan's menu, not from here, so no sheet is ever asked to present over this one.
struct OfficeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let error = model.office.error, model.office.data == nil {
                    ErrorRow(message: error) { Task { await reload() } }
                }
                if let d = model.office.data {
                    Section { OfficeHeader(data: d) }
                    if let coo = model.office.coo {
                        Section {
                            Button { model.router.talk(to: coo.employee.id) } label: {
                                CooCardView(card: coo)
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("Opens Talk with Claude")
                        }
                    }
                    ForEach(d.units) { u in
                        Section {
                            ForEach(u.employees.filter { $0.employee.virtual != true }) { card in
                                Button { model.router.talk(to: card.employee.id) } label: {
                                    EmployeeCardView(card: card)
                                }
                                .buttonStyle(.plain)
                                .accessibilityHint("Opens Talk with \(card.employee.name)")
                            }
                        } header: {
                            HStack {
                                SectionHeader(text: u.unit.title)
                                Spacer()
                                if let b = d.spend.byUnit[u.unit.id], b > 0 {
                                    Text(Format.inr(b)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    if let error = model.office.error {
                        Section { ErrorRow(message: error) { Task { await reload() } } }
                    }
                } else if model.office.loading {
                    Section { HStack { Spacer(); ProgressView("Loading the office…"); Spacer() } }
                }
            }
            .listStyle(.insetGrouped)
            .refreshable { await reload() }
            .navigationTitle("Office")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            // The spend meter and the Mac warning open these over the Office itself (a sheet).
            .sheet(isPresented: Bindable(model.router).showSpend) { SpendView() }
            .sheet(isPresented: Bindable(model.router).showSettings) { SettingsView() }
            .safeAreaInset(edge: .top, spacing: 0) { ConnectionStrip() }
            .task { if model.office.data == nil { await reload() } }
        }
    }

    private func reload() async {
        guard let rest = model.rest else { return }
        await model.office.load(rest)
        if !model.inbox.loaded { await model.inbox.load(rest) }
    }
}

/// Needs you, working, blocked, stalled; spend against the cap; coverage; lint.
struct OfficeHeader: View {
    @Environment(AppModel.self) private var model
    let data: OfficeResponse

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Stat(value: "\(data.needsYou)", label: data.needsYou == 1 ? "needs you" : "need you",
                     glyph: data.needsYou > 0 ? EmployeeState.needsOwner.glyph : Glyph(symbol: "checkmark.circle", tint: .green, label: "nothing waiting"))
                Divider().frame(height: 36).padding(.horizontal, 6)
                Stat(value: "\(data.counts.working)", label: "working", glyph: EmployeeState.working.glyph)
                Divider().frame(height: 36).padding(.horizontal, 6)
                Stat(value: "\(data.counts.blocked)", label: "blocked",
                     glyph: data.counts.blocked > 0 ? EmployeeState.blocked.glyph : Glyph(symbol: "circle", tint: .secondary, label: "none blocked"))
                Divider().frame(height: 36).padding(.horizontal, 6)
                Stat(value: "\(data.counts.stalled)", label: "stalled",
                     glyph: data.counts.stalled > 0 ? Glyph(symbol: "clock.badge.exclamationmark", tint: .orange, label: "stalled") : Glyph(symbol: "clock", tint: .secondary, label: "none stalled"))
            }
            Button { model.router.showSpend = true } label: {
                SpendMeter(spend: data.spend)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens spend and subscription usage")
            CoverageRow(coverage: data.coverage)
            if let warning = model.health?.resilience?.officeWarning() {
                Button { model.router.showSettings = true } label: {
                    Label(warning, systemImage: model.health?.resilience?.onBattery == true ? "battery.25percent" : "moon.zzz")
                        .font(.caption).foregroundStyle(.orange)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens Settings with the Mac's health")
            }
            if data.lintErrors > 0 {
                Label("\(data.lintErrors) ownership-map error\(data.lintErrors == 1 ? "" : "s") block routing", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.red)
            }
        }
        .padding(.vertical, 4)
    }
}

private struct Stat: View {
    let value: String
    let label: String
    let glyph: Glyph

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: glyph.symbol).foregroundStyle(glyph.tint).font(.subheadline)
            VStack(alignment: .leading, spacing: 0) {
                Text(value).font(.title3.weight(.semibold).monospacedDigit())
                Text(label).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// Real money today against the daily cap. Shape: a bar; colour: green → orange (≥ 80 %) → red (at cap).
struct SpendMeter: View {
    let spend: SpendSummary

    private var fraction: Double { spend.capInr > 0 ? min(1, spend.companyInr / spend.capInr) : 0 }
    private var tint: Color { fraction >= 1 ? .red : fraction >= 0.8 ? .orange : .green }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text("Spend today").font(.subheadline.weight(.semibold))
                Text("real money").font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Text("\(Format.inr(spend.companyInr)) of \(Format.inr(spend.capInr))")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(fraction >= 0.8 ? tint : .primary)
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.2))
                    Capsule().fill(tint).frame(width: max(4, geo.size.width * fraction))
                    if fraction < 1 {
                        Rectangle().fill(Color.secondary.opacity(0.5)).frame(width: 1).offset(x: geo.size.width * 0.8)
                    }
                }
            }
            .frame(height: 8)
            HStack(spacing: 10) {
                if !spend.paused.isEmpty {
                    Label(spend.paused.map(pausedName).joined(separator: ", ") + " paused at cap", systemImage: "pause.circle.fill")
                        .font(.caption).foregroundStyle(.orange)
                }
                Spacer()
                Text("Subscription: \(spend.subscription.turns) turns, free").font(.caption).foregroundStyle(.secondary)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Spend today \(Format.inr(spend.companyInr)) of \(Format.inr(spend.capInr)), \(Format.percent(Int(spend.companyInr), of: Int(spend.capInr)))")
    }

    private func pausedName(_ scope: String) -> String {
        if scope == "company" { return "Company" }
        let parts = scope.split(separator: ":", maxSplits: 1).map(String.init)
        return parts.count == 2 ? parts[1].capitalized : scope
    }
}

/// Requirement coverage: owned / planned / built / verified / released as fractions of the definition.
struct CoverageRow: View {
    let coverage: Coverage

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text("Definition coverage").font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(coverage.total) requirements").font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 0) {
                seg("owned", coverage.owned, .blue)
                seg("planned", coverage.planned, .indigo)
                seg("built", coverage.built, .mint)
                seg("verified", coverage.verified, .green)
                seg("released", coverage.released, .green)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func seg(_ label: String, _ n: Int, _ tint: Color) -> some View {
        VStack(spacing: 2) {
            Text(Format.percent(n, of: coverage.total)).font(.subheadline.weight(.semibold).monospacedDigit())
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Capsule().fill(tint).frame(height: 3).opacity(n > 0 ? 1 : 0.2)
        }
        .frame(maxWidth: .infinity)
        .accessibilityLabel("\(label) \(n) of \(coverage.total)")
    }
}

/// "Claude — COO": the owner's own AI colleague, shown once above the org units, with a presence
/// dot (online/offline). Tapping opens Talk with the same chat UI as any employee.
struct CooCardView: View {
    let card: EmployeeCard

    private var online: Bool? { card.employee.isOnline }

    var body: some View {
        HStack(spacing: 12) {
            ZStack(alignment: .bottomTrailing) {
                InitialsAvatar(name: card.employee.name, size: 40, tint: .indigo)
                PresenceDot(online: online).offset(x: 2, y: 2)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(card.employee.name).font(.headline)
                if online == false {
                    Text(card.employee.stateReason ?? "Messages wait; Asha handles routine").font(.caption).foregroundStyle(.secondary)
                } else if let r = card.lastReport, !r.isEmpty {
                    Text(r).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                } else {
                    Text("Talk anytime — the whole picture, one conversation.").font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Claude, Chief Operating Officer, \(online == true ? "online" : online == false ? "offline" : "")")
    }
}

struct EmployeeCardView: View {
    let card: EmployeeCard

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(card.employee.name).font(.headline)
                Text(card.charters.map(\.title).joined(separator: " · ")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                StateLabel(glyph: card.employee.state.glyph, compact: true)
            }
            if let reason = card.employee.stateReason, !reason.isEmpty {
                Text(reason).font(.caption).foregroundStyle(card.employee.state.glyph.tint).lineLimit(3)
            }
            if let w = card.currentWork {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: w.state.glyph.symbol).foregroundStyle(w.state.glyph.tint).font(.caption)
                    Text(w.title).font(.subheadline).lineLimit(2)
                }
                if let since = w.stalledSince {
                    Label("Stalled since \(Format.ago(since)) — the Chief of Staff resumes it or asks you", systemImage: "clock.badge.exclamationmark")
                        .font(.caption).foregroundStyle(.orange)
                }
            } else {
                Text("Nothing assigned").font(.subheadline).foregroundStyle(.secondary)
            }
            if let r = card.lastReport, !r.isEmpty {
                Text(r).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            HStack(spacing: 8) {
                Pill(text: Format.inr(card.spendTodayInr) + " today", symbol: "indianrupeesign", tint: .secondary)
                if card.needsYou > 0 {
                    Pill(text: "\(card.needsYou) for you", symbol: "exclamationmark.circle.fill", tint: .orange)
                }
                if let s = card.session {
                    Pill(text: s.status.glyph.label, symbol: s.status.glyph.symbol, tint: s.status.glyph.tint)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
