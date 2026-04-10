import { useState, useEffect } from "react";
import { ShieldAlert, X } from "lucide-react";
import { safety } from "./api-client";
import { useEncounters } from "./encounter-context";

interface SafetyAssistModalProps {
  encounterId: string;
  onClose: () => void;
  onActivated?: () => void;
  mode?: "activate" | "resolve";
}

export function SafetyAssistModal({
  encounterId,
  onClose,
  onActivated,
  mode = "activate",
}: SafetyAssistModalProps) {
  const { activateSafety, resolveSafety } = useEncounters();
  const [word, setWord] = useState("ANCHOR");
  const [input, setInput] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const isValid = input.trim().toUpperCase() === word.toUpperCase();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || submitting) return;
    try {
      setSubmitting(true);
      if (mode === "resolve") {
        await resolveSafety({
          encounterId,
          confirmationWord: input.trim(),
          resolutionNote: resolutionNote.trim() || undefined,
        });
      } else {
        await activateSafety({
          encounterId,
          confirmationWord: input.trim(),
        });
      }
      onActivated?.();
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    safety
      .getWord()
      .then((result) => {
        if (result?.word) setWord(result.word);
      })
      .catch(() => undefined);
  }, []);

  // Auto-focus the input
  useEffect(() => {
    const el = document.getElementById("safety-confirm-input");
    if (el) el.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl overflow-hidden">
        {/* Red header */}
        <div className={`${mode === "resolve" ? "bg-emerald-600" : "bg-red-600"} px-6 py-4 flex items-center gap-3`}>
          <ShieldAlert className="w-6 h-6 text-white" />
          <div>
            <div className="text-white text-[15px]" style={{ fontWeight: 600 }}>
              {mode === "resolve" ? "Turn Off Safety Assist" : "Activate Safety Assist"}
            </div>
            <div className={`${mode === "resolve" ? "text-emerald-100" : "text-red-200"} text-[12px]`}>
              {mode === "resolve" ? "This resolves the active safety state" : "This will alert all staff immediately"}
            </div>
          </div>
          <button onClick={onClose} className="ml-auto text-white/60 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {/* Warning */}
          <div className={`rounded-lg border px-4 py-3 text-[13px] ${mode === "resolve" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
            <strong>{mode === "resolve" ? "Confirm:" : "Warning:"}</strong>{" "}
            {mode === "resolve"
              ? "Resolving Safety Assist returns the encounter to normal workflow alerting."
              : "Activating Safety Assist will immediately notify all clinic staff and display a high-visibility alert on all boards until resolved."}
          </div>

          {/* Encounter info */}
          <div className="text-[12px] text-muted-foreground">
            Encounter: <span style={{ fontWeight: 500 }} className="text-foreground">{encounterId}</span>
          </div>

          {/* Confirmation word */}
          <div>
            <p className="text-[13px] text-muted-foreground mb-3">
              Type the confirmation word below to proceed:
            </p>
            <div className="text-center py-3 bg-red-50 rounded-lg border border-red-200">
              <span className="text-[28px] text-red-600 tracking-widest" style={{ fontWeight: 700 }}>
                {word}
              </span>
            </div>
          </div>

          <input
            id="safety-confirm-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type confirmation word..."
            className="w-full h-12 px-4 text-center text-[16px] rounded-lg border border-gray-200 bg-gray-50 focus:outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100 transition-all"
            style={{ fontWeight: 600, letterSpacing: "0.1em" }}
            autoComplete="off"
          />

          {mode === "resolve" && (
            <textarea
              value={resolutionNote}
              onChange={(e) => setResolutionNote(e.target.value)}
              placeholder="Resolution note (optional)"
              className="w-full min-h-[90px] px-3 py-2 text-[13px] rounded-lg border border-gray-200 bg-white focus:outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
            />
          )}

          {/* Buttons */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 h-11 rounded-lg border border-gray-200 text-[13px] text-gray-600 hover:bg-gray-50 transition-colors"
              style={{ fontWeight: 500 }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!isValid || submitting}
              className={`flex-1 h-11 rounded-lg text-[13px] text-white transition-all flex items-center justify-center gap-2 ${
                isValid
                  ? mode === "resolve"
                    ? "bg-emerald-600 hover:bg-emerald-700"
                    : "bg-red-600 hover:bg-red-700"
                  : "bg-gray-300 cursor-not-allowed"
              }`}
              style={{ fontWeight: 500 }}
            >
              <ShieldAlert className="w-4 h-4" />
              {submitting ? (mode === "resolve" ? "Resolving..." : "Activating...") : mode === "resolve" ? "Turn Off Safety Assist" : "Activate Safety Assist"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
