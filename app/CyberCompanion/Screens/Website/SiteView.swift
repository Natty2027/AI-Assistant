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

    private func makePage(client: APIClient) -> WebPage {
        var configuration = WebPage.Configuration()
        if let scheme = URLScheme(SiteSchemeHandler.scheme) {
            configuration.urlSchemeHandlers[scheme] = SiteSchemeHandler(client: client)
        }
        return WebPage(configuration: configuration)
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
                    let response = URLResponse(url: url, mimeType: Self.mimeType(for: path),
                                               expectedContentLength: data.count, textEncodingName: "utf-8")
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
