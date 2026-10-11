import UIKit
import UserNotifications

/// Notification buttons. "Enter giveaway" is a button YOU press on the notification.
enum NotificationIDs {
    static let wordCategory = "GIVEAWAY_WORD"       // the word is known: one tap enters
    static let typeCategory = "GIVEAWAY_TYPE"       // the word is only on the stream: type it in the notification
    static let enter = "ENTER"
    static let enterTyped = "ENTER_TYPED"
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let enter = UNNotificationAction(identifier: NotificationIDs.enter, title: "Enter giveaway",
                                         options: [.authenticationRequired])
        let typed = UNTextInputNotificationAction(identifier: NotificationIDs.enterTyped, title: "Type the word and enter",
                                                  options: [.authenticationRequired], textInputButtonTitle: "Enter",
                                                  textInputPlaceholder: "!word")
        center.setNotificationCategories([
            UNNotificationCategory(identifier: NotificationIDs.wordCategory, actions: [enter], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: NotificationIDs.typeCategory, actions: [typed], intentIdentifiers: [], options: []),
        ])
        return true
    }

    // Apple gave this phone its push address.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in AppModel.shared.didGetPushToken(hex) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in
            AppModel.shared.pushStatus = "Apple would not give this phone a push address: \(error.localizedDescription)"
        }
    }

    // A giveaway alert arrived while the app is open: still show it.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        Task { @MainActor in await AppModel.shared.refresh() }
        return [.banner, .list, .sound]
    }

    // You tapped the notification or one of its buttons.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let hit = info["hit"] as? [String: Any], let hitID = hit["id"] as? String else { return }
        let creator = hit["creator"] as? String ?? ""

        var word: String?
        switch response.actionIdentifier {
        case NotificationIDs.enter:
            word = hit["command"] as? String
        case NotificationIDs.enterTyped:
            word = (response as? UNTextInputNotificationResponse)?.userText
        default:                                         // a plain tap: open the Enter screen
            await MainActor.run { AppModel.shared.openFromNotification(hitID: hitID) }
            return
        }

        let text = (word ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let message: String
        do {
            let client = try APIClient()
            let result = try await client.enter(EnterRequest(hitId: hitID, creator: creator, word: text,
                                                             account: Stored.defaultAccount, platforms: nil))
            message = result.summary ?? "Done."
        } catch {
            message = "Not entered: \(error.localizedDescription)"
        }
        let content = UNMutableNotificationContent()
        content.title = "Giveaway: \(creator)"
        content.body = message
        content.sound = .default
        try? await UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        await MainActor.run { Task { await AppModel.shared.refresh() } }
    }
}
