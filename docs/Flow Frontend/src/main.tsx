
import { createRoot } from "react-dom/client";
import App from "./app/App.tsx";
import "./styles/index.css";

const CHUNK_RELOAD_SESSION_KEY = "flow.chunk-reload-at";
const CHUNK_RELOAD_WINDOW_MS = 15_000;

function shouldReloadForChunkFailure() {
  try {
    const lastAttemptRaw = window.sessionStorage.getItem(CHUNK_RELOAD_SESSION_KEY);
    const lastAttempt = lastAttemptRaw ? Number(lastAttemptRaw) : 0;
    const now = Date.now();
    if (Number.isFinite(lastAttempt) && now - lastAttempt < CHUNK_RELOAD_WINDOW_MS) {
      return false;
    }
    window.sessionStorage.setItem(CHUNK_RELOAD_SESSION_KEY, String(now));
    return true;
  } catch {
    return true;
  }
}

function clearChunkReloadMarker() {
  try {
    window.sessionStorage.removeItem(CHUNK_RELOAD_SESSION_KEY);
  } catch {
    // Ignore sessionStorage failures so startup stays resilient.
  }
}

function isChunkLoadErrorMessage(message: string) {
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("failed to fetch dynamically imported module") ||
    normalized.includes("importing a module script failed")
  );
}

function handleChunkLoadFailure() {
  if (!shouldReloadForChunkFailure()) return;
  window.location.reload();
}

window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  handleChunkLoadFailure();
});

window.addEventListener("error", (event) => {
  const message = event.error instanceof Error ? event.error.message : event.message;
  if (typeof message === "string" && isChunkLoadErrorMessage(message)) {
    handleChunkLoadFailure();
  }
});

window.addEventListener("unhandledrejection", (event) => {
  const reason =
    event.reason instanceof Error
      ? event.reason.message
      : typeof event.reason === "string"
        ? event.reason
        : "";
  if (reason && isChunkLoadErrorMessage(reason)) {
    handleChunkLoadFailure();
  }
});

window.addEventListener("load", () => {
  window.setTimeout(() => {
    clearChunkReloadMarker();
  }, 1000);
});

createRoot(document.getElementById("root")!).render(<App />);
  
