import { auth, type AuthContextSummary } from "./api-client";
import { applySession, loadSession, saveSession, type AuthSession } from "./auth-session";
import { getMicrosoftAccount, handleMicrosoftRedirect, hasMicrosoftLoginPending, resetMicrosoftLoginState } from "./microsoft-auth";
import type { Role } from "./types";

export type CompleteMicrosoftSignInResult = {
  targetPath: string;
  session: AuthSession;
  context: AuthContextSummary;
};

export async function completeMicrosoftSignIn(
  fallbackPath = "/",
  options?: {
    onPhaseChange?: (phase: "session_restoration" | "context_loading") => void;
  },
): Promise<CompleteMicrosoftSignInResult | null> {
  const redirect = await handleMicrosoftRedirect();
  options?.onPhaseChange?.("session_restoration");
  let account = redirect.account || (await getMicrosoftAccount());

  for (let attempt = 0; !account && attempt < 3 && hasMicrosoftLoginPending(); attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
    account = await getMicrosoftAccount();
  }

  if (!account) {
    if (hasMicrosoftLoginPending()) {
      resetMicrosoftLoginState();
      throw new Error(
        "Microsoft sign-in did not finish cleanly. We reset the stale sign-in state. Please try again.",
      );
    }
    return null;
  }

  const existing = loadSession();
  const provisional: AuthSession = {
    mode: "microsoft",
    role: (existing?.role || "Admin") as Role,
    facilityId: existing?.facilityId,
    accountHomeId: account.homeAccountId,
    username: account.username,
    name: account.name || undefined,
    email: account.username || undefined,
  };

  applySession(provisional);
  options?.onPhaseChange?.("context_loading");
  const context = await auth.getContext();

  let activeFacilityId =
    context.activeFacilityId ||
    context.facilityId ||
    (provisional.facilityId &&
    context.availableFacilities.some((facility) => facility.id === provisional.facilityId)
      ? provisional.facilityId
      : undefined) ||
    (context.availableFacilities.length === 1 ? context.availableFacilities[0]!.id : undefined);

  if (activeFacilityId && activeFacilityId !== context.activeFacilityId) {
    const updatedContext = await auth.setActiveFacility(activeFacilityId);
    activeFacilityId = updatedContext.activeFacilityId || activeFacilityId;
  }

  const nextSession: AuthSession = {
    ...provisional,
    role: ((context.role as Role) || provisional.role),
    userId: context.userId,
    facilityId: activeFacilityId,
    name: context.name || provisional.name,
    email: context.email || provisional.email,
    firstName: context.firstName || undefined,
    lastName: context.lastName || undefined,
  };

  saveSession(nextSession);
  return {
    targetPath: redirect.postLoginPath || fallbackPath,
    session: nextSession,
    context,
  };
}
