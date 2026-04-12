import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
} from "@azure/msal-browser";

const env = (typeof import.meta !== "undefined" && (import.meta as any).env) || {};
const configuredTenantId = String(env.VITE_ENTRA_TENANT_ID || "").trim();
const configuredAuthority = String(env.VITE_ENTRA_AUTHORITY || "").trim();
const configuredClientId = String(env.VITE_ENTRA_CLIENT_ID || "").trim();
const configuredApiScope = String(env.VITE_ENTRA_API_SCOPE || "").trim();
const configuredRedirectPath = String(env.VITE_ENTRA_REDIRECT_PATH || "/login").trim() || "/login";
const configuredPostLogoutPath =
  String(env.VITE_ENTRA_POST_LOGOUT_REDIRECT_PATH || configuredRedirectPath).trim() || configuredRedirectPath;

const POST_LOGIN_PATH_KEY = "flow_entra_post_login_path";

function normalizePath(path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  return path.startsWith("/") ? path : `/${path}`;
}

function absoluteUrl(path: string) {
  const normalized = normalizePath(path);
  if (typeof window === "undefined") return normalized;
  return new URL(normalized, window.location.origin).toString();
}

function buildAuthority() {
  if (configuredAuthority) return configuredAuthority;
  if (!configuredTenantId) return "";
  return `https://login.microsoftonline.com/${configuredTenantId}`;
}

function apiScopes() {
  return configuredApiScope ? [configuredApiScope] : [];
}

function loginScopes() {
  return Array.from(new Set(["openid", "profile", "email", ...apiScopes()]));
}

function clearPostLoginPath() {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(POST_LOGIN_PATH_KEY);
}

function isTimedOutBrowserError(error: unknown) {
  if (!error) return false;
  const errorCode =
    typeof error === "object" && "errorCode" in error ? String((error as { errorCode?: unknown }).errorCode || "") : "";
  const message = error instanceof Error ? error.message : String(error);
  return errorCode === "timed_out" || /\btimed_out\b/i.test(message);
}

function isPopupStartupError(error: unknown) {
  if (!error) return false;
  const errorCode =
    typeof error === "object" && "errorCode" in error ? String((error as { errorCode?: unknown }).errorCode || "") : "";
  return ["popup_window_error", "empty_window_error", "block_nested_popups"].includes(errorCode);
}

let clientPromise: Promise<PublicClientApplication> | null = null;

export function isMicrosoftAuthConfigured() {
  return Boolean(configuredClientId && buildAuthority() && configuredApiScope);
}

async function getClient() {
  if (!isMicrosoftAuthConfigured()) {
    throw new Error(
      "Microsoft Entra login is not configured. Set VITE_ENTRA_CLIENT_ID, VITE_ENTRA_TENANT_ID or VITE_ENTRA_AUTHORITY, and VITE_ENTRA_API_SCOPE.",
    );
  }

  if (!clientPromise) {
    clientPromise = (async () => {
      const client = new PublicClientApplication({
        auth: {
          clientId: configuredClientId,
          authority: buildAuthority(),
          redirectUri: absoluteUrl(configuredRedirectPath),
          postLogoutRedirectUri: absoluteUrl(configuredPostLogoutPath),
          navigateToLoginRequestUrl: false,
        },
        cache: {
          cacheLocation: "localStorage",
        },
      });
      await client.initialize();
      const activeAccount = client.getActiveAccount() || client.getAllAccounts()[0] || null;
      if (activeAccount) client.setActiveAccount(activeAccount);
      return client;
    })();
  }

  return clientPromise;
}

export async function preloadMicrosoftClient() {
  await getClient();
}

async function ensureActiveAccount() {
  const client = await getClient();
  const account = client.getActiveAccount() || client.getAllAccounts()[0] || null;
  if (account) client.setActiveAccount(account);
  return { client, account };
}

export async function handleMicrosoftRedirect(): Promise<{
  account: AccountInfo | null;
  accessToken: string | null;
  postLoginPath: string | null;
  result: AuthenticationResult | null;
}> {
  const client = await getClient();
  const result = await client.handleRedirectPromise();
  const account = result?.account || client.getActiveAccount() || client.getAllAccounts()[0] || null;
  if (account) client.setActiveAccount(account);

  const postLoginPath =
    typeof window !== "undefined" ? window.sessionStorage.getItem(POST_LOGIN_PATH_KEY) : null;
  clearPostLoginPath();

  return {
    account,
    accessToken: result?.accessToken || null,
    postLoginPath,
    result,
  };
}

export async function getMicrosoftAccount() {
  const { account } = await ensureActiveAccount();
  return account;
}

export async function startMicrosoftLogin(nextPath?: string): Promise<AuthenticationResult | null> {
  const client = await getClient();
  if (typeof window !== "undefined") {
    window.sessionStorage.setItem(POST_LOGIN_PATH_KEY, nextPath || "/");
  }

  const loginRequest = {
    scopes: loginScopes(),
    prompt: "select_account",
  } as const;

  try {
    const result = await client.loginPopup(loginRequest);
    if (result.account) {
      client.setActiveAccount(result.account);
    }
    clearPostLoginPath();
    return result;
  } catch (error) {
    if (!isPopupStartupError(error)) {
      throw error;
    }
  }

  try {
    await client.loginRedirect(loginRequest);
    return null;
  } catch (error) {
    if (isTimedOutBrowserError(error)) {
      throw new Error("Microsoft redirect timed out before the browser left Flow. Allow popups for this site or retry in a fresh tab.");
    }
    throw error;
  }
}

export async function acquireMicrosoftAccessToken(forceRefresh = false) {
  const { client, account } = await ensureActiveAccount();
  if (!account) {
    return null;
  }

  try {
    const result = await client.acquireTokenSilent({
      account,
      scopes: apiScopes(),
      forceRefresh,
    });
    return result.accessToken;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      throw new Error("Microsoft session expired. Sign in again.");
    }
    throw error;
  }
}

export async function logoutFromMicrosoft() {
  const { client, account } = await ensureActiveAccount();
  await client.logoutRedirect({
    account: account || undefined,
  });
}

export function getMicrosoftConfigSummary() {
  return {
    authority: buildAuthority(),
    clientId: configuredClientId,
    apiScope: configuredApiScope,
    redirectUri: absoluteUrl(configuredRedirectPath),
    postLogoutRedirectUri: absoluteUrl(configuredPostLogoutPath),
  };
}
