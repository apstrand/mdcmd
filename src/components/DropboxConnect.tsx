import { useEffect, useState } from "react";
import { storage } from "../storage";
import { dropboxAuth } from "../storage/dropbox/auth";
import { Loader2, Cloud, AlertCircle } from "lucide-react";

// Gates rendering of the app on Dropbox authentication for the web build.
// On the desktop build (no auth required) it simply renders its children.
export default function DropboxConnect({ children }: { children: React.ReactNode }) {
  const requiresAuth = storage.capabilities.requiresAuth;
  const [ready, setReady] = useState(!requiresAuth);
  const [authed, setAuthed] = useState(!requiresAuth);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!requiresAuth) return;
    (async () => {
      try {
        await dropboxAuth.handleRedirectCallback();
      } catch (e) {
        setError(String(e));
      } finally {
        setAuthed(dropboxAuth.isAuthenticated);
        setReady(true);
      }
    })();
  }, [requiresAuth]);

  if (!requiresAuth || authed) return <>{children}</>;

  if (!ready) {
    return (
      <div className="no-file-selected" style={{ height: "100vh" }}>
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div
      className="no-file-selected"
      style={{ height: "100vh", flexDirection: "column", gap: "16px", textAlign: "center", padding: "24px" }}
    >
      <Cloud className="w-16 h-16 text-accent" />
      <h2 style={{ margin: 0, fontWeight: 600, fontSize: "22px" }}>MarkDown Commander</h2>

      {error && (
        <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "hsl(0, 84%, 60%)", fontSize: "13px" }}>
          <AlertCircle className="w-4 h-4" />
          <span>{error}</span>
        </div>
      )}

      {dropboxAuth.isConfigured ? (
        <>
          <p style={{ margin: 0, fontSize: "14px", opacity: 0.8, maxWidth: "360px" }}>
            Connect your Dropbox account to browse and edit your files.
          </p>
          <button
            className="save-all-btn"
            style={{ padding: "8px 18px", fontSize: "13px" }}
            onClick={() => dropboxAuth.login().catch((e) => setError(String(e)))}
          >
            Connect Dropbox
          </button>
        </>
      ) : (
        <p style={{ margin: 0, fontSize: "14px", opacity: 0.8, maxWidth: "420px" }}>
          Dropbox is not configured. Set <code>VITE_DROPBOX_APP_KEY</code> at build time to enable
          the web version (see README).
        </p>
      )}
    </div>
  );
}
