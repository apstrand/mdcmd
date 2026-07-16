import MobileCoreServices
import ObjectiveC
import SwiftRs
import Tauri
import UIKit
import UniformTypeIdentifiers
import WebKit

class ReleaseArgs: Decodable {
  let path: String
}

class DocpickerPlugin: Plugin, UIDocumentPickerDelegate {
  /// The `pick_folder` invoke waiting for the picker to finish.
  private var pendingInvoke: Invoke?

  // MARK: - Lifecycle

  // Install the "open in place" interceptor as soon as the webview is set up.
  // This runs while the app is starting (before the OS delivers an opened
  // document), so we can start the file's security scope before Tauri reports
  // the path to the frontend.
  @objc public override func load(webview: WKWebView) {
    DocpickerPlugin.installOpenInPlaceInterceptorOnce()
  }

  // MARK: - Commands

  /// Present the folder picker. Resolves `{ folder: { path, name } }` on pick,
  /// or `{ folder: null }` on cancel.
  @objc public func pickFolder(_ invoke: Invoke) {
    DispatchQueue.main.async {
      if let stale = self.pendingInvoke {
        stale.resolve(["folder": NSNull()])
      }
      self.pendingInvoke = invoke

      let picker: UIDocumentPickerViewController
      if #available(iOS 14.0, *) {
        picker = UIDocumentPickerViewController(
          forOpeningContentTypes: [UTType.folder], asCopy: false)
      } else {
        picker = UIDocumentPickerViewController(
          documentTypes: [kUTTypeFolder as String], in: .open)
      }
      picker.delegate = self
      picker.allowsMultipleSelection = false
      picker.modalPresentationStyle = .fullScreen

      guard let top = self.topViewController() else {
        self.pendingInvoke = nil
        invoke.reject("No view controller available to present the picker")
        return
      }
      top.present(picker, animated: true, completion: nil)
    }
  }

  /// Re-activate every saved bookmark (picked folders and opened files) so they
  /// are readable again after relaunch. Resolves `{ paths: [String] }`.
  @objc public func restoreAccess(_ invoke: Invoke) {
    var store = DocpickerPlugin.loadBookmarks()
    var active: [String] = []
    var changed = false

    for (key, data) in store {
      var stale = false
      guard
        let url = try? URL(
          resolvingBookmarkData: data, options: [], relativeTo: nil,
          bookmarkDataIsStale: &stale)
      else {
        store.removeValue(forKey: key)
        changed = true
        continue
      }

      if url.startAccessingSecurityScopedResource() {
        active.append(url.path)
      }

      if stale,
        let fresh = try? url.bookmarkData(
          options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
      {
        store[key] = fresh
        changed = true
      }
    }

    if changed { DocpickerPlugin.saveBookmarks(store) }
    invoke.resolve(["paths": active])
  }

  /// Stop accessing and forget the bookmark for a folder (on unpin).
  @objc public func releaseFolder(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ReleaseArgs.self)
    var store = DocpickerPlugin.loadBookmarks()

    if let data = store[args.path] {
      var stale = false
      if let url = try? URL(
        resolvingBookmarkData: data, options: [], relativeTo: nil,
        bookmarkDataIsStale: &stale)
      {
        url.stopAccessingSecurityScopedResource()
      }
    }

    store.removeValue(forKey: args.path)
    DocpickerPlugin.saveBookmarks(store)
    invoke.resolve([:])
  }

  // MARK: - UIDocumentPickerDelegate

  func documentPicker(
    _ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]
  ) {
    guard let invoke = pendingInvoke else { return }
    pendingInvoke = nil

    guard let url = urls.first else {
      invoke.resolve(["folder": NSNull()])
      return
    }

    _ = url.startAccessingSecurityScopedResource()

    do {
      let data = try url.bookmarkData(
        options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
      var store = DocpickerPlugin.loadBookmarks()
      store[url.path] = data
      DocpickerPlugin.saveBookmarks(store)
      invoke.resolve([
        "folder": ["path": url.path, "name": url.lastPathComponent]
      ])
    } catch {
      url.stopAccessingSecurityScopedResource()
      invoke.reject("Failed to bookmark folder: \(error.localizedDescription)")
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    guard let invoke = pendingInvoke else { return }
    pendingInvoke = nil
    invoke.resolve(["folder": NSNull()])
  }

  // MARK: - Open in place (files opened via the system "Open With" menu)

  private static var interceptorInstalled = false
  private static var originalOpenURLImp: IMP?

  // Tauri/tao parses the opened file URL but never starts its security scope, so
  // the Rust side can't read the original file in place. Swizzle the app
  // delegate's `application(_:open:options:)` to start accessing (and bookmark)
  // the URL first, then forward to tao — which still emits the path to Rust, now
  // reachable by the normal file commands.
  static func installOpenInPlaceInterceptorOnce() {
    if interceptorInstalled { return }
    guard let delegate = UIApplication.shared.delegate,
      let cls: AnyClass = object_getClass(delegate)
    else { return }
    let sel = #selector(UIApplicationDelegate.application(_:open:options:))
    guard let method = class_getInstanceMethod(cls, sel) else { return }

    let block: @convention(block) (Any, UIApplication, URL, NSDictionary) -> Bool = {
      (receiver, app, url, options) in
      DocpickerPlugin.activateAndBookmark(url)
      if let imp = DocpickerPlugin.originalOpenURLImp {
        typealias Fn = @convention(c) (Any, Selector, UIApplication, URL, NSDictionary) -> Bool
        return unsafeBitCast(imp, to: Fn.self)(receiver, sel, app, url, options)
      }
      return true
    }

    originalOpenURLImp = method_getImplementation(method)
    method_setImplementation(method, imp_implementationWithBlock(block))
    interceptorInstalled = true
  }

  static func activateAndBookmark(_ url: URL) {
    guard url.isFileURL else { return }
    _ = url.startAccessingSecurityScopedResource()
    if let data = try? url.bookmarkData(
      options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
    {
      var store = loadBookmarks()
      store[url.path] = data
      saveBookmarks(store)
    }
  }

  // MARK: - Helpers

  private func topViewController() -> UIViewController? {
    let keyWindow =
      UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }
    var top = keyWindow?.rootViewController
    while let presented = top?.presentedViewController {
      top = presented
    }
    return top
  }

  private static let bookmarksKey = "docpicker.bookmarks"

  static func loadBookmarks() -> [String: Data] {
    (UserDefaults.standard.dictionary(forKey: bookmarksKey) as? [String: Data]) ?? [:]
  }

  static func saveBookmarks(_ store: [String: Data]) {
    UserDefaults.standard.set(store, forKey: bookmarksKey)
  }
}

@_cdecl("init_plugin_docpicker")
func initPlugin() -> Plugin {
  return DocpickerPlugin()
}
