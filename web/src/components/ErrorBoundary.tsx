import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * The last stop for a render that throws.
 *
 * There was no boundary anywhere in this app, and React unmounts the whole
 * tree when a render throws with nothing to catch it — so one bad field on one
 * API response blanked the page to white, on every route, with the failure
 * visible only in the console. A trading UI that disappears is worse than one
 * showing stale numbers: the user cannot tell whether their order went in.
 *
 * Deliberately not a retry button. Re-rendering the same subtree with the same
 * data throws again; reloading is the action that can actually differ.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled render error", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="min-h-screen flex items-center justify-center bg-main-bg p-6">
        <div className="glass-card p-8 max-w-lg w-full space-y-4">
          <div className="flex items-center gap-2 text-red-400">
            <AlertTriangle className="w-5 h-5" />
            <h1 className="text-lg font-bold">Something broke on this screen</h1>
          </div>
          <p className="text-sm text-muted-text leading-relaxed">
            The page failed to render. Your wallets, orders and open positions are
            unaffected — this is a display failure, not a trading one.
          </p>
          <pre className="text-[11px] font-mono text-muted-text/80 bg-input-bg border border-divider-color rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words">
            {error.message || String(error)}
          </pre>
          <div className="flex items-center gap-2">
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Reload
            </button>
            <button
              onClick={() => window.location.assign("/dashboard")}
              className="px-4 py-2 border border-divider-color bg-bg-hover hover:bg-input-bg text-title-text rounded-lg text-sm font-medium transition-colors"
            >
              Back to dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }
}
