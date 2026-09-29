import SwiftUI

// Shared pieces. Every state is a glyph plus a tint, never a colour alone.

// MARK: - State glyphs

struct Glyph {
    let symbol: String
    let tint: Color
    let label: String
}

extension EmployeeState {
    var glyph: Glyph {
        switch self {
        case .working: return Glyph(symbol: "play.circle.fill", tint: .green, label: "Working")
        case .idle: return Glyph(symbol: "circle", tint: .secondary, label: "Idle")
        case .blocked: return Glyph(symbol: "octagon.fill", tint: .red, label: "Blocked")
        case .needsOwner: return Glyph(symbol: "exclamationmark.circle.fill", tint: .orange, label: "Needs you")
        case .paused: return Glyph(symbol: "pause.circle.fill", tint: .yellow, label: "Paused")
        }
    }
}

extension InboxKind {
    var glyph: Glyph {
        switch self {
        case .approval: return Glyph(symbol: "checkmark.seal", tint: .blue, label: "Approval")
        case .decision: return Glyph(symbol: "arrow.triangle.branch", tint: .purple, label: "Decision")
        case .question: return Glyph(symbol: "questionmark.circle", tint: .teal, label: "Question")
        case .cap: return Glyph(symbol: "indianrupeesign.circle", tint: .orange, label: "Spend cap")
        case .orgChange: return Glyph(symbol: "person.2.badge.gearshape", tint: .indigo, label: "Org change")
        case .release: return Glyph(symbol: "shippingbox", tint: .brown, label: "Release")
        }
    }
}

extension WorkState {
    var glyph: Glyph {
        switch self {
        case .stated: return Glyph(symbol: "circle.dotted", tint: .secondary, label: "Stated")
        case .specced: return Glyph(symbol: "doc.text", tint: .blue, label: "Specced")
        case .decomposed: return Glyph(symbol: "square.grid.2x2", tint: .indigo, label: "Decomposed")
        case .inProgress: return Glyph(symbol: "play.circle", tint: .green, label: "In progress")
        case .built: return Glyph(symbol: "hammer.circle.fill", tint: .mint, label: "Built")
        case .released: return Glyph(symbol: "checkmark.seal.fill", tint: .green, label: "Released")
        case .proposed: return Glyph(symbol: "circle.dotted", tint: .secondary, label: "Proposed")
        case .planned: return Glyph(symbol: "list.bullet.circle", tint: .blue, label: "Planned")
        case .building: return Glyph(symbol: "play.circle.fill", tint: .green, label: "Building")
        case .review: return Glyph(symbol: "magnifyingglass.circle", tint: .purple, label: "In review")
        case .done: return Glyph(symbol: "checkmark.circle.fill", tint: .green, label: "Done")
        case .blocked: return Glyph(symbol: "octagon.fill", tint: .red, label: "Blocked")
        case .rejected: return Glyph(symbol: "xmark.circle", tint: .red, label: "Rejected")
        }
    }
}

extension AlertLevel {
    var glyph: Glyph {
        switch self {
        case .info: return Glyph(symbol: "info.circle", tint: .blue, label: "Info")
        case .needsYou: return Glyph(symbol: "exclamationmark.circle.fill", tint: .orange, label: "Needs you")
        case .blocked: return Glyph(symbol: "octagon.fill", tint: .red, label: "Blocked")
        case .cap: return Glyph(symbol: "indianrupeesign.circle.fill", tint: .red, label: "Spend cap")
        }
    }
}

extension AgentStatus {
    var glyph: Glyph {
        switch self {
        case .idle: return Glyph(symbol: "circle", tint: .secondary, label: "Idle")
        case .running: return Glyph(symbol: "play.circle.fill", tint: .green, label: "Running")
        case .waiting: return Glyph(symbol: "hand.raised.circle.fill", tint: .orange, label: "Waiting for you")
        case .done: return Glyph(symbol: "checkmark.circle", tint: .secondary, label: "Ended")
        case .error: return Glyph(symbol: "exclamationmark.triangle.fill", tint: .red, label: "Error")
        }
    }
}

extension RequirementStatus {
    var glyph: Glyph {
        switch self {
        case .missing: return Glyph(symbol: "circle.dotted", tint: .secondary, label: "Missing")
        case .partial: return Glyph(symbol: "circle.lefthalf.filled", tint: .orange, label: "Partial")
        case .built: return Glyph(symbol: "hammer.circle.fill", tint: .mint, label: "Built")
        case .verified: return Glyph(symbol: "checkmark.circle.fill", tint: .green, label: "Verified")
        case .released: return Glyph(symbol: "checkmark.seal.fill", tint: .green, label: "Released")
        }
    }
}

extension PermissionMode {
    var title: String {
        switch self {
        case .ask: return "Ask me"
        case .auto: return "Auto"
        case .acceptEdits: return "Edits run"
        case .plan: return "Plan only"
        case .dontAsk: return "Never ask"
        }
    }
}

/// A glyph with its label: the state is readable without the colour.
struct StateLabel: View {
    let glyph: Glyph
    var compact = false

    var body: some View {
        Label {
            Text(glyph.label)
        } icon: {
            Image(systemName: glyph.symbol).foregroundStyle(glyph.tint)
        }
        .font(compact ? .caption : .subheadline)
        .labelStyle(.titleAndIcon)
        .accessibilityLabel(glyph.label)
    }
}

/// A small tinted pill (kind, count).
struct Pill: View {
    let text: String
    var symbol: String? = nil
    var tint: Color = .secondary

    var body: some View {
        HStack(spacing: 4) {
            if let symbol { Image(systemName: symbol) }
            Text(text)
        }
        .font(.caption.weight(.medium))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(tint.opacity(0.15), in: Capsule())
        .foregroundStyle(tint)
    }
}

// MARK: - Money and time

enum Format {
    static func inr(_ v: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.maximumFractionDigits = v < 100 ? 1 : 0
        f.minimumFractionDigits = 0
        return "₹" + (f.string(from: NSNumber(value: v)) ?? String(v))
    }

    static func percent(_ n: Int, of total: Int) -> String {
        guard total > 0 else { return "0%" }
        return "\(Int((Double(n) / Double(total) * 100).rounded()))%"
    }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func date(_ s: String) -> Date? {
        iso.date(from: s) ?? isoPlain.date(from: s)
    }

    /// "just now", "4 min ago", "2 h ago", "yesterday", "24 Sep".
    static func ago(_ s: String, now: Date = Date()) -> String {
        guard let d = date(s) else { return s }
        let secs = now.timeIntervalSince(d)
        if secs < 45 { return "just now" }
        if secs < 3600 { return "\(Int(secs / 60)) min ago" }
        if secs < 86_400 { return "\(Int(secs / 3600)) h ago" }
        if secs < 172_800 { return "yesterday" }
        return d.formatted(.dateTime.day().month(.abbreviated))
    }

    static func duration(_ seconds: Int) -> String {
        if seconds < 60 { return "\(seconds) s" }
        if seconds < 3600 { return "\(seconds / 60) min" }
        if seconds < 86_400 { return "\(seconds / 3600) h \((seconds % 3600) / 60) min" }
        return "\(seconds / 86_400) d \((seconds % 86_400) / 3600) h"
    }

    static func time(_ s: String) -> String {
        guard let d = date(s) else { return s }
        return d.formatted(date: .omitted, time: .shortened)
    }
}

// MARK: - Layout helpers

struct EmptyState: View {
    let symbol: String
    let title: String
    let text: String

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        } description: {
            Text(text)
        }
    }
}

struct ErrorRow: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
            VStack(alignment: .leading, spacing: 6) {
                Text(message).font(.subheadline)
                Button("Retry", action: retry).font(.subheadline.weight(.semibold))
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Multi-line text that keeps the server's line breaks and renders simple markdown headings/bullets.
struct Prose: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(text.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, line in
                let s = String(line)
                if s.hasPrefix("## ") {
                    Text(s.dropFirst(3)).font(.headline).padding(.top, 4)
                } else if s.hasPrefix("# ") {
                    Text(s.dropFirst(2)).font(.title3.weight(.semibold)).padding(.top, 4)
                } else if s.hasPrefix("- ") || s.hasPrefix("* ") {
                    HStack(alignment: .top, spacing: 6) {
                        Text("•")
                        Text(inline(String(s.dropFirst(2))))
                    }
                } else if s.isEmpty {
                    Spacer().frame(height: 2)
                } else {
                    Text(inline(s))
                }
            }
        }
        .font(.body)
        .textSelection(.enabled)
    }

    private func inline(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }
}

/// A string that is a URL becomes a tappable link; anything else is shown as text.
struct EvidenceLine: View {
    let text: String

    var body: some View {
        if let url = URL(string: text), let scheme = url.scheme, ["http", "https"].contains(scheme) {
            Link(destination: url) {
                Label(url.host ?? text, systemImage: "link").font(.subheadline)
            }
        } else if let range = text.range(of: #"https?://\S+"#, options: .regularExpression),
                  let url = URL(string: String(text[range])) {
            VStack(alignment: .leading, spacing: 2) {
                Text(text[..<range.lowerBound].trimmingCharacters(in: .whitespaces)).font(.subheadline)
                Link(destination: url) { Label(url.host ?? "link", systemImage: "link").font(.subheadline) }
            }
        } else {
            Text(text).font(.subheadline)
        }
    }
}

struct SectionHeader: View {
    let text: String
    var body: some View {
        Text(text).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary).textCase(nil)
    }
}
