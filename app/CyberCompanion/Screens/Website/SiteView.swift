import SwiftUI
import WebKit

/// A live preview of the website the assistant built, loaded file by file from the server.
struct SiteView: View {
    @Environment(AppModel.self) private var model
    @State private var site: SiteResponse?
    @State private var page: WebPage?
    @State private var loadError: String?
    @State private var showFiles = false

    var body: some View {
        NavigationStack {
            Group {
                if !model.isConfigured {
                    ContentUnavailableView("Not signed in", systemImage: "person.crop.circle.badge.exclamationmark",
                                           description: Text("Sign in to see your website."))
                } else if let loadError {
                    ContentUnavailableView("Couldn't load the website", systemImage: "exclamationmark.triangle", description: Text(loadError))
                } else if let site, site.files.isEmpty {
                    ContentUnavailableView("No website yet", systemImage: "globe",
                                           description: Text("Choose Website on the Create tab and tell Hera what you'd like, for example: \u{201C}Make a one-page website for my bakery.\u{201D}"))
                } else if let page {
                    WebView(page)
                        .webViewBackForwardNavigationGestures(.enabled)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.cornerRadius, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: Theme.cornerRadius, style: .continuous)
                                .strokeBorder(Theme.spectrumGradient.opacity(0.5), lineWidth: 1)
                        }
                        .shadow(color: Theme.spectrum[1].opacity(0.3), radius: 30, y: 12)
                        .padding(16)
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .auroraBackground()
            .navigationTitle("Website")
            .toolbar {
                ToolbarItemGroup {
                    if let site, !site.files.isEmpty {
                        Button("Files and checks", systemImage: "list.bullet.rectangle") { showFiles = true }
                    }
                    Button("Reload", systemImage: "arrow.clockwise") { Task { await load() } }
                }
            }
            .sheet(isPresented: $showFiles) {
                if let site { SiteDetailsSheet(site: site) }
            }
            .task(id: "\(model.serverURLString)|\(model.accessToken)|\(model.session.isSignedIn)") { await load() }
        }
    }

    private func load() async {
        guard let client = model.client else { return }
        do {
            let latest = try await client.site()
            site = latest
            loadError = nil
            guard !latest.files.isEmpty else { page = nil; return }
            if page == nil { page = makePage(client: client) }
            page?.load(URL(string: "\(SiteSchemeHandler.scheme)://site/index.html"))
        } catch {
            loadError = error.localizedDescription
        }
    }

    /// The preview shows AI-written pages, so it's locked down: it can only show the site's own
    /// files (no navigating to other websites, where a fake sign-in page could be waiting), runs
    /// no scripts (nothing can send the page's contents anywhere), keeps nothing between visits,
    /// and every file comes with a strict security policy as a second line of defence.
    private func makePage(client: APIClient) -> WebPage {
        var configuration = WebPage.Configuration()
        if let scheme = URLScheme(SiteSchemeHandler.scheme) {
            configuration.urlSchemeHandlers[scheme] = SiteSchemeHandler(client: client)
        }
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultNavigationPreferences.allowsContentJavaScript = false
        return WebPage(configuration: configuration, navigationDecider: SitePreviewNavigation())
    }
}

private struct SiteDetailsSheet: View {
    let site: SiteResponse
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if site.checks.isEmpty {
                        Label("No problems found", systemImage: "checkmark.circle").foregroundStyle(.green)
                    } else {
                        CheckList(checks: site.checks)
                    }
                } header: {
                    SectionLabel("Checks")
                }
                Section {
                    ForEach(site.files) { file in
                        LabeledContent {
                            Text(file.bytes.formatted(.byteCount(style: .file))).monospacedDigit()
                        } label: {
                            Label(file.path, systemImage: "doc.text")
                        }
                    }
                } header: {
                    SectionLabel("Files")
                }
            }
            .navigationTitle("Your website")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .frame(minWidth: 360, minHeight: 400)
    }
}

/// Keeps the preview on the site's own files: anything else (another website, a mailto: link,
/// another app's URL) is refused rather than opened inside Hera.
struct SitePreviewNavigation: WebPage.NavigationDeciding {
    static func allows(_ url: URL?) -> Bool {
        url?.scheme?.lowercased() == SiteSchemeHandler.scheme && url?.host() == "site"
    }

    mutating func decidePolicy(for action: WebPage.NavigationAction, preferences: inout WebPage.NavigationPreferences) async -> WKNavigationActionPolicy {
        Self.allows(action.request.url) ? .allow : .cancel
    }
}

/// Serves the site's files to the preview from the server, so relative links to CSS, images and
/// other pages work exactly as they will once published.
struct SiteSchemeHandler: URLSchemeHandler {
    static let scheme = "ccsite"
    let client: APIClient

    func reply(for request: URLRequest) -> AsyncThrowingStream<URLSchemeTaskResult, any Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    guard let url = request.url else { throw URLError(.badURL) }
                    var path = url.path(percentEncoded: false)
                    while path.hasPrefix("/") { path.removeFirst() }
                    if path.isEmpty || path.hasSuffix("/") { path += "index.html" }

                    let data = Data(try await client.siteFile(path).utf8)
                    // A real HTTP response, so the security policy header applies to every file.
                    let headers = [
                        "Content-Type": "\(Self.mimeType(for: path)); charset=utf-8",
                        "Content-Security-Policy": Self.contentSecurityPolicy,
                    ]
                    let response: URLResponse = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)
                        ?? URLResponse(url: url, mimeType: Self.mimeType(for: path), expectedContentLength: data.count, textEncodingName: "utf-8")
                    continuation.yield(.response(response))
                    continuation.yield(.data(data))
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// No scripts, no connections out, no forms, no frames: the preview only shows the page.
    static let contentSecurityPolicy = "default-src ccsite: data:; img-src ccsite: data: https:; style-src ccsite: 'unsafe-inline'; font-src ccsite: data: https:; script-src 'none'; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'"

    static func mimeType(for path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "html", "htm": "text/html"
        case "css": "text/css"
        case "js", "mjs": "text/javascript"
        case "json": "application/json"
        case "svg": "image/svg+xml"
        case "txt": "text/plain"
        case "xml": "application/xml"
        default: "application/octet-stream"
        }
    }
}

#Preview {
    SiteView()
        .environment(AppModel())
}
