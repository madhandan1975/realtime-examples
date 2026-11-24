import AVFoundation
import Capacitor
import Foundation

/// Configures AVAudioSession so mic + remote playback can continue with the screen locked.
@objc(VoiceCallSessionPlugin)
public class VoiceCallSessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VoiceCallSessionPlugin"
    public let jsName = "VoiceCallSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private var interruptionObserver: NSObjectProtocol?
    private var routeObserver: NSObjectProtocol?

    @objc func start(_ call: CAPPluginCall) {
        guard let roomId = call.getString("roomId"), !roomId.isEmpty else {
            call.reject("roomId is required")
            return
        }

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker, .mixWithOthers]
            )
            try session.setActive(true, options: [])
            observeAudioInterruptions()
            call.resolve()
        } catch {
            call.reject("Failed to activate voice audio session: \(error.localizedDescription)")
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        clearObservers()
        do {
            try AVAudioSession.sharedInstance().setActive(
                false,
                options: [.notifyOthersOnDeactivation]
            )
            call.resolve()
        } catch {
            // Leaving the room should still succeed even if deactivation races another audio client.
            call.resolve()
        }
    }

    private func observeAudioInterruptions() {
        clearObservers()
        let center = NotificationCenter.default
        interruptionObserver = center.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            self?.handleInterruption(notification)
        }
        routeObserver = center.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { _ in
            // Keep session active after Bluetooth / speaker route changes.
            try? AVAudioSession.sharedInstance().setActive(true)
        }
    }

    private func handleInterruption(_ notification: Notification) {
        guard
            let info = notification.userInfo,
            let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: typeValue)
        else {
            return
        }

        if type == .ended {
            try? AVAudioSession.sharedInstance().setActive(true)
        }
    }

    private func clearObservers() {
        if let interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
            self.interruptionObserver = nil
        }
        if let routeObserver {
            NotificationCenter.default.removeObserver(routeObserver)
            self.routeObserver = nil
        }
    }

    deinit {
        clearObservers()
    }
}
