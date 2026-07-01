import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import DropboxConnect from "./components/DropboxConnect";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <DropboxConnect>
      <App />
    </DropboxConnect>
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
