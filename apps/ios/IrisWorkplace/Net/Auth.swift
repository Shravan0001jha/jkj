import Foundation
import AuthenticationServices
import UIKit

/// The relay's sign-in callback: `irisworkplace://auth#token=<session>`.
enum AuthCallback {
    static let scheme = "irisworkplace"
    static let host = "auth"

    /// The session token from the fragment, or nil for anything that is not exactly our callback.
    /// The token lives in the fragment on purpose: fragments never reach a server or its logs.
    static func parse(_ url: URL) -> String? {
        guard url.scheme?.lowercased() == scheme, url.host?.lowercased() == host else { return nil }
        guard let fragment = url.fragment, !fragment.isEmpty else { return nil }
        var comps = URLComponents()
        comps.percentEncodedQuery = fragment
        let token = comps.queryItems?.first { $0.name == "token" }?.value?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let token, !token.isEmpty else { return nil }
        return token
    }
}

/// Runs the relay's web sign-in and hands back the callback URL. The app uses
/// `ASWebAuthenticationSession`; tests inject a fake.
protocol WebAuth: AnyObject {
    @MainActor func signIn(startURL: URL) async throws -> URL
}

enum WebAuthError: Error, Equatable, LocalizedError {
    case cancelled
    case noCallback
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .cancelled: return "Sign-in was cancelled."
        case .noCallback: return "The sign-in page did not return to the app."
        case .failed(let s): return s
        }
    }
}

@MainActor
final class ASWebAuth: NSObject, WebAuth, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func signIn(startURL: URL) async throws -> URL {
        session?.cancel()
        return try await withCheckedThrowingContinuation { (c: CheckedContinuation<URL, Error>) in
            let s = ASWebAuthenticationSession(url: startURL, callbackURLScheme: AuthCallback.scheme) { url, error in
                if let error {
                    if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
                        c.resume(throwing: WebAuthError.cancelled)
                    } else {
                        c.resume(throwing: WebAuthError.failed(error.localizedDescription))
                    }
                    return
                }
                guard let url else { c.resume(throwing: WebAuthError.noCallback); return }
                c.resume(returning: url)
            }
            // Not ephemeral: passkeys and the browser's own session belong to the owner.
            s.prefersEphemeralWebBrowserSession = false
            s.presentationContextProvider = self
            session = s
            if !s.start() { c.resume(throwing: WebAuthError.failed("Could not open the sign-in page.")) }
        }
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            return scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? scenes.first?.windows.first ?? ASPresentationAnchor()
        }
    }
}
