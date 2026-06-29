import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/** Ловит неперехваченные ошибки рендера и показывает заглушку вместо белого экрана. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    console.error("[ErrorBoundary]", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 14,
            padding: 32,
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 42 }}>⚠️</div>
          <h2 style={{ fontSize: 18, fontWeight: 700 }}>Something went wrong</h2>
          <p style={{ fontSize: 13, color: "var(--muted)", maxWidth: 380 }}>
            Try restarting the launcher. If the problem persists, check the log
            file in the launcher folder.
          </p>
          {this.state.error && (
            <pre
              style={{
                fontSize: 11,
                color: "#f87171",
                maxWidth: 500,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                background: "rgba(0,0,0,0.3)",
                padding: 10,
                borderRadius: 8,
              }}
            >
              {this.state.error.message}
            </pre>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
