import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Loader2, ShieldAlert } from "lucide-react";
import { auth } from "./api-client";
import { applySession, loadSession, saveSession, type AuthSession } from "./auth-session";
import { getMicrosoftAccount, handleMicrosoftRedirect, hasMicrosoftLoginPending, resetMicrosoftLoginState } from "./microsoft-auth";
import type { Role } from "./types";

export function AuthCallbackView() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function completeRedirect() {
      try {
        let redirect = await handleMicrosoftRedirect();
        let account = redirect.account || (await getMicrosoftAccount());

        for (let attempt = 0; !account && attempt < 3 && hasMicrosoftLoginPending(); attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
          redirect = await handleMicrosoftRedirect();
          account = redirect.account || (await getMicrosoftAccount());
        }

        if (cancelled) return;

        if (!account) {
          resetMicrosoftLoginState();
          throw new Error(
            "Microsoft sign-in did not finish cleanly. We reset the stale sign-in state. Please try again.",
          );
        }

        const existing = loadSession();
        const provisional: AuthSession = {
          mode: "microsoft",
          role: (existing?.role || "Admin") as Role,
          facilityId: existing?.facilityId,
          accountHomeId: account.homeAccountId,
          username: account.username,
          name: account.name || undefined,
        };

        applySession(provisional);
        const context = await auth.getContext();
        if (cancelled) return;

        let activeFacilityId =
          provisional.facilityId ||
          context.activeFacilityId ||
          context.facilityId ||
          (context.availableFacilities.length === 1 ? context.availableFacilities[0]!.id : undefined);

        if (activeFacilityId && activeFacilityId !== context.activeFacilityId) {
          const updatedContext = await auth.setActiveFacility(activeFacilityId);
          if (cancelled) return;
          activeFacilityId = updatedContext.activeFacilityId || activeFacilityId;
        }

        const nextSession: AuthSession = {
          ...provisional,
          role: ((context.role as Role) || provisional.role),
          userId: context.userId,
          facilityId: activeFacilityId,
        };

        saveSession(nextSession);
        navigate(redirect.postLoginPath || "/", { replace: true });
      } catch (err) {
        if (cancelled) return;
        applySession(null);
        setError(err instanceof Error ? err.message : "Microsoft sign-in failed");
      }
    }

    completeRedirect().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  return (
    <div className="min-h-screen bg-[#f7f8fb] flex items-center justify-center p-4">
      <div className="w-full max-w-[480px] rounded-2xl border border-gray-200 bg-white shadow-sm px-6 py-8">
        {error ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center">
                <ShieldAlert className="w-5 h-5 text-red-600" />
              </div>
              <div>
                <h1 className="text-[18px] tracking-tight" style={{ fontWeight: 700 }}>
                  Microsoft sign-in failed
                </h1>
                <p className="text-[12px] text-muted-foreground">
                  Flow could not complete the Entra redirect callback.
                </p>
              </div>
            </div>
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
              {error}
            </div>
            <button
              type="button"
              onClick={() => {
                resetMicrosoftLoginState();
                navigate("/login", { replace: true });
              }}
              className="h-10 px-4 rounded-lg bg-indigo-600 text-white text-[13px] hover:bg-indigo-700 transition-colors"
              style={{ fontWeight: 600 }}
            >
              Back to login
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 animate-spin text-indigo-600" />
            <div>
              <h1 className="text-[18px] tracking-tight" style={{ fontWeight: 700 }}>
                Completing Microsoft sign-in
              </h1>
              <p className="text-[12px] text-muted-foreground">
                We’re finishing the secure redirect and loading your Flow access.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
