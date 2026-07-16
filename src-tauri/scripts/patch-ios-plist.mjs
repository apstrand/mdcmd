// Injects the Markdown document-type registration into the generated iOS
// Info.plist so mdcmd appears in the system "Open With" / share menu for .md
// files (and receives them on open).
//
// The `src-tauri/gen` folder is gitignored and `tauri ios dev/build` does not
// re-run xcodegen, so edits to project.yml don't reach the build. This script
// is committed and wired into `beforeDevCommand` / `beforeBuildCommand`, so the
// keys are re-applied on every build and survive `gen` being regenerated.
//
// Idempotent: it deletes any prior managed keys and re-adds them. No-op when the
// plist or PlistBuddy is absent (e.g. desktop builds / non-macOS).

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const plist = join(here, "..", "gen", "apple", "mdcmd_iOS", "Info.plist");
const pb = "/usr/libexec/PlistBuddy";

if (!existsSync(plist) || !existsSync(pb)) {
  process.exit(0);
}

const del = (entry) => {
  try {
    execFileSync(pb, ["-c", `Delete :${entry}`, plist], { stdio: "ignore" });
  } catch {
    // key absent — fine
  }
};
const add = (entry, type, value) => {
  const cmd = value === undefined ? `Add :${entry} ${type}` : `Add :${entry} ${type} ${value}`;
  execFileSync(pb, ["-c", cmd, plist]);
};

// Reset managed keys so re-runs stay idempotent.
del("CFBundleDocumentTypes");
del("UTImportedTypeDeclarations");
del("LSSupportsOpeningDocumentsInPlace");

// Open documents in place (edit the original file). The docpicker plugin
// swizzles application(open:) to start the security scope so the in-place URL
// is readable/writable by the normal file commands.
add("LSSupportsOpeningDocumentsInPlace", "bool", "true");

// Declare mdcmd as a Markdown handler → shows up in Open With / share sheet.
add("CFBundleDocumentTypes", "array");
add("CFBundleDocumentTypes:0", "dict");
add("CFBundleDocumentTypes:0:CFBundleTypeName", "string", "'Markdown Document'");
add("CFBundleDocumentTypes:0:CFBundleTypeRole", "string", "Editor");
add("CFBundleDocumentTypes:0:LSHandlerRank", "string", "Alternate");
add("CFBundleDocumentTypes:0:LSItemContentTypes", "array");
add("CFBundleDocumentTypes:0:LSItemContentTypes:0", "string", "net.daringfireball.markdown");
add("CFBundleDocumentTypes:0:LSItemContentTypes:1", "string", "public.plain-text");

// Declare the markdown UTI so .md / .markdown / … map to it.
add("UTImportedTypeDeclarations", "array");
add("UTImportedTypeDeclarations:0", "dict");
add("UTImportedTypeDeclarations:0:UTTypeIdentifier", "string", "net.daringfireball.markdown");
add("UTImportedTypeDeclarations:0:UTTypeDescription", "string", "'Markdown Document'");
add("UTImportedTypeDeclarations:0:UTTypeConformsTo", "array");
add("UTImportedTypeDeclarations:0:UTTypeConformsTo:0", "string", "public.plain-text");
add("UTImportedTypeDeclarations:0:UTTypeTagSpecification", "dict");
add("UTImportedTypeDeclarations:0:UTTypeTagSpecification:public.filename-extension", "array");
["md", "markdown", "mdown", "qmd"].forEach((ext, i) =>
  add(`UTImportedTypeDeclarations:0:UTTypeTagSpecification:public.filename-extension:${i}`, "string", ext),
);

console.log("[patch-ios-plist] applied Markdown document types to", plist);
