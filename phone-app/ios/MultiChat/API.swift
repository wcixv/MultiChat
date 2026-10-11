import Foundation

// MARK: - What the server sends and receives

struct Hit: Codable, Identifiable, Hashable {
    let id: String
    let channel: String
    let creator: String
    let command: String?
    let text: String
    let crowd: Bool?
    let test: Bool?
    let user: String?
    let at: Double?

    var isCrowd: Bool { crowd ?? false }
    var isTest: Bool { test ?? false }
    var title: String { isCrowd ? "Maybe a giveaway on \(creator)" : "Giveaway on \(creator)" }
}

struct HitsResponse: Codable { let hits: [Hit] }

struct AccountInfo: Codable, Identifiable, Hashable {
    let name: String
    let platforms: [String]
    var id: String { name }
}

struct CreatorInfo: Codable, Hashable {
    let name: String
    let twitch: String
    let kick: String
    let youtube: String
}

struct AccountsResponse: Codable {
    let accounts: [AccountInfo]
    let creators: [CreatorInfo]
}

struct PlatformResult: Codable, Hashable {
    let status: String
    let detail: String?
}

struct EnterResponse: Codable {
    let results: [String: PlatformResult]
    let summary: String?
    let test: Bool?
}

struct EnterRequest: Encodable {
    let hitId: String?
    let creator: String?
    let word: String
    let account: String
    let platforms: [String]?
}

struct RegisterRequest: Encodable { let deviceToken: String }
struct RegisterResponse: Codable { let ok: Bool; let devices: Int }
struct HealthResponse: Codable { let ok: Bool; let watching: Int }
struct TestPushResponse: Codable { let devices: Int; let pushConfigured: Bool }
private struct ServerError: Decodable { let error: String }

enum APIError: LocalizedError {
    case notConfigured
    case badURL
    case server(String)
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "Add your server address and key in Settings first."
        case .badURL: return "That server address does not look right."
        case .server(let message): return message
        case .transport(let message): return "Could not reach the server: \(message)"
        }
    }
}

// MARK: - Settings that live outside the UI (the notification buttons need them too)

enum Stored {
    static var serverURL: String {
        get { UserDefaults.standard.string(forKey: "serverURL") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "serverURL") }
    }
    static var apiKey: String {
        get { Keychain.get("apiKey") }
        set { Keychain.set(newValue, for: "apiKey") }
    }
    static var defaultAccount: String {
        get { UserDefaults.standard.string(forKey: "defaultAccount") ?? "Main" }
        set { UserDefaults.standard.set(newValue, forKey: "defaultAccount") }
    }
}

// MARK: - Talking to your server

struct APIClient {
    let base: URL
    let key: String

    init() throws {
        var text = Stored.serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = Stored.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !key.isEmpty else { throw APIError.notConfigured }
        if !text.lowercased().hasPrefix("http") { text = "https://" + text }
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text), url.host != nil else { throw APIError.badURL }
        self.base = url
        self.key = key
    }

    private func run<T: Decodable>(_ method: String, _ path: String, body: Data? = nil, as type: T.Type, auth: Bool = true) async throws -> T {
        guard let url = URL(string: base.absoluteString + path) else { throw APIError.badURL }
        var request = URLRequest(url: url, timeoutInterval: 25)
        request.httpMethod = method
        if auth { request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw APIError.transport(error.localizedDescription)
        }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            if let e = try? JSONDecoder().decode(ServerError.self, from: data) { throw APIError.server(e.error) }
            throw APIError.server("The server answered with error \(code).")
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.server("The server's answer was not what I expected.")
        }
    }

    func health() async throws -> HealthResponse { try await run("GET", "/health", as: HealthResponse.self, auth: false) }
    func hits() async throws -> [Hit] { try await run("GET", "/hits", as: HitsResponse.self).hits }
    func accounts() async throws -> AccountsResponse { try await run("GET", "/accounts", as: AccountsResponse.self) }

    func register(deviceToken: String) async throws {
        let body = try JSONEncoder().encode(RegisterRequest(deviceToken: deviceToken))
        _ = try await run("POST", "/register", body: body, as: RegisterResponse.self)
    }

    func testPush() async throws -> TestPushResponse {
        try await run("POST", "/test-push", body: Data("{}".utf8), as: TestPushResponse.self)
    }

    /// Enters ONE giveaway as ONE account. The server refuses to enter the same word twice.
    func enter(_ request: EnterRequest) async throws -> EnterResponse {
        let body = try JSONEncoder().encode(request)
        return try await run("POST", "/enter", body: body, as: EnterResponse.self)
    }
}
