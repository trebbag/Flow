import type { Encounter } from "./mock-data";

function parseIsoMs(value?: string | null) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function elapsedSecondsFromClockTime(clockValue: string | undefined, nowMs: number, fallbackMinutes = 0) {
  const match = (clockValue || "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return Math.max(0, fallbackMinutes * 60);

  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return Math.max(0, fallbackMinutes * 60);

  const anchor = new Date(nowMs);
  anchor.setHours(hh, mm, 0, 0);
  let delta = nowMs - anchor.getTime();
  if (delta < 0) delta += 24 * 60 * 60 * 1000;
  return Math.max(0, Math.floor(delta / 1000));
}

export function getEncounterStageSeconds(encounter: Encounter, nowMs: number) {
  const stageStartMs = parseIsoMs(encounter.currentStageStartAtIso);
  if (stageStartMs !== null) {
    const stopMs =
      encounter.status === "Optimized"
        ? parseIsoMs(encounter.completedAtIso || encounter.currentStageStartAtIso) ?? stageStartMs
        : nowMs;
    return Math.max(0, Math.floor((stopMs - stageStartMs) / 1000));
  }
  return elapsedSecondsFromClockTime(encounter.currentStageStart, nowMs, encounter.minutesInStage);
}

export function getEncounterTotalSeconds(encounter: Encounter, nowMs: number) {
  const checkInMs = parseIsoMs(encounter.checkInAtIso);
  if (checkInMs !== null) {
    const stopMs =
      encounter.status === "Optimized"
        ? parseIsoMs(encounter.completedAtIso || encounter.currentStageStartAtIso) ?? nowMs
        : nowMs;
    return Math.max(0, Math.floor((stopMs - checkInMs) / 1000));
  }
  return elapsedSecondsFromClockTime(encounter.checkinTime, nowMs, encounter.minutesInStage);
}
