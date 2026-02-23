// Pure computational utilities for the campaign automation worker.
//
// Extracted from app/api/campaigns/process/route.ts for testability.
// Both the cron worker and unit tests import from here — changes to the
// algorithm are reflected in tests automatically.

/** UTC-3 hour for the current moment (Brazil standard time, no DST). */
export function brazilHour(): number {
  return (new Date().getUTCHours() + 21) % 24 // UTC-3 = UTC + 21 mod 24
}

/**
 * Returns true if the current Brazil time is inside the campaign's working-hours
 * window.  When no window is configured, always returns true.
 *
 * @param workingHoursStart  – inclusive start hour (0–23), or null for no limit
 * @param workingHoursEnd    – exclusive end hour   (0–23), or null for no limit
 */
export function isWithinWorkingHours(
  workingHoursStart: number | null,
  workingHoursEnd: number | null,
): boolean {
  if (workingHoursStart == null || workingHoursEnd == null) return true
  const hour = brazilHour()
  if (workingHoursStart <= workingHoursEnd) {
    return hour >= workingHoursStart && hour < workingHoursEnd
  }
  // Overnight window (e.g. 22–06): active from start until midnight AND midnight until end
  return hour >= workingHoursStart || hour < workingHoursEnd
}

/**
 * Compute the next send timestamp for a campaign.
 *
 * Enforces BOTH the user-configured delay+jitter AND the max_per_hour rate limit.
 * The effective interval between sends is:
 *
 *   max(delay_seconds + jitter, ceil(3600 / max_per_hour))
 *
 * so if the user sets delay=10s but max_per_hour=20, sends happen at most every
 * 180 s (= 3600 / 20), not every 10 s.
 */
export function computeNextSendAt(
  delaySeconds: number,
  jitterMax: number,
  maxPerHour: number,
): Date {
  const jitter = jitterMax > 0 ? Math.floor(Math.random() * (jitterMax + 1)) : 0
  const minIntervalSeconds = Math.ceil(3600 / maxPerHour)
  const effectiveDelay = Math.max(delaySeconds + jitter, minIntervalSeconds)
  return new Date(Date.now() + effectiveDelay * 1000)
}

/**
 * How many recipients to process in a single cron tick (every ~60 s).
 *
 * Accounts for both the user delay AND the hourly rate cap so we never
 * over-send relative to max_per_hour.  Result is capped to maxPerCron (default 10)
 * to keep cron execution time bounded.
 *
 * Examples:
 *   delay=30s, maxPerHour=500 → effectiveDelay=30s → ceil(60/30)=2
 *   delay=10s, maxPerHour=20  → effectiveDelay=180s → ceil(60/180)=1
 *   delay=1s,  maxPerHour=500 → effectiveDelay=7s  → min(10, ceil(60/7))=9
 */
export function recipientsThisTick(
  delaySeconds: number,
  maxPerHour: number,
  maxPerCron = 10,
): number {
  const minIntervalSeconds = Math.ceil(3600 / maxPerHour)
  const effectiveDelay = Math.max(delaySeconds, minIntervalSeconds)
  return Math.min(maxPerCron, Math.max(1, Math.ceil(60 / effectiveDelay)))
}
