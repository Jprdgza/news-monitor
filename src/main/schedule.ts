// Decides when the next check runs, based on the hour in the configured time zone
// (empty = the Mac's own time zone).
import type { Config } from './configCore';

// Building an Intl.DateTimeFormat is slow, so keep one per timezone + format.
const formatters = new Map<string, Intl.DateTimeFormat>();
export function formatter(timezone: string, locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timezone}|${locale}|${JSON.stringify(opts)}`;
  let f = formatters.get(key);
  if (!f) formatters.set(key, (f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: timezone || undefined })));
  return f;
}

export function hourIn(timezone: string, date = new Date()): number {
  return Number(formatter(timezone, 'en-US', { hour: 'numeric', hourCycle: 'h23' }).format(date));
}

export function isDaytime(cfg: Config, date = new Date()): boolean {
  const h = hourIn(cfg.polling.timezone, date);
  return h >= cfg.polling.dayStartHour && h < cfg.polling.dayEndHour;
}

export interface PowerState {
  onBattery?: boolean;
  /** Screen locked: nobody is reading notifications right now. */
  locked?: boolean;
}

/**
 * Milliseconds until the next check: base interval ± random jitter.
 * On battery the interval stretches; while the screen is locked it uses the overnight pace
 * (a check runs as soon as you unlock).
 */
export function nextDelayMs(cfg: Config, date = new Date(), power: PowerState = {}, random = Math.random): number {
  const p = cfg.polling;
  const day = isDaytime(cfg, date) && !(power.locked && cfg.efficiency.slowerWhenLocked);
  let base = day ? p.dayIntervalMinutes : p.nightIntervalMinutes;
  let jitter = day ? p.dayJitterMinutes : p.nightJitterMinutes;
  if (power.onBattery) {
    base *= cfg.efficiency.batteryIntervalMultiplier;
    jitter *= cfg.efficiency.batteryIntervalMultiplier;
  }
  const minutes = base + (random() * 2 - 1) * jitter;
  return Math.max(1, minutes) * 60_000;
}
