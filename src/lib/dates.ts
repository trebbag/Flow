import { DateTime } from "luxon";
import { ApiError } from "./errors.js";

export function normalizeDate(date: string, timezone: string): Date {
  const parsed = DateTime.fromISO(date, { zone: timezone });
  if (!parsed.isValid) {
    throw new ApiError({
      statusCode: 400,
      code: "INVALID_DATE",
      message: `Invalid date '${date}'. Expected ISO date format (YYYY-MM-DD).`,
    });
  }
  return parsed.startOf("day").toUTC().toJSDate();
}

export function dateRangeForDay(date: string, timezone: string): { start: Date; end: Date } {
  const start = DateTime.fromISO(date, { zone: timezone }).startOf("day");
  if (!start.isValid) {
    throw new ApiError({
      statusCode: 400,
      code: "INVALID_DATE",
      message: `Invalid date '${date}'. Expected ISO date format (YYYY-MM-DD).`,
    });
  }
  return {
    start: start.toUTC().toJSDate(),
    end: start.plus({ days: 1 }).toUTC().toJSDate()
  };
}

export function parseAppointmentAt(
  appointmentTimeRaw: string,
  dateOfService: Date,
  clinicTimezone: string
): { appointmentTime: string | null; appointmentAt: Date | null; error: string | null } {
  const normalized = appointmentTimeRaw.trim();
  if (!normalized) {
    return { appointmentTime: null, appointmentAt: null, error: "Missing appointment time" };
  }

  const dateIso =
    DateTime.fromJSDate(dateOfService, { zone: "utc" }).setZone(clinicTimezone).toISODate() ||
    DateTime.now().setZone(clinicTimezone).toISODate();
  const formats = ["H:mm", "HH:mm", "h:mm a", "h:mma", "h:mmA"];

  for (const format of formats) {
    const parsed = DateTime.fromFormat(`${dateIso} ${normalized}`, `yyyy-MM-dd ${format}`, {
      zone: clinicTimezone
    });
    if (parsed.isValid) {
      return {
        appointmentTime: parsed.toFormat("HH:mm"),
        appointmentAt: parsed.toUTC().toJSDate(),
        error: null
      };
    }
  }

  return {
    appointmentTime: normalized,
    appointmentAt: null,
    error: "Appointment time must be in HH:mm or h:mm AM/PM format"
  };
}
