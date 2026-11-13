import Foundation

/// GitHub storage backend — the async, Swift-native port of
/// `src/storage/github/backend.ts`. Presents the whole account as one browsable
/// tree so it reuses the existing single-root browser:
///
///   github:///                       -> the distinct owners of your repos
///   github:///owner                  -> that owner's repositories
///   github:///owner/repo             -> the repo root (its default branch)
///   github:///owner/repo/sub/file.md -> files/folders inside the repo
///
/// All content operations act on each repo's default branch via the REST
/// contents API. An `actor` so the repo / default-branch caches are safe to touch
/// from the concurrent network calls the UI fires.
actor GitHubService {
    static let shared = GitHubService()

    private let apiBase = "https://api.github.com"

    // Repos and their default branches, fetched once per session.
    private var reposCache: [RepoInfo]?
    private var defaultBranchByFullName: [String: String] = [:]

    struct RepoInfo {
        let owner: String
        let repo: String
        let defaultBranch: String
    }

    // MARK: Decodables

    private struct RepoDTO: Decodable {
        let name: String
        let owner: Owner
        let default_branch: String
        struct Owner: Decodable { let login: String }
    }
    private struct RepoMeta: Decodable { let default_branch: String }
    private struct ContentDTO: Decodable {
        let type: String
        let name: String
        let path: String
        let sha: String
    }
    private struct BlobMeta: Decodable { let sha: String }
    private struct SearchResult: Decodable {
        let items: [Item]
        struct Item: Decodable { let name: String; let path: String }
    }

    // MARK: Path helpers

    private struct Coords {
        let owner: String?
        let repo: String?
        let inRepoPath: String
        let parts: [String]
    }

    private func parse(_ url: URL) -> Coords {
        let parts = url.path.split(separator: "/").map(String.init)
        return Coords(
            owner: parts.first,
            repo: parts.count > 1 ? parts[1] : nil,
            inRepoPath: parts.dropFirst(2).joined(separator: "/"),
            parts: parts)
    }

    /// Build an app-side `github:///…` URL from a `/owner/repo/…` path string.
    private func makeURL(_ path: String) -> URL {
        let p = path.hasPrefix("/") ? path : "/" + path
        let encoded = p.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? p
        return URL(string: "github://" + encoded) ?? githubRoot
    }

    private func sort(_ entries: [FileEntry]) -> [FileEntry] {
        entries.sorted { a, b in
            if a.isDirectory != b.isDirectory { return a.isDirectory }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    // MARK: Networking

    private func request(_ apiPath: String, accept: String = "application/vnd.github+json") async throws -> URLRequest {
        let token = try await GitHubAuth.shared.accessToken()
        var req = URLRequest(url: URL(string: apiBase + apiPath)!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue(accept, forHTTPHeaderField: "Accept")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        // Never serve these from cache: the same contents URL is fetched both as
        // raw bytes and as JSON metadata, and reads must be fresh after a commit.
        req.cachePolicy = .reloadIgnoringLocalCacheData
        return req
    }

    @discardableResult
    private func send(_ req: URLRequest) async throws -> Data {
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw GitHubError.api(0, "no response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw GitHubError.api(http.statusCode, String(data: data, encoding: .utf8) ?? "")
        }
        return data
    }

    /// Percent-encode an in-repo path for use in a contents API URL, keeping the
    /// path separators (matching the web backend's `encodeURIComponent(..)`).
    private func encodePath(_ p: String) -> String {
        p.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? p
    }

    // MARK: Repo discovery

    private func repos() async throws -> [RepoInfo] {
        if let reposCache { return reposCache }
        var all: [RepoInfo] = []
        for page in 1...20 {
            let req = try await request("/user/repos?per_page=100&sort=full_name&page=\(page)")
            let data = try await send(req)
            let batch = try JSONDecoder().decode([RepoDTO].self, from: data)
            for r in batch {
                let info = RepoInfo(owner: r.owner.login, repo: r.name, defaultBranch: r.default_branch)
                all.append(info)
                defaultBranchByFullName["\(info.owner)/\(info.repo)"] = info.defaultBranch
            }
            if batch.count < 100 { break }
        }
        reposCache = all
        return all
    }

    private func defaultBranch(_ owner: String, _ repo: String) async throws -> String {
        let key = "\(owner)/\(repo)"
        if let cached = defaultBranchByFullName[key] { return cached }
        let req = try await request("/repos/\(owner)/\(repo)")
        let data = try await send(req)
        let meta = try JSONDecoder().decode(RepoMeta.self, from: data)
        defaultBranchByFullName[key] = meta.default_branch
        return meta.default_branch
    }

    // MARK: Operations

    func list(_ url: URL) async throws -> [FileEntry] {
        let c = parse(url)

        // Root: the distinct owners of your repos, as folders.
        if c.parts.isEmpty {
            let owners = Array(Set(try await repos().map(\.owner)))
            return sort(owners.map { FileEntry(url: makeURL("/\($0)"), isDirectory: true) })
        }

        // "/owner": that owner's repositories, as folders.
        if c.parts.count == 1 {
            let mine = try await repos().filter { $0.owner == c.owner }
            return sort(mine.map { FileEntry(url: makeURL("/\($0.owner)/\($0.repo)"), isDirectory: true) })
        }

        // Inside a repo: contents at this path on the default branch.
        let owner = c.owner!, repo = c.repo!
        let branch = try await defaultBranch(owner, repo)
        let req = try await request(
            "/repos/\(owner)/\(repo)/contents/\(encodePath(c.inRepoPath))?ref=\(branch)")
        let data = try await send(req)
        // A directory returns an array; a single file returns an object.
        let items: [ContentDTO]
        if let arr = try? JSONDecoder().decode([ContentDTO].self, from: data) {
            items = arr
        } else {
            items = [try JSONDecoder().decode(ContentDTO.self, from: data)]
        }
        return sort(items
            .filter { !$0.name.hasPrefix(".") }
            .map { FileEntry(url: makeURL("/\(owner)/\(repo)/\($0.path)"), isDirectory: $0.type == "dir") })
    }

    func read(_ url: URL) async throws -> String {
        let data = try await rawData(url)
        guard let text = String(data: data, encoding: .utf8) else {
            throw FileService.FileError.notUTF8
        }
        return text
    }

    /// Raw bytes of a file (used for media, and as the basis for `read`).
    func rawData(_ url: URL) async throws -> Data {
        let c = parse(url)
        guard let owner = c.owner, let repo = c.repo, !c.inRepoPath.isEmpty else {
            throw GitHubError.api(0, "not a file: \(url.path)")
        }
        let branch = try await defaultBranch(owner, repo)
        let req = try await request(
            "/repos/\(owner)/\(repo)/contents/\(encodePath(c.inRepoPath))?ref=\(branch)",
            accept: "application/vnd.github.raw")
        return try await send(req)
    }

    func write(_ url: URL, _ content: String) async throws {
        let c = parse(url)
        guard let owner = c.owner, let repo = c.repo, !c.inRepoPath.isEmpty else {
            throw GitHubError.api(0, "not a file: \(url.path)")
        }
        let branch = try await defaultBranch(owner, repo)

        // Updating an existing file requires its current blob sha.
        let sha = try? await blobSHA(owner: owner, repo: repo, path: c.inRepoPath, branch: branch)
        try await put(owner: owner, repo: repo, path: c.inRepoPath,
                      message: "Update \(c.inRepoPath)", content: content, branch: branch, sha: sha)
    }

    func createFile(_ url: URL) async throws {
        let c = parse(url)
        guard let owner = c.owner, let repo = c.repo, !c.inRepoPath.isEmpty else {
            throw GitHubError.api(0, "cannot create file here: \(url.path)")
        }
        let branch = try await defaultBranch(owner, repo)
        if (try? await blobSHA(owner: owner, repo: repo, path: c.inRepoPath, branch: branch)) != nil {
            throw FileService.FileError.alreadyExists(url.lastPathComponent)
        }
        try await put(owner: owner, repo: repo, path: c.inRepoPath,
                      message: "Create \(c.inRepoPath)", content: "", branch: branch, sha: nil)
    }

    func createFolder(_ url: URL) async throws {
        // Git tracks files, not empty folders — commit a `.gitkeep` placeholder so
        // the new folder shows up in listings.
        let c = parse(url)
        guard let owner = c.owner, let repo = c.repo, !c.inRepoPath.isEmpty else {
            throw GitHubError.api(0, "cannot create folder here: \(url.path)")
        }
        let branch = try await defaultBranch(owner, repo)
        if (try? await blobSHA(owner: owner, repo: repo, path: c.inRepoPath, branch: branch)) != nil {
            throw FileService.FileError.alreadyExists(url.lastPathComponent)
        }
        let keep = "\(c.inRepoPath)/.gitkeep"
        try await put(owner: owner, repo: repo, path: keep,
                      message: "Create \(c.inRepoPath)/", content: "", branch: branch, sha: nil)
    }

    func search(_ url: URL, query: String) async throws -> [FileEntry] {
        let c = parse(url)
        // Code search is only available scoped to a repository.
        guard let owner = c.owner, let repo = c.repo else { return [] }
        let q = "\(query) repo:\(owner)/\(repo)"
        let encoded = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q
        let req = try await request("/search/code?per_page=100&q=\(encoded)")
        guard let data = try? await send(req),
              let result = try? JSONDecoder().decode(SearchResult.self, from: data)
        else { return [] }
        return sort(result.items
            .filter { c.inRepoPath.isEmpty || $0.path.hasPrefix(c.inRepoPath) }
            .map { FileEntry(url: makeURL("/\(owner)/\(repo)/\($0.path)"), isDirectory: false) })
    }

    // MARK: Low-level

    private func blobSHA(owner: String, repo: String, path: String, branch: String) async throws -> String {
        let req = try await request(
            "/repos/\(owner)/\(repo)/contents/\(encodePath(path))?ref=\(branch)")
        let data = try await send(req)
        return try JSONDecoder().decode(BlobMeta.self, from: data).sha
    }

    private func put(owner: String, repo: String, path: String,
                     message: String, content: String, branch: String, sha: String?) async throws {
        var req = try await request("/repos/\(owner)/\(repo)/contents/\(encodePath(path))")
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = [
            "message": message,
            "content": Data(content.utf8).base64EncodedString(),
            "branch": branch,
        ]
        if let sha { body["sha"] = sha }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        try await send(req)
    }
}
