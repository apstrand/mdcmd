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

  if (!ready) {
    return (
      <div className="no-file-selected" style={{ height: "100vh" }}>
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
      </div>
    );
  }

  return <>{children}</>;
}
