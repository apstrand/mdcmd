import { useEffect, useState } from "react";
import { storage } from "../storage";
import {
  webProviders,
  getSelectedProviderId,
  setSelectedProviderId,
  type WebProviderId,
} from "../storage/web";
import { Loader2, Cloud, GitBranch, AlertCircle } from "lucide-react";

// Gates rendering of the app on cloud authentication for the web build. On the
// desktop/mobile builds (no auth required) it simply renders its children.
//
// After the user picks a provider we redirect to its OAuth consent screen; on
// return the selected provider's callback exchanges the code for a token.
export default function ConnectGate({ children }: { children: React.ReactNode }) {
  const requiresAuth = storage.capabilities.requiresAuth;
  const [ready, setReady] = useState(!requiresAuth);
  const [authed, setAuthed] = useState(!requiresAuth);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!requiresAuth) return;
    (async () => {
      try {
        const selectedId = getSelectedProviderId();
        const selected = webProviders.find((p) => p.id === selectedId);
        // Only the provider that initiated the redirect should handle it.
        if (selected) await selected.auth.handleRedirectCallback();
        setAuthed(!!selected?.auth.isAuthenticated);
      } catch (e) {
        setError(String(e));
      } finally {
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

  const connect = (id: WebProviderId) => {
    const provider = webProviders.find((p) => p.id === id);
    if (!provider) return;
    setSelectedProviderId(id);
    provider.auth.login().catch((e) => setError(String(e)));
  };

  const icons: Record<WebProviderId, React.ReactNode> = {
    dropbox: <Cloud className="w-4 h-4" />,
    github: <GitBranch className="w-4 h-4" />,
  };

  const configured = webProviders.filter((p) => p.auth.isConfigured);

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

      {configured.length > 0 ? (
        <>
          <p style={{ margin: 0, fontSize: "14px", opacity: 0.8, maxWidth: "360px" }}>
            Connect a cloud account to browse and edit your files.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", alignItems: "center" }}>
            {configured.map((p) => (
              <button
                key={p.id}
                className="save-all-btn"
                style={{ padding: "8px 18px", fontSize: "13px", display: "flex", alignItems: "center", gap: "8px" }}
                onClick={() => connect(p.id)}
              >
                {icons[p.id]}
                Connect {p.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p style={{ margin: 0, fontSize: "14px", opacity: 0.8, maxWidth: "420px" }}>
          No cloud provider is configured. Set <code>VITE_DROPBOX_APP_KEY</code> and/or{" "}
          <code>VITE_GITHUB_CLIENT_ID</code> + <code>VITE_GITHUB_OAUTH_PROXY</code> at build time
          to enable the web version (see README).
        </p>
      )}
    </div>
  );
}
