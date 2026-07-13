/**
 * Charge scheduler job.
 *
 * Runs on a configurable cron schedule (default: every 5 minutes).
 *
 * Each tick:
 *  1. Fetches upcoming Intelligent Go dispatch slots from Octopus.
 *  2. Checks whether the current local time falls within any active slot.
 *  3. If inside a slot  → sets peakAndVallery = "0" (disable peak/valley to
 *                          prevent battery drain while EV charges from grid).
 *  4. If outside a slot → sets peakAndVallery = "1" (re-enable normal
 *                          peak/valley time-of-use operation).
 *  5. Only writes to the inverter when the value has changed.
 */
import cron from 'node-cron';
import { Config } from '../config';
import { SunsynkService } from '../services/sunsynk';
import { OctopusService } from '../services/octopus';
import { appState } from '../state';
import { DispatchSlot } from '../types';

/** Value written to peakAndVallery when inside a charge slot. */
const PEAK_VALLEY_CHARGING = '0';
/** Value written to peakAndVallery when outside a charge slot. */
const PEAK_VALLEY_NORMAL = '1';

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

export async function runChargeCheck(
  sunsynk: SunsynkService,
  octopus: OctopusService,
  serial: string,
): Promise<void> {
  try {
    console.log('[Scheduler] Running charge check...');

    // --- Step 1: Fetch dispatch slots from Octopus ---
    const slots = await octopus.getDispatchSlots();
    appState.chargeSlots = slots;

    // --- Step 2: Check if we are currently in a charge slot ---
    const now = new Date();
    const inSlot = isInChargeSlot(now, slots);
    appState.isInChargeSlot = inSlot;

    const desiredValue = inSlot ? PEAK_VALLEY_CHARGING : PEAK_VALLEY_NORMAL;
    const currentValue = appState.currentSettings?.peakAndVallery;

    console.log(
      '[Scheduler] Dispatch slots: ' + slots.length +
      ', In slot: ' + inSlot +
      ', Desired peakAndVallery: ' + desiredValue +
      ', Current peakAndVallery: ' + (currentValue ?? 'unknown'),
    );

    // --- Step 3: Apply update only if the value has changed ---
    if (currentValue !== desiredValue) {
      console.log('[Scheduler] Updating peakAndVallery: ' + currentValue + ' → ' + desiredValue);

      await sunsynk.updateSettings(serial, { peakAndVallery: desiredValue });

      // Refresh settings from inverter to confirm the write
      appState.currentSettings = await sunsynk.getSettings(serial);

      console.log(
        '[Scheduler] peakAndVallery updated to: ' + appState.currentSettings.peakAndVallery,
      );
    } else {
      console.log('[Scheduler] No change needed (peakAndVallery already ' + desiredValue + ')');
    }

    appState.controlMode = inSlot ? 'charging' : 'discharging';
    appState.lastUpdated = new Date().toISOString();
    appState.lastError = null;
    appState.runCount += 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Scheduler] Error during charge check:', message);
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
  console.log('[Scheduler] Starting with schedule: ' + schedule);

  // Immediate first run
  runChargeCheck(sunsynk, octopus, serial).catch((err) =>
    console.error('[Scheduler] Initial run failed:', err),
  );

  // Recurring runs
  cron.schedule(schedule, () => {
    runChargeCheck(sunsynk, octopus, serial).catch((err) =>
      console.error('[Scheduler] Cron run failed:', err),
    );
  });
}
