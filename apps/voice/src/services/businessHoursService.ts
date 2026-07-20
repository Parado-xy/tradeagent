// apps/voice/src/services/businessHoursService.ts
//
// Determines whether "now" falls inside a tenant's configured business
// hours, in the tenant's own timezone — not the server's.
//
// Depends on Tenant.businessHoursStart / businessHoursEnd / timezone,
// which are NOT YET in the Prisma schema as of this writing. This file
// assumes the pending migration adds:
//
//   businessHoursStart String?  // "HH:mm", 24h, e.g. "08:00"
//   businessHoursEnd   String?  // "HH:mm", 24h, e.g. "17:00"
//   timezone           String?  // IANA tz, e.g. "America/Chicago"
//
// All three are nullable because existing tenants won't have them set
// until they configure it (or we backfill a default). Until then, or if
// any single field is missing, we fail open to "business hours" rather
// than "after hours" — an unconfigured tenant should not have every call
// silently treated as after-hours, which would change transfer/greeting
// behavior nobody asked for.
//
// Uses Intl.DateTimeFormat for timezone conversion instead of pulling in
// date-fns-tz or luxon — Node's built-in ICU data covers this without
// adding a dependency to apps/voice.

export interface BusinessHoursStatus {
  isAfterHours: boolean;
  isBusinessHours: boolean;
  isConfigured: boolean;
  // "after-hours" | "business-hours" — matches the {{businessHoursStatus}}
  // variable name used in the VAPI system prompt.
  label: "after-hours" | "business-hours";
  // Current time in the tenant's timezone, "HH:mm" — useful for logging
  // and debugging why a call was classified a particular way.
  currentLocalTime: string | null;
}

interface TenantHoursInput {
  businessHoursStart?: string | null;
  businessHoursEnd?: string | null;
  timezone?: string | null;
}

// Default business days: Monday–Friday. Not currently configurable per
// tenant — if a tenant wants Saturday hours, this needs to become a
// stored field (e.g. businessDays: number[]) rather than a constant.
// Flagging as an assumption baked in here, not a finished feature.
const DEFAULT_BUSINESS_DAYS = new Set([1, 2, 3, 4, 5]); // Sun=0 .. Sat=6

export function getBusinessHoursStatus(
  tenant: TenantHoursInput,
  now: Date = new Date(),
): BusinessHoursStatus {
  const { businessHoursStart, businessHoursEnd, timezone } = tenant;

  if (!businessHoursStart || !businessHoursEnd || !timezone) {
    return {
      isAfterHours: false,
      isBusinessHours: true,
      isConfigured: false,
      label: "business-hours",
      currentLocalTime: null,
    };
  }

  let localParts: { hour: number; minute: number; weekday: number };
  try {
    localParts = getLocalTimeParts(now, timezone);
  } catch {
    // Invalid/unsupported IANA timezone string — same fail-open reasoning
    // as above. Log at the call site if you want visibility into this;
    // this function stays pure and just returns a safe default.
    return {
      isAfterHours: false,
      isBusinessHours: true,
      isConfigured: false,
      label: "business-hours",
      currentLocalTime: null,
    };
  }

  const startMinutes = parseHHMM(businessHoursStart);
  const endMinutes = parseHHMM(businessHoursEnd);
  const nowMinutes = localParts.hour * 60 + localParts.minute;

  const isBusinessDay = DEFAULT_BUSINESS_DAYS.has(localParts.weekday);

  // Handles the normal same-day case (e.g. 08:00–17:00). Does NOT handle
  // overnight ranges that cross midnight (e.g. 22:00–06:00) — no tenant
  // needs that yet, but if one does, this comparison needs to branch on
  // startMinutes > endMinutes.
  const withinHoursWindow =
    startMinutes !== null &&
    endMinutes !== null &&
    nowMinutes >= startMinutes &&
    nowMinutes < endMinutes;

  const isBusinessHours = isBusinessDay && withinHoursWindow;

  return {
    isAfterHours: !isBusinessHours,
    isBusinessHours,
    isConfigured: true,
    label: isBusinessHours ? "business-hours" : "after-hours",
    currentLocalTime: formatHHMM(localParts.hour, localParts.minute),
  };
}

// ── Internal helpers ────────────────────────────────────────────

function getLocalTimeParts(
  date: Date,
  timeZone: string,
): { hour: number; minute: number; weekday: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });

  // Throws RangeError if timeZone is not a recognized IANA identifier —
  // caller catches this.
  const parts = formatter.formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const weekdayShort = get("weekday"); // "Sun", "Mon", ...

  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekday = weekdayShort ? weekdayMap[weekdayShort] : undefined;

  if (Number.isNaN(hour) || Number.isNaN(minute) || weekday === undefined) {
    throw new RangeError(
      `Unable to resolve local time for timezone: ${timeZone}`,
    );
  }

  return { hour, minute, weekday };
}

function parseHHMM(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return hour * 60 + minute;
}

function formatHHMM(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
