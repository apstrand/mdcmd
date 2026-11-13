import Foundation
import UIKit
import AuthenticationServices

/// GitHub OAuth for the native app — the Swift counterpart of
/// `src/storage/github/auth.ts`.
///
/// GitHub's code→token exchange requires the OAuth App's *client secret*, which
/// can't ship in a client, so the exchange is delegated to the same small
/// serverless proxy the web app uses (`server/github-oauth-worker/`). The app
/// only ever holds the client id and the resulting access token (in the
/// Keychain).
///
/// Unlike the web's full-page redirect, the native flow runs GitHub's consent
/// screen in an `ASWebAuthenticationSession` and catches the redirect to a custom
/// scheme (`mdcmd://oauth/github`), so nothing leaves the app.
///
/// Configure via Info.plist (public values; blank disables GitHub, mirroring the
/// web build's `VITE_GITHUB_*` vars):
///   GitHubClientID     the OAuth App's client id
///   GitHubOAuthProxy   the proxy endpoint that performs the token exchange
///   GitHubRedirectURI  (optional) the callback; defaults to mdcmd://oauth/github
@MainActor
final class GitHubAuth: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = GitHubAuth()

    private let authorizeEndpoint = "https://github.com/login/oauth/authorize"
    // `repo` grants read/write to private and public repository contents.
    private let scope = "repo"
    private let tokenAccount = "github.accessToken"

    private let clientID: String
    private let proxyURL: String
    private let redirectURI: String

    private(set) var token: String?
    // Held for the duration of a login so ARC doesn't deallocate it mid-flow.
    private var session: ASWebAuthenticationSession?

    override init() {
        func cfg(_ key: String) -> String {
            (Bundle.main.object(forInfoDictionaryKey: key) as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        }
        clientID = cfg("GitHubClientID")
        proxyURL = cfg("GitHubOAuthProxy")
        let r = cfg("GitHubRedirectURI")
        redirectURI = r.isEmpty ? "mdcmd://oauth/github" : r
        super.init()
        token = Keychain.get(tokenAccount)
    }

    /// Whether the build-time config needed to offer GitHub is present.
    var isConfigured: Bool { !clientID.isEmpty && !proxyURL.isEmpty }

    /// Whether a usable token is currently stored.
    var isAuthenticated: Bool { token != nil }

    /// Return the stored access token, or throw if not authenticated.
    func accessToken() throws -> String {
        guard let token else { throw GitHubError.notAuthenticated }
        return token
    }

    func logout() {
        token = nil
        Keychain.delete(tokenAccount)
    }

    /// Run the OAuth consent + token exchange. Resolves once a token is stored.
    func login() async throws {
        guard isConfigured else { throw GitHubError.notConfigured }

        let state = Self.randomState()
        var comps = URLComponents(string: authorizeEndpoint)!
        comps.queryItems = [
            .init(name: "client_id", value: clientID),
            .init(name: "redirect_uri", value: redirectURI),
            .init(name: "scope", value: scope),
            .init(name: "state", value: state),
        ]
        let authURL = comps.url!
        let scheme = URL(string: redirectURI)?.scheme ?? "mdcmd"

        let callback: URL = try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: authURL, callbackURLScheme: scheme
            ) { url, error in
                if let url {
                    continuation.resume(returning: url)
                } else if let err = error as? ASWebAuthenticationSessionError,
                          err.code == .canceledLogin {
                    continuation.resume(throwing: GitHubError.cancelled)
                } else {
                    continuation.resume(throwing: error ?? GitHubError.cancelled)
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            session.start()
        }
        self.session = nil

        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let code = items.first { $0.name == "code" }?.value
        let returnedState = items.first { $0.name == "state" }?.value
        guard returnedState == state else { throw GitHubError.stateMismatch }
        guard let code else { throw GitHubError.exchangeFailed("no authorization code") }

        try await exchange(code: code)
    }

    private func exchange(code: String) async throws {
        guard let url = URL(string: proxyURL) else {
            throw GitHubError.notConfigured
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(
            withJSONObject: ["code": code, "redirect_uri": redirectURI])

        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw GitHubError.exchangeFailed("token exchange failed: \(body)")
        }
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let accessToken = obj?["access_token"] as? String else {
            let err = obj?["error"] as? String ?? "no token"
            throw GitHubError.exchangeFailed(err)
        }
        token = accessToken
        Keychain.set(accessToken, for: tokenAccount)
    }

    // MARK: ASWebAuthenticationPresentationContextProviding

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }

    // MARK: Helpers

    private static func randomState() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

enum GitHubError: LocalizedError {
    case notConfigured
    case notAuthenticated
    case cancelled
    case stateMismatch
    case exchangeFailed(String)
    case api(Int, String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "GitHub isn't configured in this build."
        case .notAuthenticated:
            return "You're not signed in to GitHub."
        case .cancelled:
            return "GitHub sign-in was cancelled."
        case .stateMismatch:
            return "GitHub sign-in could not be verified. Please try again."
        case .exchangeFailed(let msg):
            return "GitHub sign-in failed: \(msg)"
        case .api(let status, let msg):
            return "GitHub request failed (\(status)): \(msg)"
        }
    }
}
