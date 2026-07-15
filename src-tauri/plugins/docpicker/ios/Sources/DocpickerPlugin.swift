import MobileCoreServices
import SwiftRs
import Tauri
import UIKit
import UniformTypeIdentifiers
import WebKit

class ReleaseArgs: Decodable {
  let path: String
}

class DocpickerPlugin: Plugin, UIDocumentPickerDelegate {
  /// The `pick_folder` invoke waiting for the picker to finish. The picker is
  /// modal, so at most one can be outstanding.
  private var pendingInvoke: Invoke?

  /// UserDefaults key holding `[path: security-scoped bookmark data]`.
  private let bookmarksKey = "docpicker.bookmarks"

  // MARK: - Commands

  /// Present the folder picker. Resolves `{ folder: { path, name } }` on pick,
  /// or `{ folder: null }` on cancel.
  @objc public func pickFolder(_ invoke: Invoke) {
    DispatchQueue.main.async {
      // If a previous picker never reported back, don't strand it silently.
      if let stale = self.pendingInvoke {
        stale.resolve(["folder": NSNull()])
      }
      self.pendingInvoke = invoke

      // swift-rs may build this package with a deployment target below iOS 14,
      // so guard the newer picker API and fall back to the pre-14 initializer.
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

  /// Re-activate every saved bookmark so previously-picked folders are readable
  /// again after relaunch. Resolves `{ paths: [String] }`.
  @objc public func restoreAccess(_ invoke: Invoke) {
    var store = loadBookmarks()
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

      if stale, url.startAccessingSecurityScopedResource(),
        let fresh = try? url.bookmarkData(
          options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
      {
        store[key] = fresh
        changed = true
      }
    }

    if changed { saveBookmarks(store) }
    invoke.resolve(["paths": active])
  }

  /// Stop accessing and forget the bookmark for a folder (on unpin).
  @objc public func releaseFolder(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ReleaseArgs.self)
    var store = loadBookmarks()

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
    saveBookmarks(store)
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

    // Keep the resource open for the rest of the session so the Rust side's
    // std::fs calls can read/write inside the folder.
    _ = url.startAccessingSecurityScopedResource()

    do {
      let data = try url.bookmarkData(
        options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
      var store = loadBookmarks()
      store[url.path] = data
      saveBookmarks(store)
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

  private func loadBookmarks() -> [String: Data] {
    (UserDefaults.standard.dictionary(forKey: bookmarksKey) as? [String: Data]) ?? [:]
  }

  private func saveBookmarks(_ store: [String: Data]) {
    UserDefaults.standard.set(store, forKey: bookmarksKey)
  }
}

@_cdecl("init_plugin_docpicker")
func initPlugin() -> Plugin {
  return DocpickerPlugin()
}
