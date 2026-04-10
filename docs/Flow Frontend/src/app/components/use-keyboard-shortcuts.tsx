import { useEffect } from "react";

type ShortcutDef = {
  /** Key to match (e.g. "Escape", "Enter", "b") */
  key: string;
  /** Require Cmd (Mac) / Ctrl (Win) */
  meta?: boolean;
  /** Require Shift */
  shift?: boolean;
  /** Handler — return `true` to prevent default */
  handler: () => boolean | void;
  /** Only fire when no input/textarea is focused (default true) */
  ignoreInputs?: boolean;
};

/**
 * Register global keyboard shortcuts.
 * Automatically handles Mac vs Windows modifier keys.
 */
export function useKeyboardShortcuts(shortcuts: ShortcutDef[]) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable;

      for (const s of shortcuts) {
        const ignoreInputs = s.ignoreInputs ?? true;
        if (ignoreInputs && isInput) {
          // Exception: allow Escape in inputs (useful for "close/go back")
          if (s.key !== "Escape") continue;
        }

        const keyMatch = e.key === s.key || e.key.toLowerCase() === s.key.toLowerCase();
        if (!keyMatch) continue;

        // Meta = Cmd on Mac, Ctrl on Win/Linux
        if (s.meta && !(e.metaKey || e.ctrlKey)) continue;
        if (!s.meta && (e.metaKey || e.ctrlKey)) continue;

        if (s.shift && !e.shiftKey) continue;
        if (!s.shift && e.shiftKey) continue;

        const result = s.handler();
        if (result !== false) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [shortcuts]);
}
