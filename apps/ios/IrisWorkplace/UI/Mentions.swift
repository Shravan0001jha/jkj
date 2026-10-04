import SwiftUI

// @mentions the same way in chats, Room threads and item comments (owner, 4 Oct): type "@" and
// pick from the suggestions (again for each person), or tap the @ button for a list where several
// people can be ticked at once. Mentions travel as "@id" in the text (and as `mentions` where the
// route takes them).

enum Mentions {
    /// The word being typed after the last unfinished `@`, or nil when the draft isn't mid-mention.
    static func query(in draft: String) -> String? {
        guard let at = draft.lastIndex(of: "@") else { return nil }
        // "a@b" is an email, not a mention.
        if at > draft.startIndex, let before = draft[draft.index(before: at)...].first, !before.isWhitespace { return nil }
        let after = draft[draft.index(after: at)...]
        guard !after.contains(where: { $0.isWhitespace }) else { return nil }
        return String(after)
    }

    /// Replace the word being typed after the last `@` with the id; nothing before it changes.
    static func pick(_ id: String, into draft: String) -> String {
        guard query(in: draft) != nil, let at = draft.lastIndex(of: "@") else { return add([id], to: draft) }
        var d = draft
        d.replaceSubrange(d.index(after: at)..., with: id + " ")
        return d
    }

    /// Add mentions the draft doesn't have yet, at the end, each once.
    static func add(_ ids: [String], to draft: String) -> String {
        let have = Set(RoomStore.mentions(in: draft, known: ids))
        let new = ids.filter { !have.contains($0) }
        guard !new.isEmpty else { return draft }
        var d = draft
        if let q = query(in: d), q.isEmpty { d.removeLast() }   // a lone "@" the picker replaces
        if !d.isEmpty, !(d.last?.isWhitespace ?? true) { d += " " }
        return d + new.map { "@\($0)" }.joined(separator: " ") + " "
    }

    /// Take mentions out of the draft (unticked in the picker).
    static func remove(_ ids: [String], from draft: String) -> String {
        var d = draft
        for id in ids { d = d.replacing(Regex<Substring>(verbatim: "@\(id)").ignoresCase(), with: "") }
        return d.replacing(/\ {2,}/, with: " ")
    }

    /// Who matches what's typed after "@": id or any word of the name starts with it.
    static func candidates(_ query: String, known: [String], name: (String) -> String) -> [String] {
        let q = query.lowercased()
        let sorted = known.sorted { name($0) < name($1) }
        guard !q.isEmpty else { return sorted }
        return sorted.filter { id in
            id.lowercased().hasPrefix(q) || name(id).lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).contains { $0.hasPrefix(q) }
        }
    }
}

/// The chips under the field while "@…" is being typed.
struct MentionSuggestions: View {
    @Environment(AppModel.self) private var model
    @Binding var draft: String
    let known: [String]

    var body: some View {
        if let q = Mentions.query(in: draft) {
            let cands = Mentions.candidates(q, known: known) { model.employeeName($0) }
            if !cands.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(cands, id: \.self) { id in
                            Button { draft = Mentions.pick(id, into: draft) } label: {
                                HStack(spacing: 4) {
                                    InitialsAvatar(name: model.employeeName(id), size: 18, tint: id == "coo" ? .indigo : .accentColor)
                                    Text(model.employeeName(id)).font(.caption.weight(.medium))
                                }
                                .padding(.horizontal, 8).padding(.vertical, 5)
                                .background(Color(.secondarySystemBackground), in: Capsule())
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("mention.suggest.\(id)")
                        }
                    }
                    .padding(.horizontal, 14)
                }
                .padding(.top, 4)
                .accessibilityLabel("Mention someone")
            }
        }
    }
}

/// The people already mentioned in the draft, as pills.
struct MentionPills: View {
    @Environment(AppModel.self) private var model
    let draft: String
    let known: [String]

    var body: some View {
        let ids = RoomStore.mentions(in: draft, known: known)
        if !ids.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    Image(systemName: "at").font(.caption).foregroundStyle(.secondary)
                    ForEach(ids, id: \.self) { Pill(text: model.employeeName($0), tint: .accentColor) }
                }
                .padding(.horizontal, 14)
            }
            .padding(.top, 4)
            .accessibilityIdentifier("mention.pills")
        }
    }
}

/// "@": a list of everyone, several can be ticked; Done puts them in the draft.
struct MentionButton: View {
    @Binding var draft: String
    let known: [String]
    @State private var show = false

    var body: some View {
        Button { show = true } label: {
            Image(systemName: "at").font(.system(size: 17, weight: .semibold)).foregroundStyle(Color.accentColor)
                .frame(width: 30, height: 36)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Mention people")
        .accessibilityIdentifier("mention.button")
        .sheet(isPresented: $show) {
            MentionPickerSheet(known: known, initial: Set(RoomStore.mentions(in: draft, known: known))) { picked in
                let before = Set(RoomStore.mentions(in: draft, known: known))
                var d = Mentions.remove(Array(before.subtracting(picked)), from: draft)
                d = Mentions.add(known.filter { picked.contains($0) && !before.contains($0) }.sorted(), to: d)
                draft = d
            }
            .presentationDetents([.medium, .large])
        }
    }
}

struct MentionPickerSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let known: [String]
    let initial: Set<String>
    let done: (Set<String>) -> Void
    @State private var picked: Set<String> = []
    @State private var search = ""

    var body: some View {
        NavigationStack {
            List {
                ForEach(Mentions.candidates(search, known: known) { model.employeeName($0) }, id: \.self) { id in
                    Button {
                        if picked.contains(id) { picked.remove(id) } else { picked.insert(id) }
                    } label: {
                        HStack(spacing: 10) {
                            InitialsAvatar(name: model.employeeName(id), size: 30, tint: id == "coo" ? .indigo : .accentColor)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(model.employeeName(id)).font(.body).foregroundStyle(.primary)
                                Text("@\(id)").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: picked.contains(id) ? "checkmark.circle.fill" : "circle")
                                .font(.title3).foregroundStyle(picked.contains(id) ? Color.accentColor : Color(.tertiaryLabel))
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(picked.contains(id) ? .isSelected : [])
                    .accessibilityIdentifier("mention.pick.\(id)")
                }
            }
            .listStyle(.plain)
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search people")
            .navigationTitle(picked.isEmpty ? "Mention people" : "\(picked.count) selected")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { done(picked); dismiss() }.accessibilityIdentifier("mention.done")
                }
            }
            .onAppear { picked = initial }
        }
    }
}

extension AppModel {
    /// Everyone who can be @mentioned: the COO and every employee in the Office.
    var mentionable: [String] {
        if let m = talkThreads.mentionable, !m.isEmpty { return m.map(\.id) }
        var ids = office.cards.map(\.employee.id)
        if !ids.contains("coo") { ids.append("coo") }
        return ids.filter { $0 != "owner" && $0 != "workplace" }
    }
}
