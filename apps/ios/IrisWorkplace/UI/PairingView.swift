import SwiftUI

/// LAN pairing (a developer option): the server address and the one-time code from the Mac.
struct PairingView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    /// True when shown as a sheet from Developer options; false when it is the first screen in LAN mode.
    var embedded = false
    @State private var urlText = ""
    @State private var code = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Field?

    private enum Field { case url, code }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("192.168.1.5:4317", text: $urlText)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .url)
                        .submitLabel(.next)
                        .onSubmit { focus = .code }
                } header: {
                    SectionHeader(text: "Server")
                } footer: {
                    Text("The Mac's address on this network, as the Workplace prints it at start. Port 4317 unless changed.")
                }
                Section {
                    TextField("Pairing code", text: $code)
                        .keyboardType(.numberPad)
                        .font(.title2.monospacedDigit())
                        .focused($focus, equals: .code)
                } header: {
                    SectionHeader(text: "One-time code")
                } footer: {
                    Text("On the Mac, run the Workplace's pair command (POST /api/pair from the Mac itself). The code works once and expires in five minutes. The token it gives is kept in this phone's Keychain and never shown.")
                }
                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red)
                    }
                }
                Section {
                    Button {
                        Task { await pair() }
                    } label: {
                        HStack {
                            Spacer()
                            if busy { ProgressView().padding(.trailing, 6) }
                            Text(busy ? "Pairing…" : "Pair this phone").fontWeight(.semibold)
                            Spacer()
                        }
                    }
                    .disabled(busy || urlText.trimmingCharacters(in: .whitespaces).isEmpty || code.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                if !embedded {
                    Section {
                        Button("Use the relay instead") { model.useRelay() }
                    }
                }
            }
            .navigationTitle(embedded ? "Pair on the LAN" : "Iris Workplace")
            .navigationBarTitleDisplayMode(embedded ? .inline : .large)
            .toolbar {
                if embedded { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            }
            .onAppear {
                if let saved = model.savedLANURL { urlText = saved.host.map { h in saved.port.map { "\(h):\($0)" } ?? h } ?? "" }
                focus = urlText.isEmpty ? .url : .code
            }
        }
    }

    private func pair() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await model.pair(urlText: urlText, code: code)
            if embedded { dismiss() }
        } catch {
            if let m = error.userMessage { self.error = m }
        }
    }
}
