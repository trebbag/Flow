import { useEffect } from "react";
import { useBeforeUnload, useBlocker } from "react-router";

export function useUnsavedChangesGuard(enabled: boolean, message: string) {
  const blocker = useBlocker(enabled);

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    const shouldLeave = window.confirm(message);
    if (shouldLeave) {
      blocker.proceed();
      return;
    }
    blocker.reset();
  }, [blocker, message]);

  useBeforeUnload(
    (event) => {
      if (!enabled) return;
      event.preventDefault();
      event.returnValue = message;
    },
    { capture: true },
  );
}
