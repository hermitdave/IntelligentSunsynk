/**
 * Charge scheduler job.
 *
 * Runs on a configurable cron schedule (default: every 5 minutes).
 *
 * Each tick:
 *  1. Fetches upcoming Intelligent Go dispatch slots from Octopus.
 *  2. Checks whether the current local time falls within any active slot.
 *  3. Between 23:30 and 05:30 local time, always sets peakAndVallery = "1"
 *     (Use Timer enabled).
 *  4. If inside a slot outside that overnight window, and battery SoC is below
 *     the time-of-day threshold (SOC_THRESHOLD_SCHEDULE)
 *     → sets peakAndVallery = "0" (disable peak/valley to
 *                          prevent battery drain while EV charges from grid).
 *  5. If outside a slot → sets peakAndVallery = "1" (re-enable normal
 *                          peak/valley time-of-use operation).
 *  6. Only writes to the inverter when the value has changed.
 */
import cron from 'node-cron';
import { Config } from '../config';
import { SunsynkService } from '../services/sunsynk';
import { OctopusService } from '../services/octopus';
import { appState } from '../state';
import { DispatchSlot, SocThreshold } from '../types';

/** Value written to peakAndVallery when inside a charge slot. */
const PEAK_VALLEY_CHARGING = '0';
/** Value written to peakAndVallery when outside a charge slot (Use Timer enabled). */
export const PEAK_VALLEY_NORMAL = '1';
const OVERNIGHT_START_MINUTES = 23 * 60 + 30;
const OVERNIGHT_END_MINUTES = 5 * 60 + 30;
/** Fallback SoC threshold used only if the schedule is somehow empty. */
const DEFAULT_SOC_THRESHOLD = 50;

/**
 * Resolve the battery SoC threshold that applies at a given local time.
 *
 * `schedule` is sorted ascending by `startMinutes`; each entry applies until
 * the next one, and the last entry wraps around midnight — so a time earlier
 * than the first entry uses the last entry of the day.
 */
export function socThresholdForMinutes(minutesOfDay: number, schedule: SocThreshold[]): number {
  if (schedule.length === 0) return DEFAULT_SOC_THRESHOLD;
  let chosen = schedule[schedule.length - 1]; // wrap-around default
  for (const entry of schedule) {
    if (minutesOfDay >= entry.startMinutes) chosen = entry;
    else break;
  }
  return chosen.threshold;
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
    appState.isInChargeSlot = inSlot;

    const inOvernightWindow = isOvernightTimerWindow(now);
    const localMinutes = now.getHours() * 60 + now.getMinutes();
    const socThreshold = socThresholdForMinutes(localMinutes, appState.socThresholdSchedule);

    // --- Step 3: Get battery SoC. Only needed to gate charging during a
    // peak-hour smart-charge slot; the overnight window never checks SoC. ---
    let batterySoC: number | null = null;
    const plantId = appState.plantId;
    if (inSlot && !inOvernightWindow && plantId !== null) {
      try {
        batterySoC = await sunsynk.getBatterySoC(plantId);
        schedulerLog('Battery SoC: ' + (batterySoC !== null ? batterySoC + '%' : 'unavailable'));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        schedulerLog('Failed to get battery SoC: ' + message + ' (proceeding without SoC check)');
      }
    }

    // Determine desired peakAndVallery value:
    // - Overnight window (23:30-05:30): keep Use Timer enabled (1). The
    //   overnight tariff charges the battery via the inverter's timer schedule.
    // - Peak-hour smart-charge slot with battery SoC below the time-of-day
    //   threshold: disable Use Timer (0) to force grid charging.
    // - Otherwise: Use Timer enabled (1).
    let desiredValue: string;
    if (inOvernightWindow) {
      desiredValue = PEAK_VALLEY_NORMAL;
    } else if (inSlot && batterySoC !== null && batterySoC < socThreshold) {
      desiredValue = PEAK_VALLEY_CHARGING;
      schedulerLog('Peak-hour charge slot with battery SoC ' + batterySoC + '% < ' + socThreshold + '% threshold, disabling Use Timer to charge');
    } else {
      desiredValue = PEAK_VALLEY_NORMAL;
      if (inSlot && batterySoC !== null) {
        schedulerLog('Peak-hour charge slot but battery SoC ' + batterySoC + '% >= ' + socThreshold + '% threshold, keeping Use Timer enabled');
      }
    }

    const currentValue = appState.currentSettings?.peakAndVallery;
    const desiredUseTimer = peakAndValleryToUseTimer(desiredValue);
    const currentUseTimer = peakAndValleryToUseTimer(currentValue);

    schedulerLog(
      'Dispatch slots: ' + slots.length +
      ', In slot: ' + inSlot +
      ', Battery SoC: ' + (batterySoC !== null ? batterySoC + '%' : 'N/A') +
      ', SoC threshold: ' + socThreshold + '%' +
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

  // Apply the configured time-of-day SoC threshold schedule.
  appState.socThresholdSchedule = config.socThresholdSchedule;
  schedulerLog(
    'SoC threshold schedule: ' +
    config.socThresholdSchedule
      .map((e) => String(Math.floor(e.startMinutes / 60)).padStart(2, '0') + ':' +
        String(e.startMinutes % 60).padStart(2, '0') + '=' + e.threshold + '%')
      .join(', '),
  );

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
