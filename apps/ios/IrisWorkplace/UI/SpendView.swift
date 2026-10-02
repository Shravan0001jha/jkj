import SwiftUI

/// Real money against the ₹1000 cap (by source, estimates labelled), and separately the
/// subscription's free usage: turns, tokens, the equivalent price for information, and the
/// rate-limit windows.
struct SpendView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var spend: SpendSummary?
    @State private var error: String?

    private var summary: SpendSummary? { spend ?? model.office.data?.spend }

    var body: some View {
        NavigationStack {
            List {
                if let s = summary {
                    Section {
                        SpendMeter(spend: s).padding(.vertical, 4)
                        ForEach(s.bySource.keys.sorted(), id: \.self) { key in
                            HStack {
                                Label(sourceName(key), systemImage: sourceSymbol(key))
                                Spacer()
                                Text(Format.inr(s.bySource[key] ?? 0)).monospacedDigit()
                            }
                        }
                        ForEach(s.byBasis.keys.sorted(), id: \.self) { key in
                            HStack {
                                Text(basisName(key)).foregroundStyle(.secondary)
                                if key == "estimated" { Pill(text: "estimate", tint: .orange) }
                                if key == "reported" { Pill(text: "reported", tint: .secondary) }
                                Spacer()
                                Text(Format.inr(s.byBasis[key] ?? 0)).monospacedDigit().foregroundStyle(.secondary)
                            }
                            .font(.subheadline)
                        }
                    } header: { SectionHeader(text: "Real money · \(s.day)") } footer: {
                        Text("Only real money counts against the ₹\(Int(s.capInr)) cap. Metered means the provider's own figure; an estimate is labelled so it is never mistaken for a bill.")
                    }
                    Section {
                        ForEach(s.byEmployee.keys.sorted { (s.byEmployee[$0] ?? 0) > (s.byEmployee[$1] ?? 0) }, id: \.self) { id in
                            HStack {
                                Text(model.employeeName(id))
                                if s.paused.contains("employee:\(id)") { Pill(text: "paused", symbol: "pause.circle.fill", tint: .orange) }
                                Spacer()
                                Text(Format.inr(s.byEmployee[id] ?? 0)).monospacedDigit()
                            }
                        }
                    } header: { SectionHeader(text: "By employee") }
                    Section {
                        let u = s.subscription
                        HStack { Text("Turns today"); Spacer(); Text("\(u.turns)").monospacedDigit() }
                        HStack { Text("Tokens"); Spacer(); Text("\(Format.count(u.inputTokens)) in · \(Format.count(u.outputTokens)) out").monospacedDigit().foregroundStyle(.secondary) }
                        HStack { Text("Cache"); Spacer(); Text("\(Format.count(u.cacheReadTokens)) read · \(Format.count(u.cacheWriteTokens)) write").monospacedDigit().foregroundStyle(.secondary) }
                        HStack {
                            Text("Would cost at list price")
                            Spacer()
                            Text(Format.inr(u.equivalentInr)).monospacedDigit().foregroundStyle(.secondary)
                            Pill(text: "not billed", tint: .green)
                        }
                        if s.ownerTalkInr > 0 {
                            HStack { Text("of which your own talk"); Spacer(); Text(Format.inr(s.ownerTalkInr)).monospacedDigit().foregroundStyle(.secondary) }.font(.subheadline)
                        }
                        ForEach(u.byEmployee.keys.sorted { (u.byEmployee[$0]?.turns ?? 0) > (u.byEmployee[$1]?.turns ?? 0) }, id: \.self) { id in
                            HStack {
                                Text(model.employeeName(id)).font(.subheadline)
                                Spacer()
                                Text("\(u.byEmployee[id]?.turns ?? 0) turns").font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                            }
                        }
                    } header: { SectionHeader(text: "Subscription usage (free)") } footer: {
                        Text("The employees run on the owner's Claude subscription. This is usage, not money; it never counts against the cap.")
                    }
                    Section {
                        if s.subscription.windows.isEmpty {
                            Text("No rate-limit window reported yet.").foregroundStyle(.secondary)
                        }
                        ForEach(Array(s.subscription.windows.enumerated()), id: \.offset) { _, w in
                            RateLimitRow(window: w)
                        }
                    } header: { SectionHeader(text: "Rate-limit windows") }
                } else if let error {
                    ErrorRow(message: error) { Task { await load() } }
                } else {
                    HStack { Spacer(); ProgressView(); Spacer() }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Spend")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .refreshable { await load() }
            .task { await load() }
        }
    }

    private func load() async {
        guard let rest = model.rest else { return }
        do { spend = try await rest.spend(); error = nil } catch { if let m = error.userMessage { self.error = m } }
    }

    private func sourceName(_ k: String) -> String {
        switch k {
        case "anthropic-api": return "Anthropic API"
        case "aws": return "AWS"
        case "third-party": return "Third party"
        case "subscription": return "Subscription (history)"
        default: return k
        }
    }

    private func sourceSymbol(_ k: String) -> String {
        switch k {
        case "anthropic-api": return "cpu"
        case "aws": return "cloud"
        case "third-party": return "creditcard"
        default: return "clock.arrow.circlepath"
        }
    }

    private func basisName(_ k: String) -> String {
        switch k {
        case "metered": return "Metered by the provider"
        case "estimated": return "Estimated"
        case "reported": return "Reported by a script"
        default: return k
        }
    }
}

struct RateLimitRow: View {
    let window: RateLimitWindow

    private var glyph: Glyph {
        switch window.status {
        case .allowed: return Glyph(symbol: "checkmark.circle", tint: .green, label: "Allowed")
        case .allowedWarning: return Glyph(symbol: "exclamationmark.triangle", tint: .orange, label: "Near the limit")
        case .rejected: return Glyph(symbol: "xmark.octagon.fill", tint: .red, label: "Rejected")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(name).font(.subheadline.weight(.medium))
                Spacer()
                StateLabel(glyph: glyph, compact: true)
            }
            if let u = window.utilization {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.secondary.opacity(0.2))
                        Capsule().fill(glyph.tint).frame(width: max(3, geo.size.width * min(1, max(0, u))))
                    }
                }
                .frame(height: 6)
                .accessibilityLabel("\(Int((u * 100).rounded())) percent used")
            }
            HStack {
                if let u = window.utilization { Text("\(Int((u * 100).rounded()))% used") }
                if let r = window.resetsAt, let d = Format.date(r) { Text("· resets \(d.formatted(.relative(presentation: .named)))") }
            }
            .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    private var name: String {
        switch window.window {
        case .fiveHour: return "5-hour window"
        case .sevenDay: return "7-day window"
        case .sevenDayOpus: return "7-day, Opus"
        case .sevenDaySonnet: return "7-day, Sonnet"
        case .sevenDayOverageIncluded: return "7-day incl. overage"
        case .overage: return "Overage"
        case .unknown: return "Window"
        }
    }
}

extension Format {
    static func count(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.0fk", Double(n) / 1_000) }
        return "\(n)"
    }
}
