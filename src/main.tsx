import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import DropboxConnect from "./components/DropboxConnect";
import ErrorBoundary from "./components/ErrorBoundary";
import "./index.css";

const isWeb = !("__TAURI_INTERNALS__" in window);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isWeb && (
        <div style={{
          background: "var(--accent)", color: "white", padding: "8px", 
          textAlign: "center", fontSize: "14px", fontWeight: 500, flexShrink: 0
        }}>
          Like MarkDown Commander? Check out the <a href="https://github.com/apstrand/mdcmd" style={{ color: "white", textDecoration: "underline" }}>GitHub repo</a> or install the <a href="https://crates.io/crates/mdcmd" style={{ color: "white", textDecoration: "underline" }}>Rust crate</a>!
        </div>
      )}
      <div style={{ flexGrow: 1, position: "relative", minHeight: 0, display: "flex", flexDirection: "column" }}>
        <DropboxConnect>
          <App />
        </DropboxConnect>
      </div>
    </ErrorBoundary>
  </React.StrictMode>,
);

// Register the PWA service worker for the web build only (not inside Tauri).
if (!("__TAURI_INTERNALS__" in window) && "serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // ignore registration failures (e.g. non-HTTPS contexts)
    });
  });
}
