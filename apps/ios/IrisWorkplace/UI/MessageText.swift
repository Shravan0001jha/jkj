import SwiftUI
import UIKit

// Message text the same way everywhere a person or an agent writes (Talk, Room, item comments):
// markdown links and bare URLs are tappable (Safari, or the app for irisworkplace:// links), a
// long message folds to a few lines with a clear "Show more" / "Show less" and expands when the
// bubble is tapped anywhere, and a long-press offers Copy, Copy link and Reply (owner, 4 Oct).

// MARK: - Links

enum MessageLinks {
    private static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    /// Bare http(s) URLs and www. addresses in the text get a `.link`; markdown links the parser
    /// already linked are left alone.
    static func detect(_ a: AttributedString) -> AttributedString {
        guard let detector else { return a }
        var out = a
        let plain = String(a.characters)
        let ns = plain as NSString
        for m in detector.matches(in: plain, range: NSRange(location: 0, length: ns.length)) {
            guard let url = m.url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
                  let r = Range(m.range, in: plain) else { continue }
            let lower = plain.distance(from: plain.startIndex, to: r.lowerBound)
            let len = plain.distance(from: r.lowerBound, to: r.upperBound)
            let start = out.characters.index(out.startIndex, offsetBy: lower)
            let end = out.characters.index(start, offsetBy: len)
            if out[start..<end].runs.contains(where: { $0.link != nil }) { continue }
            out[start..<end].link = url
            out[start..<end].underlineStyle = .single
        }
        return out
    }

    /// Every web link in a message: markdown `[label](url)` targets and bare URLs, in order, once.
    static func webURLs(in text: String) -> [URL] {
        var out: [URL] = []
        func add(_ u: URL?) {
            guard let u, let s = u.scheme?.lowercased(), s == "http" || s == "https", !out.contains(u) else { return }
            out.append(u)
        }
        for m in text.matches(of: /\[[^\]]*\]\(([^)\s]+)\)/) { add(URL(string: String(m.1))) }
        if let detector {
            let ns = text as NSString
            for m in detector.matches(in: text, range: NSRange(location: 0, length: ns.length)) { add(m.url) }
        }
        return out
    }
}

// MARK: - Folding

/// What a message shows folded and unfolded. `details` is either the full version of a short
/// `text` (it starts with it, the server's "…" summary) or extra context after it.
struct MessageBody: Equatable {
    let text: String
    let details: String?
    /// Folded beyond this many lines (or about 65 characters a line, for one long paragraph).
    var foldLines = 8
    /// The server said `details` is the full text (a cut Room post, LLD-app-fixes §8).
    var detailsIsFull = false

    static let charsPerLine = 65

    /// The whole message, unfolded.
    var full: String {
        guard let d = details?.trimmingCharacters(in: .whitespacesAndNewlines), !d.isEmpty, d != text else { return text }
        if detailsIsFull { return d }
        let stem = text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "…", with: "").replacingOccurrences(of: "...", with: "")
        if !stem.isEmpty, d.hasPrefix(stem) { return d }
        return text + "\n\n" + d
    }

    /// Long enough to fold: more than `foldLines` lines, more than `foldChars` characters, or
    /// with details behind it.
    var isLong: Bool {
        if full != text { return true }
        return text.count > foldLines * Self.charsPerLine || text.split(separator: "\n", omittingEmptySubsequences: false).count > foldLines
    }

    /// What the bubble shows: everything when unfolded; folded, the text alone (the line limit
    /// does the rest).
    func shown(expanded: Bool) -> String { expanded ? full : text }
}

/// A message's text with links, folded to `MessageBody.foldLines` when long, and a "Show more" /
/// "Show less" control under it. The parent toggles `expanded` on a tap anywhere on the bubble.
struct MessageTextView: View {
    let content: MessageBody
    @Binding var expanded: Bool
    var mine = false
    var font: Font = .subheadline
    var alignment: TextAlignment = .leading
    let attributed: (String) -> AttributedString

    init(text: String, details: String?, expanded: Binding<Bool>, mine: Bool = false, font: Font = .subheadline,
         alignment: TextAlignment = .leading, foldLines: Int = 8, detailsIsFull: Bool = false, attributed: @escaping (String) -> AttributedString) {
        self.content = MessageBody(text: text, details: details, foldLines: foldLines, detailsIsFull: detailsIsFull)
        self._expanded = expanded
        self.mine = mine
        self.font = font
        self.alignment = alignment
        self.attributed = attributed
    }

    var body: some View {
        VStack(alignment: alignment == .trailing ? .trailing : .leading, spacing: 4) {
            Text(MessageLinks.detect(attributed(content.shown(expanded: expanded))))
                .font(font)
                .foregroundStyle(mine ? Color.white : Color.primary)
                .tint(mine ? .white : .accentColor)
                .multilineTextAlignment(alignment)
                .lineLimit(content.isLong && !expanded ? content.foldLines : nil)
                .fixedSize(horizontal: false, vertical: true)
            if content.isLong {
                Button { withAnimation(.snappy) { expanded.toggle() } } label: {
                    HStack(spacing: 3) {
                        Text(expanded ? "Show less" : "Show more")
                        Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption2.weight(.bold))
                    }
                    .font(.caption.weight(.semibold))
                    .padding(.vertical, 4)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(mine ? Color.white.opacity(0.95) : Color.accentColor)
                .accessibilityIdentifier(expanded ? "message.showLess" : "message.showMore")
            }
        }
    }
}

// MARK: - Long-press menu

/// Copy, Copy link (one per link, when there are any), Reply (where replying is possible).
struct MessageMenu: View {
    let text: String
    var onReply: (() -> Void)?

    var body: some View {
        let urls = MessageLinks.webURLs(in: text)
        if let onReply {
            Button { onReply() } label: { Label("Reply", systemImage: "arrowshape.turn.up.left") }
        }
        Button { UIPasteboard.general.string = MessageMenu.plain(text) } label: { Label("Copy", systemImage: "doc.on.doc") }
        if urls.count == 1, let u = urls.first {
            Button { UIPasteboard.general.url = u } label: { Label("Copy link", systemImage: "link") }
        } else if urls.count > 1 {
            Menu {
                ForEach(urls, id: \.self) { u in
                    Button(u.host().map { $0 + u.path() } ?? u.absoluteString) { UIPasteboard.general.url = u }
                }
            } label: { Label("Copy link", systemImage: "link") }
        }
    }

    /// Copy what the owner reads: markdown links become "label (url)", emphasis markers drop.
    static func plain(_ text: String) -> String {
        var s = text.replacing(/\[([^\]]*)\]\(([^)\s]+)\)/) { m in "\(m.1) (\(m.2))" }
        s = s.replacingOccurrences(of: "**", with: "")
        return s
    }
}
