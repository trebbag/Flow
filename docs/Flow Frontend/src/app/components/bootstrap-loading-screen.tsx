import { Loader2, ShieldAlert } from "lucide-react";
import type { BootstrapPhase } from "./app-bootstrap";

function phaseCopy(phase: BootstrapPhase) {
  switch (phase) {
    case "microsoft_redirect":
      return {
        title: "Signing you in",
        detail: "We’re completing the secure Microsoft handoff.",
        step: 1,
      };
    case "session_restoration":
      return {
        title: "Restoring your session",
        detail: "We found your Flow access and are rebuilding the session.",
        step: 1,
      };
    case "context_loading":
      return {
        title: "Loading your facility",
        detail: "We’re applying your Flow role and facility scope.",
        step: 2,
      };
    case "initial_data_loading":
      return {
        title: "Preparing your dashboard",
        detail: "The shell is ready. We’re loading the first live data now.",
        step: 3,
      };
    default:
      return {
        title: "Loading Flow",
        detail: "We’re bringing your workspace online.",
        step: 1,
      };
  }
}

export function BootstrapLoadingScreen({
  phase,
  error,
  onRetry,
  onReturnToLogin,
}: {
  phase: BootstrapPhase;
  error?: string | null;
  onRetry?: () => void;
  onReturnToLogin?: () => void;
}) {
  const copy = phaseCopy(phase);

  return (
    <div className="min-h-screen bg-[#f7f8fb] flex items-center justify-center p-4">
      <div className="w-full max-w-[520px] rounded-2xl border border-gray-200 bg-white shadow-sm px-6 py-8">
        {error ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center">
                <ShieldAlert className="w-5 h-5 text-red-600" />
              </div>
              <div>
                <h1 className="text-[18px] tracking-tight" style={{ fontWeight: 700 }}>
                  Flow startup needs attention
                </h1>
                <p className="text-[12px] text-muted-foreground">
                  Your sign-in may have succeeded, but Flow could not finish bootstrapping.
                </p>
              </div>
            </div>
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
              {error}
            </div>
            <div className="flex items-center gap-2">
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="h-10 px-4 rounded-lg bg-indigo-600 text-white text-[13px] hover:bg-indigo-700 transition-colors"
                  style={{ fontWeight: 600 }}
                >
                  Retry startup
                </button>
              )}
              {onReturnToLogin && (
                <button
                  type="button"
                  onClick={onReturnToLogin}
                  className="h-10 px-4 rounded-lg border border-gray-200 text-[13px] text-gray-600 hover:bg-gray-50 transition-colors"
                  style={{ fontWeight: 500 }}
                >
                  Back to login
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 animate-spin text-indigo-600" />
              <div>
                <h1 className="text-[18px] tracking-tight" style={{ fontWeight: 700 }}>
                  {copy.title}
                </h1>
                <p className="text-[12px] text-muted-foreground">
                  {copy.detail}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {[
                "Signing you in",
                "Loading your facility",
                "Preparing your dashboard",
              ].map((label, index) => {
                const active = copy.step >= index + 1;
                return (
                  <div
                    key={label}
                    className={`rounded-xl border px-3 py-3 transition-colors ${
                      active
                        ? "border-indigo-200 bg-indigo-50 text-indigo-700"
                        : "border-gray-200 bg-gray-50 text-gray-400"
                    }`}
                  >
                    <div className="text-[10px] uppercase tracking-wider" style={{ fontWeight: 700 }}>
                      Step {index + 1}
                    </div>
                    <div className="text-[12px] mt-1" style={{ fontWeight: 600 }}>
                      {label}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
