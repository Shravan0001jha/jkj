import SwiftUI
import AVFoundation
import PhotosUI
import UniformTypeIdentifiers
import QuickLook

// Photos, files and voice notes in chat (owner, 4 Oct): attach from the photo library (PHPicker)
// or Files (the document picker), receive what agents send (QuickLook preview, share), record a
// voice note (hold the mic, or tap it; AAC .m4a; time shown; cancel any time) and play one with
// its transcript under it.

// MARK: - Model

/// A file on a message, as the chat shows it. `path` is where the server serves it (fetched with
/// the session's bearer, then cached); `localURL` is set for what this phone just sent.
struct ChatAttachment: Equatable, Identifiable, Hashable {
    enum Kind: String { case image, file, voice }
    let id: String
    let kind: Kind
    let name: String
    let mediaType: String
    var size: Int? = nil
    var path: String? = nil
    var localURL: URL? = nil
    var durationMs: Int? = nil
    var transcript: String? = nil

    static func kind(for mediaType: String, voice: Bool = false) -> Kind {
        if voice || mediaType.hasPrefix("audio/") { return .voice }
        if mediaType.hasPrefix("image/") { return .image }
        return .file
    }
}

/// Something the owner is about to send: bytes in hand, shown as a chip above the field.
struct OutgoingAttachment: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let mediaType: String
    let data: Data
    var durationMs: Int? = nil
    var isVoice: Bool { durationMs != nil || mediaType.hasPrefix("audio/") }

    /// The contract's inline form (`{ name, mediaType, data: base64 }`).
    var wire: Attachment { Attachment(name: name, mediaType: mediaType, data: data.base64EncodedString()) }

    /// Larger than this is refused before it is sent: the relay carries at most ~12 MB (§11).
    static let maxBytes = 12 * 1024 * 1024

    /// What this phone keeps of a sent file, so it shows at once without a download.
    func savedLocally() -> URL? {
        let dir = AttachmentCache.directory.appendingPathComponent("sent", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("\(id.uuidString)-\(AttachmentCache.safeName(name))")
        return (try? data.write(to: url)) != nil ? url : nil
    }

    var display: ChatAttachment {
        ChatAttachment(id: id.uuidString, kind: ChatAttachment.kind(for: mediaType, voice: isVoice), name: name, mediaType: mediaType,
                       size: data.count, localURL: savedLocally(), durationMs: durationMs)
    }
}

// MARK: - Download cache

/// Server files fetched once with the session's bearer token and kept in Caches.
@MainActor @Observable
final class AttachmentCache {
    nonisolated static let directory: URL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("attachments", isDirectory: true)
    private(set) var local: [String: URL] = [:]
    private var inFlight: [String: Task<URL, Error>] = [:]
    /// Set by the app: downloads a server path with the current credential.
    var fetch: ((String) async throws -> Data)?

    nonisolated static func safeName(_ name: String) -> String {
        let cleaned = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        return cleaned.isEmpty ? "file" : cleaned
    }

    /// The file on disk: the one this phone sent, a cached copy, or a fresh download.
    func url(for a: ChatAttachment) async throws -> URL {
        if let l = a.localURL, FileManager.default.fileExists(atPath: l.path) { return l }
        guard let path = a.path else { throw WorkplaceError.transport("This file is not available on the server.") }
        if let l = local[path], FileManager.default.fileExists(atPath: l.path) { return l }
        if let t = inFlight[path] { return try await t.value }
        guard let fetch else { throw WorkplaceError.notPaired }
        let task = Task<URL, Error> {
            let data = try await fetch(path)
            try FileManager.default.createDirectory(at: Self.directory, withIntermediateDirectories: true)
            let url = Self.directory.appendingPathComponent("\(abs(path.hashValue))-\(Self.safeName(a.name))")
            try data.write(to: url)
            return url
        }
        inFlight[path] = task
        defer { inFlight[path] = nil }
        let url = try await task.value
        local[path] = url
        return url
    }
}

// MARK: - Showing attachments on a message

struct AttachmentsView: View {
    let attachments: [ChatAttachment]
    let mine: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(attachments) { a in
                switch a.kind {
                case .image: ImageAttachmentView(attachment: a)
                case .voice: VoiceNoteView(attachment: a, mine: mine)
                case .file: FileAttachmentView(attachment: a, mine: mine)
                }
            }
        }
    }
}

/// A photo: a thumbnail; tap to preview full screen (QuickLook: zoom, share, save).
struct ImageAttachmentView: View {
    @Environment(AppModel.self) private var model
    let attachment: ChatAttachment
    @State private var image: UIImage?
    @State private var file: URL?
    @State private var preview: URL?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                ZStack {
                    Color(.tertiarySystemFill)
                    if failed { Image(systemName: "photo.badge.exclamationmark").foregroundStyle(.secondary) } else { ProgressView() }
                }
            }
        }
        .frame(width: 220, height: 160)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture { if let file { preview = file } }
        .quickLookPreview($preview)
        .accessibilityLabel("Photo \(attachment.name)")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("chat.attachment.image")
        .task(id: attachment.id) {
            do {
                let url = try await model.attachments.url(for: attachment)
                file = url
                image = await Task.detached { UIImage(contentsOfFile: url.path)?.preparingThumbnail(of: CGSize(width: 660, height: 480)) }.value
                failed = image == nil
            } catch { failed = true }
        }
    }
}

/// A file: icon, name, size; tap to open it in QuickLook (which shares too); a Share item in the menu.
struct FileAttachmentView: View {
    @Environment(AppModel.self) private var model
    let attachment: ChatAttachment
    let mine: Bool
    @State private var preview: URL?
    @State private var shared: URL?
    @State private var loading = false
    @State private var error: String?

    private var symbol: String {
        let t = attachment.mediaType
        if t.contains("pdf") { return "doc.richtext" }
        if t.hasPrefix("text/") || t.contains("json") || t.contains("markdown") { return "doc.text" }
        if t.contains("zip") { return "doc.zipper" }
        if t.hasPrefix("video/") { return "film" }
        return "doc"
    }

    var body: some View {
        Button { Task { await open() } } label: {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8).fill(mine ? Color.white.opacity(0.2) : Color.accentColor.opacity(0.12))
                    if loading { ProgressView().controlSize(.small) } else { Image(systemName: symbol).foregroundStyle(mine ? Color.white : Color.accentColor) }
                }
                .frame(width: 36, height: 36)
                VStack(alignment: .leading, spacing: 1) {
                    Text(attachment.name).font(.subheadline.weight(.medium)).lineLimit(1).truncationMode(.middle)
                    Text(error ?? subtitle).font(.caption2).foregroundStyle(error != nil ? Color.red : (mine ? Color.white.opacity(0.8) : Color.secondary))
                }
                Spacer(minLength: 0)
            }
            .foregroundStyle(mine ? Color.white : Color.primary)
            .padding(8)
            .frame(minWidth: 200)
            .background(mine ? Color.white.opacity(0.12) : Color(.tertiarySystemFill).opacity(0.6), in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button { Task { await open() } } label: { Label("Preview", systemImage: "eye") }
            Button { Task { await share() } } label: { Label("Share…", systemImage: "square.and.arrow.up") }
        }
        .quickLookPreview($preview)
        .sheet(item: Binding(get: { shared.map(SharedFile.init) }, set: { if $0 == nil { shared = nil } })) { f in ShareSheet(items: [f.url]) }
        .accessibilityIdentifier("chat.attachment.file")
    }

    private var subtitle: String {
        var parts: [String] = []
        if let s = attachment.size { parts.append(ByteCountFormatter.string(fromByteCount: Int64(s), countStyle: .file)) }
        parts.append("Tap to open")
        return parts.joined(separator: " · ")
    }

    private func load() async -> URL? {
        loading = true; error = nil
        defer { loading = false }
        do { return try await model.attachments.url(for: attachment) } catch { self.error = error.userMessage; return nil }
    }

    private func open() async { if let u = await load() { preview = u } }
    private func share() async { if let u = await load() { shared = u } }
}

struct SharedFile: Identifiable { let url: URL; var id: URL { url } }

struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: items, applicationActivities: nil) }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}

// MARK: - Voice notes

/// Plays one voice note at a time across the app.
@MainActor @Observable
final class VoicePlayer: NSObject, AVAudioPlayerDelegate {
    static let shared = VoicePlayer()
    private(set) var playingId: String?
    private(set) var progress: Double = 0
    private var player: AVAudioPlayer?
    private var timer: Timer?

    func toggle(id: String, url: URL) {
        if playingId == id { stop(); return }
        stop()
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
            try AVAudioSession.sharedInstance().setActive(true)
            let p = try AVAudioPlayer(contentsOf: url)
            p.delegate = self
            p.play()
            player = p
            playingId = id
            timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                Task { @MainActor in
                    guard let self, let p = self.player, p.duration > 0 else { return }
                    self.progress = p.currentTime / p.duration
                }
            }
        } catch {
            stop()
        }
    }

    func stop() {
        player?.stop(); player = nil
        timer?.invalidate(); timer = nil
        playingId = nil; progress = 0
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.stop() }
    }
}

/// Play/pause, a progress bar, the length, and the transcript under it.
struct VoiceNoteView: View {
    @Environment(AppModel.self) private var model
    let attachment: ChatAttachment
    let mine: Bool
    @State private var loading = false
    @State private var error: String?
    private var player: VoicePlayer { .shared }

    var body: some View {
        let playing = player.playingId == attachment.id
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Button { Task { await toggle() } } label: {
                    ZStack {
                        Circle().fill(mine ? Color.white : Color.accentColor)
                        if loading { ProgressView().controlSize(.small).tint(mine ? .accentColor : .white) } else {
                            Image(systemName: playing ? "pause.fill" : "play.fill").font(.system(size: 14, weight: .bold))
                                .foregroundStyle(mine ? Color.accentColor : Color.white)
                        }
                    }
                    .frame(width: 34, height: 34)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(playing ? "Pause voice note" : "Play voice note")
                .accessibilityIdentifier("chat.voice.play")
                VStack(alignment: .leading, spacing: 4) {
                    GeometryReader { g in
                        ZStack(alignment: .leading) {
                            Capsule().fill(mine ? Color.white.opacity(0.35) : Color(.tertiarySystemFill))
                            Capsule().fill(mine ? Color.white : Color.accentColor).frame(width: g.size.width * (playing ? player.progress : 0))
                        }
                    }
                    .frame(height: 4)
                    Text(error ?? Format.clock(ms: attachment.durationMs)).font(.caption2.monospacedDigit())
                        .foregroundStyle(error != nil ? Color.red : (mine ? Color.white.opacity(0.85) : Color.secondary))
                }
                .frame(width: 140)
            }
            if let t = attachment.transcript, !t.isEmpty {
                Text(t).font(.footnote).italic()
                    .foregroundStyle(mine ? Color.white.opacity(0.9) : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("Transcript: \(t)")
                    .accessibilityIdentifier("chat.voice.transcript")
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func toggle() async {
        loading = true; error = nil
        defer { loading = false }
        do { player.toggle(id: attachment.id, url: try await model.attachments.url(for: attachment)) }
        catch { self.error = error.userMessage }
    }
}

extension Format {
    /// "0:07", "1:23": a voice note's length.
    static func clock(ms: Int?) -> String {
        guard let ms else { return "Voice note" }
        let s = max(0, ms / 1000)
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

// MARK: - Recording

/// AAC in an .m4a, mono 22 kHz: small and clear for speech.
@MainActor @Observable
final class VoiceRecorder: NSObject, AVAudioRecorderDelegate {
    enum State: Equatable { case idle, recording, denied }
    private(set) var state: State = .idle
    private(set) var elapsed: TimeInterval = 0
    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private var url: URL?
    /// The longest note: past this it stops and is kept.
    static let maxSeconds: TimeInterval = 300

    func start() async -> Bool {
        let allowed = await AVAudioApplication.requestRecordPermission()
        guard allowed else { state = .denied; return false }
        VoicePlayer.shared.stop()
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString).m4a")
            let r = try AVAudioRecorder(url: url, settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 22_050,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
            ])
            r.delegate = self
            guard r.record() else { return false }
            recorder = r
            self.url = url
            elapsed = 0
            state = .recording
            timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
                Task { @MainActor in
                    guard let self, let r = self.recorder else { return }
                    self.elapsed = r.currentTime
                    if self.elapsed >= Self.maxSeconds { _ = self.finish() }
                }
            }
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            return true
        } catch {
            reset()
            return false
        }
    }

    /// Stop and hand back the note; nil when it was too short to be meant (< 0.6 s).
    func finish() -> OutgoingAttachment? {
        guard let r = recorder, let url else { reset(); return nil }
        let length = r.currentTime
        r.stop()
        defer { reset(); try? FileManager.default.removeItem(at: url) }
        guard length >= 0.6, let data = try? Data(contentsOf: url) else { return nil }
        let stamp = Date().formatted(.dateTime.year().month(.twoDigits).day(.twoDigits).hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
            .replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "").replacingOccurrences(of: " ", with: "-").replacingOccurrences(of: ",", with: "")
        return OutgoingAttachment(name: "voice-\(stamp).m4a", mediaType: "audio/mp4", data: data, durationMs: Int(length * 1000))
    }

    func cancel() {
        recorder?.stop()
        recorder?.deleteRecording()
        reset()
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    private func reset() {
        timer?.invalidate(); timer = nil
        recorder = nil; url = nil
        if state == .recording { state = .idle }
        elapsed = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

// MARK: - Composer pieces

/// The paperclip: Photos (PHPicker) or Files (the document picker).
struct AttachButton: View {
    let add: ([OutgoingAttachment]) -> Void
    let fail: (String) -> Void
    @State private var photos: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showFiles = false

    var body: some View {
        Menu {
            Button { showPhotos = true } label: { Label("Photo Library", systemImage: "photo.on.rectangle") }
            Button { showFiles = true } label: { Label("Files", systemImage: "folder") }
        } label: {
            Image(systemName: "paperclip").font(.system(size: 18, weight: .medium)).foregroundStyle(Color.accentColor)
                .frame(width: 32, height: 36)
        }
        .accessibilityLabel("Attach")
        .accessibilityIdentifier("chat.attach")
        .photosPicker(isPresented: $showPhotos, selection: $photos, maxSelectionCount: 6, matching: .images)
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }
            Task {
                var out: [OutgoingAttachment] = []
                for (i, item) in items.enumerated() {
                    if let data = try? await item.loadTransferable(type: Data.self), let a = Self.photo(data, index: i) { out.append(a) }
                }
                photos = []
                if out.isEmpty { fail("Couldn't read that photo.") } else { add(out) }
            }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls):
                var out: [OutgoingAttachment] = []
                for url in urls {
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    guard let data = try? Data(contentsOf: url) else { continue }
                    if data.count > OutgoingAttachment.maxBytes { fail("\(url.lastPathComponent) is over 12 MB; send a smaller one or a link."); continue }
                    let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                    out.append(OutgoingAttachment(name: url.lastPathComponent, mediaType: type, data: data))
                }
                if !out.isEmpty { add(out) }
            case .failure(let e):
                if let m = e.userMessage { fail(m) }
            }
        }
    }

    /// A photo as a JPEG, longest side at most 2048 px: what the agents need, a fraction of the bytes.
    static func photo(_ data: Data, index: Int) -> OutgoingAttachment? {
        guard let image = UIImage(data: data) else { return nil }
        let longest = max(image.size.width, image.size.height)
        let scale = min(1, 2048 / max(longest, 1))
        let size = CGSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
        let resized = UIGraphicsImageRenderer(size: size).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        guard let jpeg = resized.jpegData(compressionQuality: 0.82) else { return nil }
        let stamp = Int(Date().timeIntervalSince1970)
        return OutgoingAttachment(name: "photo-\(stamp)-\(index + 1).jpg", mediaType: "image/jpeg", data: jpeg)
    }
}

/// The files waiting to go with the next message, each with an ✕.
struct PendingAttachmentsBar: View {
    @Binding var pending: [OutgoingAttachment]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(pending) { a in
                    HStack(spacing: 6) {
                        if a.mediaType.hasPrefix("image/"), let img = UIImage(data: a.data)?.preparingThumbnail(of: CGSize(width: 64, height: 64)) {
                            Image(uiImage: img).resizable().scaledToFill().frame(width: 28, height: 28).clipShape(RoundedRectangle(cornerRadius: 5))
                        } else {
                            Image(systemName: a.isVoice ? "waveform" : "doc").foregroundStyle(Color.accentColor)
                        }
                        Text(a.isVoice ? "Voice note · \(Format.clock(ms: a.durationMs))" : a.name).font(.caption).lineLimit(1).truncationMode(.middle).frame(maxWidth: 140)
                        Button { pending.removeAll { $0.id == a.id } } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Remove \(a.name)")
                    }
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .background(Color(.secondarySystemBackground), in: Capsule())
                }
            }
            .padding(.horizontal, 12)
        }
        .padding(.top, 6)
        .accessibilityIdentifier("chat.pending")
    }
}

/// While recording: a red dot, the time, "slide to cancel" (hold) or Cancel / Send (tap mode).
struct RecordingBar: View {
    let elapsed: TimeInterval
    let holding: Bool
    let cancelArmed: Bool
    let cancel: () -> Void
    let send: () -> Void
    @State private var blink = false

    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(Color.red).frame(width: 10, height: 10).opacity(blink ? 0.3 : 1)
                .onAppear { withAnimation(.easeInOut(duration: 0.6).repeatForever()) { blink = true } }
            Text(Format.clock(ms: Int(elapsed * 1000))).font(.body.monospacedDigit()).accessibilityIdentifier("chat.recording.time")
            Spacer()
            if holding {
                Label(cancelArmed ? "Release to cancel" : "Slide left to cancel", systemImage: "chevron.left")
                    .font(.subheadline).foregroundStyle(cancelArmed ? Color.red : Color.secondary)
            } else {
                Button("Cancel", role: .destructive, action: cancel).accessibilityIdentifier("chat.recording.cancel")
                Button(action: send) {
                    Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                        .frame(width: 36, height: 36).background(Color.accentColor, in: Circle())
                }
                .accessibilityLabel("Send voice note")
                .accessibilityIdentifier("chat.recording.send")
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .frame(minHeight: 48)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Recording a voice note")
    }
}
