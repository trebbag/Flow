import { AlertTriangle, RotateCcw } from "lucide-react";
import { isRouteErrorResponse, useNavigate, useRouteError } from "react-router";

function errorSummary(error: unknown) {
  if (isRouteErrorResponse(error)) {
    return {
      title: `${error.status} ${error.statusText || "Route Error"}`,
      detail:
        typeof error.data === "string"
          ? error.data
          : "Flow hit a route-level error while loading this screen.",
    };
  }

  if (error instanceof Error) {
    return {
      title: "Unexpected Application Error",
      detail: error.message || "Flow hit an unexpected rendering error.",
    };
  }

  return {
    title: "Unexpected Application Error",
    detail: "Flow hit an unexpected rendering error.",
  };
}

export function RouteErrorBoundary() {
  const navigate = useNavigate();
  const error = useRouteError();
  const summary = errorSummary(error);

  return (
    <div className="min-h-screen bg-[#f7f8fb] flex items-center justify-center p-4">
      <div className="w-full max-w-[560px] rounded-2xl border border-gray-200 bg-white shadow-sm px-6 py-8">
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 rounded-xl bg-amber-50 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-amber-600" />
          </div>
          <div className="min-w-0">
            <h1 className="text-[20px] tracking-tight" style={{ fontWeight: 700 }}>
              {summary.title}
            </h1>
            <p className="text-[13px] text-muted-foreground mt-2">
              {summary.detail}
            </p>
            <p className="text-[12px] text-muted-foreground mt-3">
              We kept the app running, and you can retry this screen without losing your session.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 mt-6">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="h-10 px-4 rounded-lg bg-indigo-600 text-white text-[13px] hover:bg-indigo-700 transition-colors flex items-center gap-1.5"
            style={{ fontWeight: 600 }}
          >
            <RotateCcw className="w-4 h-4" />
            Reload screen
          </button>
          <button
            type="button"
            onClick={() => navigate("/", { replace: true })}
            className="h-10 px-4 rounded-lg border border-gray-200 text-[13px] text-gray-700 hover:bg-gray-50 transition-colors"
            style={{ fontWeight: 500 }}
          >
            Go to overview
          </button>
        </div>
      </div>
    </div>
  );
}
