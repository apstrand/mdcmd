import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// Catches render-time errors anywhere in the tree so a single failing
// component shows a readable message instead of unmounting everything and
// leaving a blank white window (which is impossible to diagnose in a release
// webview without devtools).
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          textAlign: "center",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "18px" }}>Something went wrong</h2>
        <pre
          style={{
            maxWidth: "90%",
            maxHeight: "40vh",
            overflow: "auto",
            fontSize: "12px",
            textAlign: "left",
            opacity: 0.8,
            whiteSpace: "pre-wrap",
          }}
        >
          {error.message}
          {error.stack ? "\n\n" + error.stack : ""}
        </pre>
        <button
          className="save-all-btn"
          style={{ padding: "8px 18px", fontSize: "13px" }}
          onClick={() => this.setState({ error: null })}
        >
          Try again
        </button>
      </div>
    );
  }
}
