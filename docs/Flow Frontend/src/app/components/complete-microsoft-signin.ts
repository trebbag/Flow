import { auth } from "./api-client";
import { applySession, loadSession, saveSession, type AuthSession } from "./auth-session";
import { getMicrosoftAccount, handleMicrosoftRedirect, hasMicrosoftLoginPending, resetMicrosoftLoginState } from "./microsoft-auth";
import type { Role } from "./types";

export async function completeMicrosoftSignIn(fallbackPath = "/") {
  const redirect = await handleMicrosoftRedirect();
  let account = redirect.account || (await getMicrosoftAccount());

  for (let attempt = 0; !account && attempt < 3 && hasMicrosoftLoginPending(); attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
    account = await getMicrosoftAccount();
  }

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

  let activeFacilityId =
    provisional.facilityId ||
    context.activeFacilityId ||
    context.facilityId ||
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
  };

  saveSession(nextSession);
  return redirect.postLoginPath || fallbackPath;
}
