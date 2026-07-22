/**
 * Charge scheduler job.
 *
 * Runs on a configurable cron schedule (default: every 5 minutes).
 *
 * Each tick:
 *  1. Fetches upcoming Intelligent Go dispatch slots from Octopus.
 *  2. Checks whether the current local time falls within any active slot.
 *  3. Between 23:30 and 05:30 local time, always sets peakAndVallery = "1"
 *     (Use Timer enabled) so the overnight tariff charges the battery.
 *  4. If inside a slot outside that overnight window, alternates every
 *     5-minute wall-clock block between charging (peakAndVallery = "0", grid
 *     charge) and discharging (peakAndVallery = "1", normal use-timer). Over a
 *     slot this holds the battery SoC roughly where it started — no SoC read or
 *     time-of-day threshold required.
 *  5. If outside a slot → sets peakAndVallery = "1" (re-enable normal
 *                          peak/valley time-of-use operation).
 *  6. Only writes to the inverter when the value has changed.
 */
import cron from 'node-cron';
import { Config } from '../config';
import { SunsynkService } from '../services/sunsynk';
import { OctopusService } from '../services/octopus';
import { appState } from '../state';
import { DispatchSlot } from '../types';

/** Value written to peakAndVallery when charging (grid charge, use timer off). */
const PEAK_VALLEY_CHARGING = '0';
/** Value written to peakAndVallery when discharging / idle (Use Timer enabled). */
export const PEAK_VALLEY_NORMAL = '1';
const OVERNIGHT_START_MINUTES = 23 * 60 + 30;
const OVERNIGHT_END_MINUTES = 5 * 60 + 30;
/** Length of each charge/discharge alternation block, in minutes. */
const ALTERNATION_BLOCK_MINUTES = 5;

/**
 * Whether the current local time falls in a "charge" block of the 5-minute
 * charge/discharge alternation. Odd-numbered blocks charge, even-numbered
 * blocks discharge, so a dispatch slot spanning several blocks nets out to
 * roughly the SoC it started at. Stateless: derived purely from the clock, so
 * it survives restarts and needs no persisted counter.
 */
export function isChargePhase(now: Date): boolean {
  const minutesOfDay = now.getHours() * 60 + now.getMinutes();
  return Math.floor(minutesOfDay / ALTERNATION_BLOCK_MINUTES) % 2 === 1;
}

function schedulerTimestamp(): string {
  return new Date().toISOString();
}

function schedulerLog(message: string): void {
  console.log(`[Scheduler ${schedulerTimestamp()}] ${message}`);
}

function schedulerError(message: string, error?: unknown): void {
  if (error !== undefined) {
    console.error(`[Scheduler ${schedulerTimestamp()}] ${message}`, error);
    return;
  }

  console.error(`[Scheduler ${schedulerTimestamp()}] ${message}`);
}

function peakAndValleryToUseTimer(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value === PEAK_VALLEY_NORMAL;
}

function formatBoolean(value: boolean | undefined): string {
  return value === undefined ? 'unknown' : String(value);
}

/**
 * Determine whether the given UTC datetime falls within any dispatch slot.
 *
 * Both the current time and slot boundaries are compared in UTC to avoid
 * DST-related issues. The Octopus API already returns UTC datetimes.
 */
export function isInChargeSlot(now: Date, slots: DispatchSlot[]): boolean {
  const nowMs = now.getTime();
  return slots.some((slot) => {
    const start = new Date(slot.start).getTime();
    const end = new Date(slot.end).getTime();
    return nowMs >= start && nowMs < end;
  });
}

/**
 * 23:30 -> 05:30 (local time): lock to "1" (Use Timer enabled).
 */
export function isOvernightTimerWindow(now: Date): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= OVERNIGHT_START_MINUTES || minutes < OVERNIGHT_END_MINUTES;
}

export async function runChargeCheck(
  sunsynk: SunsynkService,
  octopus: OctopusService,
  serial: string,
): Promise<void> {
  try {
    schedulerLog('Running charge check...');

    // --- Step 1: Fetch dispatch slots from Octopus ---
    const slots = await octopus.getPlannedDispatchSlots();
    appState.chargeSlots = slots;

    // --- Step 2: Check if we are currently in a charge slot ---
    const now = new Date();
    const inSlot = isInChargeSlot(now, slots);
    const wasInSlot = appState.isInChargeSlot;
    appState.isInChargeSlot = inSlot;

    const inOvernightWindow = isOvernightTimerWindow(now);
    const wasInOvernightWindow = appState.isInOvernightWindow;
    appState.isInOvernightWindow = inOvernightWindow;

    // A charge slot or the overnight window (23:30/05:30 edges) just started or
    // ended on this tick. At these boundaries the inverter may have changed
    // peakAndVallery on its own (its internal Use Timer schedule), so the
    // cached snapshot can't be trusted.
    const atSlotBoundary = inSlot !== wasInSlot;
    const atOvernightBoundary = inOvernightWindow !== wasInOvernightWindow;

    // Re-read settings from the inverter at these boundaries so the change
    // detection below compares against the device's real state, not a stale
    // local cache that could cause a needed write to be skipped.
    if (atSlotBoundary || atOvernightBoundary) {
      const reasons: string[] = [];
      if (atSlotBoundary) reasons.push('slot ' + (inSlot ? 'entered' : 'exited'));
      if (atOvernightBoundary) reasons.push('overnight window ' + (inOvernightWindow ? 'entered' : 'exited'));
      try {
        appState.currentSettings = await sunsynk.getSettings(serial);
        schedulerLog(
          'Boundary (' + reasons.join(', ') +
          '): re-read inverter settings, peakAndVallery=' +
          (appState.currentSettings.peakAndVallery ?? 'unknown'),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        schedulerLog('Failed to re-read settings at boundary: ' + message + ' (using cached snapshot)');
      }
    }

    // Determine desired peakAndVallery value:
    // - Overnight window (23:30-05:30): keep Use Timer enabled (1). The
    //   overnight tariff charges the battery via the inverter's timer schedule.
    // - Peak-hour smart-charge slot: alternate every 5-minute block between
    //   grid charging (0) and discharging (1) so the battery SoC is held
    //   roughly where the slot began, without reading SoC.
    // - Otherwise: Use Timer enabled (1).
    let desiredValue: string;
    if (inOvernightWindow) {
      desiredValue = PEAK_VALLEY_NORMAL;
    } else if (inSlot) {
      const charging = isChargePhase(now);
      desiredValue = charging ? PEAK_VALLEY_CHARGING : PEAK_VALLEY_NORMAL;
      schedulerLog(
        'Peak-hour charge slot: ' + (charging ? 'charging' : 'discharging') +
        ' block (5-min alternation to hold SoC)',
      );
    } else {
      desiredValue = PEAK_VALLEY_NORMAL;
    }

    const currentValue = appState.currentSettings?.peakAndVallery;
    const desiredUseTimer = peakAndValleryToUseTimer(desiredValue);
    const currentUseTimer = peakAndValleryToUseTimer(currentValue);

    schedulerLog(
      'Dispatch slots: ' + slots.length +
      ', In slot: ' + inSlot +
      ', Overnight window: ' + inOvernightWindow +
      ', Desired Use Timer: ' + formatBoolean(desiredUseTimer) +
      ', Current Use Timer: ' + formatBoolean(currentUseTimer),
    );

    // --- Step 4: Apply update only if the value has changed ---
    if (currentValue !== desiredValue) {
      schedulerLog(
        'Updating Use Timer: ' +
        formatBoolean(currentUseTimer) +
        ' -> ' +
        formatBoolean(desiredUseTimer),
      );

      await sunsynk.updateSettings(serial, { peakAndVallery: desiredValue });

      // Refresh settings from inverter to confirm the write
      appState.currentSettings = await sunsynk.getSettings(serial);

      schedulerLog(
        'Use Timer updated to: ' +
        formatBoolean(peakAndValleryToUseTimer(appState.currentSettings.peakAndVallery)),
      );
    } else {
      schedulerLog('No change needed (Use Timer already ' + formatBoolean(desiredUseTimer) + ')');
    }

    // Charging whenever the overnight timer is running or we forced grid
    // charging (peakAndVallery = "0") during a peak-hour slot.
    appState.controlMode =
      inOvernightWindow || desiredValue === PEAK_VALLEY_CHARGING ? 'charging' : 'discharging';
    appState.lastUpdated = new Date().toISOString();
    appState.lastError = null;
    appState.runCount += 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    schedulerError('Error during charge check: ' + message);
    appState.lastError = message;
    appState.runCount += 1;
  }
}

/**
 * Start the recurring cron job.
 *
 * Also performs an immediate first run so the inverter state is correct
 * as soon as the server starts.
 */
export function startScheduler(
  config: Config,
  sunsynk: SunsynkService,
  octopus: OctopusService,
  serial: string,
): void {
  const schedule = config.cronSchedule;
  schedulerLog('Starting with schedule: ' + schedule);

  // Slot history is tracked in memory only and rebuilt from Octopus each run.

  // Immediate first run
  runChargeCheck(sunsynk, octopus, serial).catch((err) =>
    schedulerError('Initial run failed:', err),
  );

  // Recurring runs
  cron.schedule(schedule, () => {
    runChargeCheck(sunsynk, octopus, serial).catch((err) =>
      schedulerError('Cron run failed:', err),
    );
  });
}
