import SwiftUI

// Shared pieces. Every state is a glyph plus a tint, never a colour alone.

// MARK: - State glyphs

struct Glyph {
    let symbol: String
    let tint: Color
    let label: String
}

extension Employee {
    /// nil unless `state` is actually `.online`/`.offline` (only the COO's is today) — never a
    /// false "offline" for an ordinary employee's idle/working/blocked/paused state.
    var isOnline: Bool? {
        switch state {
        case .online: return true
        case .offline: return false
        default: return nil
        }
    }
}

/// A small filled circle with the person's initials — the group chat's stand-in for a photo.
struct InitialsAvatar: View {
    let name: String
    var size: CGFloat = 26
    var tint: Color = .accentColor
    /// Telegram-style: a bright gradient picked from the name (stable per person) with white initials.
    /// Chat surfaces use it; the rest of the app keeps the quiet tinted circle.
    var vivid: Bool = false

    private var initials: String {
        let parts = name.split(separator: " ")
        let letters = parts.prefix(2).compactMap { $0.first }
        return letters.isEmpty ? "?" : String(letters).uppercased()
    }

    var body: some View {
        if vivid {
            let (top, bottom) = AvatarPalette.colors(for: name)
            Circle()
                .fill(LinearGradient(colors: [top, bottom], startPoint: .top, endPoint: .bottom))
                .overlay(Text(initials).font(.system(size: size * 0.4, weight: .semibold, design: .rounded)).foregroundStyle(.white))
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        } else {
            Circle()
                .fill(tint.opacity(0.18))
                .overlay(Text(initials).font(.system(size: size * 0.42, weight: .semibold)).foregroundStyle(tint))
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        }
    }
}

/// Seven Telegram-like avatar gradients; a name always maps to the same one.
enum AvatarPalette {
    static let pairs: [(Color, Color)] = [
        (Color(red: 1.00, green: 0.53, blue: 0.37), Color(red: 0.95, green: 0.33, blue: 0.29)),   // red
        (Color(red: 1.00, green: 0.73, blue: 0.33), Color(red: 0.96, green: 0.56, blue: 0.21)),   // orange
        (Color(red: 0.73, green: 0.55, blue: 1.00), Color(red: 0.55, green: 0.38, blue: 0.93)),   // violet
        (Color(red: 0.55, green: 0.85, blue: 0.40), Color(red: 0.33, green: 0.70, blue: 0.27)),   // green
        (Color(red: 0.42, green: 0.85, blue: 0.90), Color(red: 0.22, green: 0.69, blue: 0.80)),   // cyan
        (Color(red: 0.45, green: 0.70, blue: 1.00), Color(red: 0.27, green: 0.52, blue: 0.93)),   // blue
        (Color(red: 1.00, green: 0.55, blue: 0.75), Color(red: 0.93, green: 0.35, blue: 0.58)),   // pink
    ]
    /// Stable across launches (no Swift `hashValue`, which is seeded per run).
    static func index(for name: String) -> Int {
        var h: UInt32 = 2166136261
        for b in name.lowercased().utf8 { h = (h ^ UInt32(b)) &* 16777619 }
        return Int(h % UInt32(pairs.count))
    }
    static func colors(for name: String) -> (Color, Color) { pairs[index(for: name)] }
}

/// Online (filled) / offline (hollow) — shape as well as colour, like every other state in this app.
struct PresenceDot: View {
    let online: Bool?
    var body: some View {
        Group {
            if online == true {
                Circle().fill(Color.green)
            } else if online == false {
                Circle().strokeBorder(Color.secondary, lineWidth: 1.5)
            } else {
                EmptyView()
            }
        }
        .frame(width: 9, height: 9)
        .accessibilityLabel(online == true ? "Online" : online == false ? "Offline" : "")
    }
}

extension EmployeeState {
    var glyph: Glyph {
        switch self {
        case .working: return Glyph(symbol: "play.circle.fill", tint: .green, label: "Working")
        case .idle: return Glyph(symbol: "circle", tint: .secondary, label: "Idle")
        case .blocked: return Glyph(symbol: "octagon.fill", tint: .red, label: "Blocked")
        case .needsOwner: return Glyph(symbol: "exclamationmark.circle.fill", tint: .orange, label: "Needs you")
        case .paused: return Glyph(symbol: "pause.circle.fill", tint: .yellow, label: "Paused")
        case .online: return Glyph(symbol: "circle.fill", tint: .green, label: "Online")
        case .offline: return Glyph(symbol: "circle", tint: .secondary, label: "Offline")
        case .unknown: return Glyph(symbol: "questionmark.circle", tint: .secondary, label: "Other")
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
        case .unknown: return Glyph(symbol: "questionmark.circle", tint: .secondary, label: "Other")
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
        case .unknown: return Glyph(symbol: "questionmark.circle", tint: .secondary, label: "Other")
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
        case .unknown: return Glyph(symbol: "info.circle", tint: .secondary, label: "Notice")
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
        case .unknown: return Glyph(symbol: "questionmark.circle", tint: .secondary, label: "Other")
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
        case .unknown: return "Other"
        }
    }
}

// MARK: - v2 glyphs

extension ItemStatus {
    var glyph: Glyph {
        switch self {
        case .backlog: return Glyph(symbol: "tray", tint: .secondary, label: "Backlog")
        case .ready: return Glyph(symbol: "circle", tint: .blue, label: "Ready")
        case .inProgress: return Glyph(symbol: "play.circle.fill", tint: .green, label: "In progress")
        case .inReview: return Glyph(symbol: "magnifyingglass.circle.fill", tint: .purple, label: "In review")
        case .waiting: return Glyph(symbol: "hourglass.circle.fill", tint: .orange, label: "Waiting")
        case .parked: return Glyph(symbol: "parkingsign.circle", tint: .gray, label: "Parked")
        case .done: return Glyph(symbol: "checkmark.circle.fill", tint: .green, label: "Done")
        case .blocked: return Glyph(symbol: "octagon.fill", tint: .red, label: "Blocked")
        case .unknown: return Glyph(symbol: "questionmark.circle", tint: .secondary, label: "Other")
        }
    }
}

extension ItemLevel {
    var label: String {
        switch self {
        case .epic: return "Epic"
        case .story: return "Story"
        case .task: return "Task"
        case .unknown: return "Item"
        }
    }
    var symbol: String {
        switch self {
        case .epic: return "flag.fill"
        case .story: return "doc.text"
        case .task: return "checklist"
        case .unknown: return "square.dashed"
        }
    }
}

extension UpdateKind {
    var glyph: Glyph {
        switch self {
        case .started: return Glyph(symbol: "play.circle.fill", tint: .green, label: "Started")
        case .shipped: return Glyph(symbol: "checkmark.seal.fill", tint: .green, label: "Shipped")
        case .blocked: return Glyph(symbol: "octagon.fill", tint: .red, label: "Blocked")
        case .unblocked: return Glyph(symbol: "arrow.uturn.forward.circle", tint: .teal, label: "Unblocked")
        case .decided: return Glyph(symbol: "arrow.triangle.branch", tint: .purple, label: "Decided")
        case .brief: return Glyph(symbol: "sun.max.fill", tint: .orange, label: "Brief")
        case .review: return Glyph(symbol: "chart.bar.fill", tint: .indigo, label: "Weekly review")
        case .unknown: return Glyph(symbol: "circle.dashed", tint: .secondary, label: "Update")
        }
    }
}

extension InboxUrgency {
    /// Colour and label, never wording (the doc's Inbox rule).
    var glyph: Glyph {
        switch self {
        case .normal, .unknown: return Glyph(symbol: "circle", tint: .secondary, label: "Normal")
        case .high: return Glyph(symbol: "exclamationmark.circle.fill", tint: .orange, label: "High")
        case .urgent: return Glyph(symbol: "exclamationmark.2", tint: .red, label: "Urgent")
        }
    }
}

extension ItemActivityKind {
    var symbol: String {
        switch self {
        case .created: return "plus.circle"
        case .status: return "arrow.right.circle"
        case .assigned: return "person.crop.circle"
        case .reviewer: return "person.crop.circle.badge.checkmark"
        case .points: return "number.circle"
        case .field: return "pencil.circle"
        case .comment: return "text.bubble"
        case .commit: return "arrow.triangle.branch"
        case .test: return "checkmark.diamond"
        case .note: return "note.text"
        case .stall: return "hourglass"
        case .merged: return "arrow.triangle.merge"
        case .reopen: return "arrow.counterclockwise.circle"
        case .started: return "play.circle"
        case .unknown: return "circle.dashed"
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

    /// A date/time separator for a chat, iMessage-style: nil while the conversation keeps
    /// flowing (< 5 min since the previous item), otherwise a label for the gap.
    static func chatSeparator(since previous: String?, at: String) -> String? {
        guard let d = date(at) else { return nil }
        if let previous, let p = date(previous), d.timeIntervalSince(p) < 300 { return nil }
        if Calendar.current.isDateInToday(d) { return d.formatted(date: .omitted, time: .shortened) }
        if Calendar.current.isDateInYesterday(d) { return "Yesterday " + d.formatted(date: .omitted, time: .shortened) }
        return d.formatted(.dateTime.month(.abbreviated).day().hour().minute())
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

extension AuditKind {
    var symbol: String {
        switch self {
        case .created: return "plus.circle"
        case .assigned: return "person.crop.circle"
        case .status: return "arrow.right.circle"
        case .reviewer: return "person.crop.circle.badge.checkmark"
        case .parked: return "parkingsign.circle"
        case .reopened: return "arrow.counterclockwise.circle"
        case .doc: return "doc.richtext"
        case .unknown: return "circle.dashed"
        }
    }
}
