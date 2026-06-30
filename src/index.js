import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";

// Last line of defence against a blank white screen: if anything in the tree
// throws during render, show a readable message with a reload instead of an
// empty page. (Auth callbacks and third-party scripts are the usual suspects.)
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    // Surface it for diagnostics; the boundary already renders the fallback.
    console.error("inkk crashed:", error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: 24,
          textAlign: "center",
          fontFamily: "Georgia, 'Times New Roman', serif",
        }}
      >
        <p style={{ fontSize: 18, margin: 0 }}>Something went wrong.</p>
        <button
          onClick={() => window.location.assign(window.location.origin)}
          style={{
            padding: "10px 20px",
            fontSize: 15,
            border: "1px solid currentColor",
            borderRadius: 6,
            background: "transparent",
            cursor: "pointer",
          }}
        >
          Reload inkk
        </button>
      </div>
    );
  }
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
