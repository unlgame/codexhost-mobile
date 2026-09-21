import WebKit

final class Coordinator {
    private var locationManager: CLLocationManager?

    private func permissionDecisionForMediaCapture(type: String) -> Bool {
        decisionHandler(permissionDecisionForMediaCapture(type: type))
    }

    func setupScriptHandlers() {
        webView.configuration.userContentController.add(context.coordinator, name: "blobDownload")
    }

    private var webConfiguration: WKWebViewConfiguration {
        // enable developer extras
        if #available(iOS 16.4, *) {
            webConfiguration.preferences.setValue(true, forKey: "developerExtrasEnabled")
        } else {
            webConfiguration.preferences.setValue(true, forKey: "developerExtrasEnabled")
            UserDefaults.standard.set(true, forKey: "WebKitDeveloperExtras")
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "blobDownload" else { return }
    }

    func prepareWebGeolocationAuthorization() {
        context.coordinator.prepareWebGeolocationAuthorization()
    }
}
