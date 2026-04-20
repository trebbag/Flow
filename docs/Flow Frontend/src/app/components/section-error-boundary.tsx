import { Component, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

type SectionErrorBoundaryProps = {
  section: string;
  children: ReactNode;
};

type SectionErrorBoundaryState = {
  error: Error | null;
  resetKey: number;
};

export class SectionErrorBoundary extends Component<
  SectionErrorBoundaryProps,
  SectionErrorBoundaryState
> {
  state: SectionErrorBoundaryState = {
    error: null,
    resetKey: 0,
  };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch() {
    // Keep the shell alive. Route-level logging/fallbacks still cover full-screen failures.
  }

  private handleRetry = () => {
    this.setState((current) => ({
      error: null,
      resetKey: current.resetKey + 1,
    }));
  };

  render() {
    if (this.state.error) {
      return (
        <div className="h-full w-full p-6">
          <div className="mx-auto max-w-[720px] rounded-3xl border border-amber-200 bg-white/95 px-6 py-7 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-600">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-[18px]" style={{ fontWeight: 700 }}>
                  {this.props.section} hit a runtime error
                </h2>
                <p className="mt-2 text-[13px] text-muted-foreground">
                  We kept the rest of Flow running. You can retry just this section without losing your session.
                </p>
                <p className="mt-3 rounded-2xl bg-slate-50 px-3 py-2 text-[12px] text-slate-600">
                  {this.state.error.message || "Unexpected rendering error"}
                </p>
                <div className="mt-5 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={this.handleRetry}
                    className="inline-flex h-10 items-center gap-2 rounded-xl bg-slate-900 px-4 text-[13px] text-white transition-colors hover:bg-slate-800"
                    style={{ fontWeight: 600 }}
                  >
                    <RotateCcw className="h-4 w-4" />
                    Retry section
                  </button>
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="inline-flex h-10 items-center rounded-xl border border-slate-200 px-4 text-[13px] text-slate-700 transition-colors hover:bg-slate-50"
                    style={{ fontWeight: 500 }}
                  >
                    Reload app
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return <div key={this.state.resetKey}>{this.props.children}</div>;
  }
}
