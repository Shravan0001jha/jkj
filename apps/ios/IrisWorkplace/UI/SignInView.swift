import SwiftUI

/// First run in relay mode: sign in through the relay's web page (passkey, or email + Telegram
/// code), or enrol a passkey the first time. A developer can switch to a LAN Workplace instead.
struct SignInView: View {
    @Environment(AppModel.self) private var model
    @State private var busy = false
    @State private var error: String?
    @State private var showDeveloper = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Spacer()
                Image(systemName: "building.2.crop.circle").font(.system(size: 64)).foregroundStyle(Color.accentColor)
                Text("Iris Workplace").font(.largeTitle.weight(.bold))
                Text("Your employees, from anywhere. Sign in with your passkey, or with your email and a Telegram code.")
                    .multilineTextAlignment(.center).foregroundStyle(.secondary).padding(.horizontal, 24)
                if let error {
                    Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.subheadline)
                        .multilineTextAlignment(.leading).padding(.horizontal, 24)
                }
                VStack(spacing: 10) {
                    Button { Task { await signIn(enrol: false) } } label: {
                        HStack { if busy { ProgressView().tint(.white) }; Text(busy ? "Signing in…" : "Sign in").fontWeight(.semibold) }
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent).controlSize(.large).disabled(busy)
                    Button { Task { await signIn(enrol: true) } } label: {
                        Text("First time here? Set up a passkey").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered).controlSize(.large).disabled(busy)
                }
                .padding(.horizontal, 24)
                Text(model.config.baseURL.host ?? "").font(.caption).foregroundStyle(.tertiary)
                Spacer()
                Button("Developer options") { showDeveloper = true }.font(.footnote).foregroundStyle(.secondary)
                    .padding(.bottom, 8)
            }
            .sheet(isPresented: $showDeveloper) { DeveloperOptionsView() }
        }
    }

    private func signIn(enrol: Bool) async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await model.signIn(enrol: enrol)
        } catch WebAuthError.cancelled {
            // The owner closed the page: nothing to say.
        } catch {
            if let m = error.userMessage { self.error = m }
        }
    }
}

/// Shown when the credential was refused: sign in again (relay) or re-pair (LAN).
struct ReauthView: View {
    @Environment(AppModel.self) private var model
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "key.slash").font(.system(size: 44)).foregroundStyle(.orange)
            if model.mode == .relay {
                Text("Your session has ended").font(.title3.weight(.semibold))
                Text("Sessions end after 12 hours idle or 7 days. Sign in again to continue.")
                    .multilineTextAlignment(.center).foregroundStyle(.secondary)
                if let error { Text(error).font(.subheadline).foregroundStyle(.red).multilineTextAlignment(.center) }
                Button {
                    Task {
                        busy = true; error = nil
                        defer { busy = false }
                        do { try await model.signIn() } catch WebAuthError.cancelled {} catch { if let m = error.userMessage { self.error = m } }
                    }
                } label: { Text(busy ? "Signing in…" : "Sign in again").frame(minWidth: 160) }
                .buttonStyle(.borderedProminent).disabled(busy)
                Button("Sign out") { model.signOut() }.font(.footnote)
            } else {
                Text("This phone is no longer paired").font(.title3.weight(.semibold))
                Text("The Workplace refused the token. Pair again with a new code from the Mac, or use the relay.")
                    .multilineTextAlignment(.center).foregroundStyle(.secondary)
                Button("Re-pair") { model.unpair() }.buttonStyle(.borderedProminent)
                Button("Use the relay instead") { model.useRelay() }.font(.footnote)
            }
        }
        .padding(24)
    }
}

/// The Mac's tunnel to the relay is down: distinct from a network error, and re-probed on its own.
struct MacOfflineView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "desktopcomputer.trianglebadge.exclamationmark").font(.system(size: 48)).foregroundStyle(.red)
            Text("Your Mac is offline").font(.title2.weight(.semibold))
            Text("The relay is reachable, but the Workplace on your Mac is not connected to it. The app keeps checking and will connect when the Mac is back.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary)
            HStack(spacing: 8) { ProgressView(); Text("Checking every few seconds").font(.caption).foregroundStyle(.secondary) }
            Button("Check now") { model.foreground() }.buttonStyle(.bordered)
            Button("Settings") { model.router.showSettings = true }.font(.footnote)
        }
        .padding(24)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Your Mac is offline. Workplace unavailable. Checking every few seconds.")
    }
}

/// LAN pairing, kept for development: hidden behind a toggle, off by default.
struct DeveloperOptionsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var lanEnabled = false
    @State private var showPairing = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Use a LAN Workplace (pairing)", isOn: $lanEnabled)
                        .onChange(of: lanEnabled) { _, on in
                            if on {
                                if model.savedLANURL != nil, model.mode != .lan { model.useSavedLAN() } else if model.mode != .lan { showPairing = true }
                            } else if model.mode == .lan {
                                model.useRelay()
                            }
                        }
                    if lanEnabled {
                        LabeledContent("Address", value: model.savedLANURL?.absoluteString ?? "not paired yet")
                        Button("Pair with a new code") { showPairing = true }
                        if model.savedLANURL != nil {
                            Button("Forget the LAN pairing", role: .destructive) { model.unpair(); lanEnabled = false }
                        }
                    }
                } header: {
                    Text("Developer")
                } footer: {
                    Text("For a Workplace on the same network, without the relay: pair with a one-time code from POST /api/pair on the Mac. The relay session is kept while this is on.")
                }
            }
            .navigationTitle("Developer options")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onAppear { lanEnabled = model.mode == .lan }
            .sheet(isPresented: $showPairing, onDismiss: { lanEnabled = model.mode == .lan }) {
                PairingView(embedded: true)
            }
        }
    }
}
