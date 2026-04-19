import { useEffect } from "react";
import { useNavigate } from "react-router";
import { isMicrosoftAuthRedirectFrame, resetMicrosoftLoginState } from "./microsoft-auth";
import { useAppBootstrap } from "./app-bootstrap";
import { BootstrapLoadingScreen } from "./bootstrap-loading-screen";
import { clearSession } from "./auth-session";

export function AuthCallbackView() {
  const navigate = useNavigate();
  const bootstrap = useAppBootstrap();
  const redirectFrame = isMicrosoftAuthRedirectFrame();

  useEffect(() => {
    if (redirectFrame) {
      return;
    }

    let cancelled = false;

    async function completeRedirect() {
      try {
        const target = await bootstrap.completeMicrosoftBootstrap();
        if (cancelled) return;
        if (!target) {
          throw new Error("Microsoft redirect did not contain a sign-in result. Please try again.");
        }
        navigate(target, { replace: true });
      } catch (err) {
        if (cancelled) return;
      }
    }

    completeRedirect().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bootstrap, navigate, redirectFrame]);

  if (redirectFrame) {
    return (
      <div aria-hidden="true" className="min-h-screen bg-white">
        <span className="sr-only">Completing Microsoft authentication</span>
      </div>
    );
  }

  return (
    <BootstrapLoadingScreen
      phase={bootstrap.phase === "idle" ? "microsoft_redirect" : bootstrap.phase}
      error={bootstrap.error}
      onRetry={() => {
        void bootstrap.retryBootstrap().then((target) => {
          if (target) {
            navigate(target, { replace: true });
          }
        });
      }}
      onReturnToLogin={() => {
        clearSession();
        resetMicrosoftLoginState();
        navigate("/login", { replace: true });
      }}
    />
  );
}
