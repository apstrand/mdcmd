import { useEffect, useState } from "react";
import { storage } from "../storage";
import { completePendingConnect } from "../storage/web";
import { Loader2 } from "lucide-react";

// On the web build, an OAuth redirect returns to this page with a ?code=. Before
// rendering the app we complete that pending exchange (so the just-connected
// provider is available as a root). Connecting/disconnecting itself lives in the
// folder view, so there's no full-screen auth gate anymore. On desktop/mobile
// this is a no-op passthrough.
export default function ConnectGate({ children }: { children: React.ReactNode }) {
  const isWeb = storage.id === "web";
  const [ready, setReady] = useState(!isWeb);

  useEffect(() => {
    if (!isWeb) return;
    completePendingConnect()
      .catch((e) => console.error("OAuth callback failed:", e))
      .finally(() => setReady(true));
  }, [isWeb]);

  // Promo banner for the web build's landing screen only — shown here (rather
  // than around the whole app in main.tsx) so it disappears once connected
  // instead of covering the app's own header on every screen.
  const banner = (
    <div style={{
      background: "var(--accent)", color: "white", padding: "8px",
      textAlign: "center", fontSize: "14px", fontWeight: 500, flexShrink: 0
    }}>
      Like MarkDown Commander? Check out the <a href="https://github.com/apstrand/mdcmd" style={{ color: "white", textDecoration: "underline" }}>GitHub repo</a> or install the <a href="https://crates.io/crates/mdc" style={{ color: "white", textDecoration: "underline" }}>Rust crate</a>!
    </div>
  );

  if (!ready) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        {banner}
        <div className="no-file-selected" style={{ flexGrow: 1, minHeight: 0 }}>
          <Loader2 className="w-8 h-8 animate-spin text-accent" />
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
