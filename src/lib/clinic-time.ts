import { DateTime } from "luxon";
import { ApiError } from "./errors.js";

const DEFAULT_TIMEZONE = "America/New_York";

function zone(timezone?: string | null) {
  return timezone?.trim() || DEFAULT_TIMEZONE;
}

export function clinicNow(timezone?: string | null) {
  return DateTime.now().setZone(zone(timezone));
}

export function clinicDateKeyNow(timezone?: string | null) {
  return clinicNow(timezone).toISODate() || clinicNow(timezone).toFormat("yyyy-MM-dd");
}

export function clinicDateKeyFromDate(value: Date, timezone?: string | null) {
  return DateTime.fromJSDate(value, { zone: "utc" }).setZone(zone(timezone)).toISODate() || clinicDateKeyNow(timezone);
}

export function clinicDateTimeFromDateKey(dateKey: string, timezone?: string | null) {
  const parsed = DateTime.fromISO(dateKey, { zone: zone(timezone) }).startOf("day");
  if (!parsed.isValid) {
    throw new ApiError({
      statusCode: 400,
      code: "INVALID_DATE_KEY",
      message: `Invalid clinic date '${dateKey}'. Expected YYYY-MM-DD.`,
    });
  }
  return parsed;
}

export function clinicUtcDayRangeFromDateKey(dateKey: string, timezone?: string | null) {
  const start = clinicDateTimeFromDateKey(dateKey, timezone);
  return {
    start: start.toUTC().toJSDate(),
    end: start.endOf("day").toUTC().toJSDate(),
  };
}

export function clinicDateKeyOrNow(dateKey: string | null | undefined, timezone?: string | null) {
  const trimmed = (dateKey || "").trim();
  if (trimmed) {
    return clinicDateTimeFromDateKey(trimmed, timezone).toISODate() || clinicDateKeyNow(timezone);
  }
  return clinicDateKeyNow(timezone);
}

export function clinicDateKeysInRange(fromDateKey: string, toDateKey: string, timezone?: string | null) {
  let cursor = clinicDateTimeFromDateKey(fromDateKey, timezone);
  const end = clinicDateTimeFromDateKey(toDateKey, timezone);
  if (cursor > end) {
    throw new ApiError({
      statusCode: 400,
      code: "INVALID_DATE_RANGE",
      message: `Invalid clinic date range '${fromDateKey}' to '${toDateKey}'.`,
    });
  }
  const values: string[] = [];
  while (cursor <= end) {
    values.push(cursor.toISODate() || cursor.toFormat("yyyy-MM-dd"));
    cursor = cursor.plus({ days: 1 });
  }
  return values;
}
