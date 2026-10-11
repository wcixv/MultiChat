import SwiftUI

// MARK: - Look

private enum Theme {
    static let accent = Color(red: 1.0, green: 0.88, blue: 0.30)       // highlighter yellow, like the PC app
    static let twitch = Color(red: 0.55, green: 0.24, blue: 1.0)
    static let kick = Color(red: 0.32, green: 0.96, blue: 0.07)
    static let youtube = Color(red: 0.96, green: 0.21, blue: 0.17)
    static let good = Color(red: 0.32, green: 0.96, blue: 0.07)
    static let bad = Color(red: 1.0, green: 0.35, blue: 0.31)
}

private func platformName(_ key: String) -> String {
    switch key {
    case "twitch": return "Twitch"
    case "kick": return "Kick"
    case "youtube": return "YouTube"
    default: return key.capitalized
    }
}

private func platformColor(_ key: String) -> Color {
    switch key {
    case "twitch": return Theme.twitch
    case "kick": return Theme.kick
    case "youtube": return Theme.youtube
    default: return .gray
    }
}

// MARK: - Root

struct RootView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView {
            HitsView()
                .tabItem { Label("Giveaways", systemImage: "gift.fill") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
        }
        .tint(Theme.accent)
        .task { await model.start() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.refresh(); await model.refreshPushStatus() } }
        }
    }
}

// MARK: - Giveaway list

struct HitsView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        NavigationStack {
            List {
                ForEach(model.hits) { hit in
                    Button { model.selected = hit } label: { HitRow(hit: hit) }
                        .buttonStyle(.plain)
                }
            }
            .overlay {
                if model.hits.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: "gift").font(.system(size: 40)).foregroundStyle(.secondary)
                        Text(model.isConfigured ? "No giveaways yet" : "Add your server in Settings")
                            .font(.headline)
                        Text(model.isConfigured
                             ? "When a streamer announces one, you get a notification and it shows up here."
                             : "MultiChat needs your server's address and key to watch chat for you.")
                            .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                    }
                }
            }
            .refreshable { await model.refresh() }
            .navigationTitle("Giveaways")
            .sheet(item: $model.selected) { hit in
                EnterView(hit: hit).environmentObject(model)
            }
        }
    }
}

struct HitRow: View {
    let hit: Hit

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(hit.title).font(.headline)
                Spacer()
                if let at = hit.at {
                    Text(Date(timeIntervalSince1970: at / 1000), style: .relative)
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if let word = hit.command {
                Text(hit.isCrowd ? "Chat is typing \(word)" : "Type \(word) to enter")
                    .font(.system(.body, design: .monospaced)).foregroundStyle(Theme.accent)
            } else {
                Text("The word is only shown on the stream").font(.subheadline).foregroundStyle(.secondary)
            }
            Text(hit.text).font(.caption).foregroundStyle(.secondary).lineLimit(2)
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Enter screen (you press the button)

struct EnterView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    let hit: Hit
    @State private var word: String
    @State private var account: String
    @State private var busy = false
    @State private var response: EnterResponse?
    @State private var errorText: String?

    init(hit: Hit) {
        self.hit = hit
        _word = State(initialValue: hit.command ?? "")
        _account = State(initialValue: Stored.defaultAccount)
    }

    private var failedPlatforms: [String] {
        (response?.results ?? [:]).filter { $0.value.status == "failed" }.map { $0.key }.sorted()
    }
    private var allDone: Bool {
        guard let r = response, !r.results.isEmpty || r.test == true else { return false }
        return failedPlatforms.isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(hit.title).font(.headline)
                    Text(hit.text).font(.subheadline).foregroundStyle(.secondary)
                    if hit.command == nil {
                        Text("The word is only shown on the stream. Look at it, then type it below.")
                            .font(.footnote).foregroundStyle(Theme.accent)
                    }
                }

                Section("Word to type in chat") {
                    TextField("!word", text: $word)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.body, design: .monospaced))
                }

                Section {
                    Picker("Enter as", selection: $account) {
                        ForEach(model.accounts) { Text($0.name).tag($0.name) }
                    }
                } footer: {
                    Text("One account. It enters on every chat where the streamer is live and that account is logged in.")
                }

                Section {
                    Button {
                        Task { await enter(only: nil) }
                    } label: {
                        HStack {
                            Spacer()
                            if busy { ProgressView() }
                            Text(busy ? "Entering..." : (hit.isTest ? "Enter (test only)" : "Enter giveaway")).bold()
                            Spacer()
                        }
                    }
                    .disabled(busy || allDone || word.trimmingCharacters(in: .whitespaces).isEmpty)

                    if !failedPlatforms.isEmpty {
                        Button("Retry the ones that failed") { Task { await enter(only: failedPlatforms) } }
                            .disabled(busy)
                    }
                } footer: {
                    Text("Nothing is sent until you press this. Check the streamer's giveaway rules first.")
                }

                if let r = response {
                    Section("Result") {
                        if r.test == true { Text("This was only a test. Nothing was sent to any chat.") }
                        ForEach(r.results.keys.sorted(), id: \.self) { key in
                            HStack(alignment: .top) {
                                Text(platformName(key)).foregroundStyle(platformColor(key)).bold()
                                Spacer()
                                Text(describe(r.results[key]!)).multilineTextAlignment(.trailing)
                                    .foregroundStyle(color(for: r.results[key]!))
                            }
                        }
                    }
                }
                if let errorText {
                    Section { Text(errorText).foregroundStyle(Theme.bad) }
                }
            }
            .navigationTitle("Enter giveaway")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .task { if model.accounts.isEmpty { await model.refresh() } }
        }
    }

    private func enter(only platforms: [String]?) async {
        busy = true
        errorText = nil
        defer { busy = false }
        do {
            let trimmed = word.trimmingCharacters(in: .whitespacesAndNewlines)
            let result = try await model.enter(hit: hit, word: trimmed, account: account, platforms: platforms)
            if platforms == nil || response == nil {
                response = result
            } else if var merged = response {            // keep earlier successes when retrying
                var all = merged.results
                for (k, v) in result.results { all[k] = v }
                merged = EnterResponse(results: all, summary: result.summary, test: result.test)
                response = merged
            }
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func describe(_ r: PlatformResult) -> String {
        switch r.status {
        case "sent": return "Entered"
        case "already": return "Already entered"
        case "offline": return "Streamer is offline there"
        case "no-channel": return "No channel set for this creator"
        case "busy": return "Already working on it"
        case "failed": return "Not sent: \(r.detail ?? "unknown error")"
        default: return r.status
        }
    }

    private func color(for r: PlatformResult) -> Color {
        switch r.status {
        case "sent", "already": return Theme.good
        case "failed": return Theme.bad
        default: return .secondary
        }
    }
}

// MARK: - Settings

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://your-server.example.com", text: $model.serverURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    SecureField("Server key", text: $model.apiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button {
                        Task { busy = true; await model.saveAndConnect(); busy = false }
                    } label: {
                        HStack { if busy { ProgressView() }; Text("Save and connect").bold() }
                    }
                    .disabled(busy)
                    if !model.connection.isEmpty {
                        Text(model.connection).font(.footnote).foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Your server")
                } footer: {
                    Text("The server watches chat all day and tells this phone. The key is saved in the iPhone Keychain.")
                }

                Section {
                    Text(model.pushStatus).font(.footnote)
                    Button("Allow notifications") { model.requestPush() }
                    Button("Send a test notification") { Task { await model.sendTestNotification() } }
                        .disabled(!model.isConfigured)
                } header: {
                    Text("Notifications")
                } footer: {
                    Text("The test notification shows what a giveaway alert looks like. Pressing Enter on it sends nothing to any chat.")
                }

                Section {
                    Picker("Notification button enters as", selection: Binding(
                        get: { model.defaultAccount }, set: { model.setDefaultAccount($0) })) {
                        ForEach(model.accounts.isEmpty ? [AccountInfo(name: "Main", platforms: [])] : model.accounts) {
                            Text($0.name).tag($0.name)
                        }
                    }
                } header: {
                    Text("Account")
                } footer: {
                    Text("The Enter button on a notification uses this one account. In the app you can pick a different one each time.")
                }

                Section {
                    Text("MultiChat only reads chat text. It never watches the video and never enters by itself: you always press Enter. Follow each streamer's giveaway rules.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
        }
    }
}
