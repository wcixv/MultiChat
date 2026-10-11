import Foundation
import SwiftUI
import UIKit
import UserNotifications

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    @Published var serverURL: String = Stored.serverURL
    @Published var apiKey: String = Stored.apiKey
    @Published var defaultAccount: String = Stored.defaultAccount

    @Published var hits: [Hit] = []
    @Published var accounts: [AccountInfo] = []
    @Published var creators: [CreatorInfo] = []
    @Published var selected: Hit?              // the giveaway whose Enter screen is showing

    @Published var connection: String = ""     // result of the last connection check
    @Published var pushStatus: String = "Notifications not set up yet."
    @Published var pushToken: String?
    @Published var loading = false

    var isConfigured: Bool { (try? APIClient()) != nil }

    // MARK: start-up

    func start() async {
        await refreshPushStatus()
        if isConfigured {
            requestPush()
            await refresh()
        }
    }

    /// Saves the server details, then checks the connection and registers this phone.
    func saveAndConnect() async {
        Stored.serverURL = serverURL
        Stored.apiKey = apiKey
        connection = "Checking..."
        do {
            let client = try APIClient()
            let health = try await client.health()
            _ = try await client.accounts()          // fails with "Wrong key." if the key is wrong
            connection = "Connected. The server is watching \(health.watching) channel(s)."
            requestPush()
            await refresh()
        } catch {
            connection = error.localizedDescription
        }
    }

    func refresh() async {
        guard let client = try? APIClient() else { return }
        loading = true
        defer { loading = false }
        do {
            async let h = client.hits()
            async let a = client.accounts()
            let (newHits, info) = try await (h, a)
            hits = newHits
            accounts = info.accounts
            creators = info.creators
            if !accounts.contains(where: { $0.name == defaultAccount }) { setDefaultAccount("Main") }
        } catch {
            connection = error.localizedDescription
        }
    }

    func setDefaultAccount(_ name: String) {
        defaultAccount = name
        Stored.defaultAccount = name
    }

    // MARK: push notifications

    func refreshPushStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            pushStatus = pushToken == nil ? "Allowed. Waiting for Apple to give this phone an address..." : "Notifications are on."
        case .denied:
            pushStatus = "Notifications are off. Turn them on in the iPhone Settings app, under MultiChat."
        default:
            pushStatus = "Notifications not set up yet."
        }
    }

    func requestPush() {
        Task {
            let center = UNUserNotificationCenter.current()
            let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            if granted { UIApplication.shared.registerForRemoteNotifications() }
            await refreshPushStatus()
        }
    }

    func didGetPushToken(_ token: String) {
        pushToken = token
        Task {
            if let client = try? APIClient() {
                do {
                    try await client.register(deviceToken: token)
                    pushStatus = "Notifications are on. This phone is registered with your server."
                } catch {
                    pushStatus = "Got an address from Apple, but your server refused it: \(error.localizedDescription)"
                }
            } else {
                pushStatus = "Got an address from Apple. Add your server below to finish."
            }
        }
    }

    func sendTestNotification() async {
        do {
            let r = try await APIClient().testPush()
            if !r.pushConfigured { connection = "Your server has no Apple push settings yet (server.apns in config.json)." }
            else if r.devices == 0 { connection = "No phone is registered yet. Allow notifications first." }
            else { connection = "Test sent. It should arrive in a few seconds." }
            await refresh()
        } catch {
            connection = error.localizedDescription
        }
    }

    // MARK: entering

    /// You pressed Enter. One word, one account, every chat where the streamer is live.
    func enter(hit: Hit, word: String, account: String, platforms: [String]? = nil) async throws -> EnterResponse {
        let client = try APIClient()
        return try await client.enter(EnterRequest(hitId: hit.id, creator: hit.creator, word: word, account: account, platforms: platforms))
    }

    func openFromNotification(hitID: String) {
        Task {
            await refresh()
            if let hit = hits.first(where: { $0.id == hitID }) { selected = hit }
        }
    }
}
