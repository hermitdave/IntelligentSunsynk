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
 *  4. If inside a slot outside that overnight window
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
import { loadSlotHistory, mergeSlots, saveSlotHistory } from '../services/slotHistory';
import { appState } from '../state';
import { DispatchSlot } from '../types';

/** Value written to peakAndVallery when inside a charge slot. */
const PEAK_VALLEY_CHARGING = '0';
/** Value written to peakAndVallery when outside a charge slot. */
const PEAK_VALLEY_NORMAL = '1';
const OVERNIGHT_START_MINUTES = 23 * 60 + 30;
const OVERNIGHT_END_MINUTES = 5 * 60 + 30;

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
    const slots = await octopus.getDispatchSlots();
    appState.chargeSlots = slots;

    // --- Step 2: Check if we are currently in a charge slot ---
    const now = new Date();
    const inSlot = isInChargeSlot(now, slots);
    appState.isInChargeSlot = inSlot;

    // --- Step 2b: Merge slots into persisted history ---
    // Only slots observed as active (isInChargeSlot === true) will be
    // promoted to fulfilled once their end time passes.
    const nowIso = now.toISOString();
    appState.slotHistory = mergeSlots(slots, appState.slotHistory, nowIso, inSlot);
    saveSlotHistory(appState.slotHistory);

    // --- Step 3: Get battery SoC (only needed when in a charge slot) ---
    let batterySoC: number | null = null;
    const plantId = appState.plantId;
    if (inSlot && plantId !== null) {
      try {
        batterySoC = await sunsynk.getBatterySoC(plantId);
        schedulerLog('Battery SoC: ' + (batterySoC !== null ? batterySoC + '%' : 'unavailable'));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        schedulerLog('Failed to get battery SoC: ' + message + ' (proceeding without SoC check)');
      }
    }

    const inOvernightWindow = isOvernightTimerWindow(now);

    // Determine desired peakAndVallery value:
    // - During overnight window (23:30-05:30): always use normal mode (1)
    // - Inside a charge slot: only disable peak/valley (0) if battery SoC < 50%
    // - Outside a charge slot: use normal mode (1)
    let desiredValue: string;
    if (inOvernightWindow) {
      desiredValue = PEAK_VALLEY_CHARGING;
    } else if (inSlot) {
      // Only disable peak/valley if battery SoC is below 50%
      if (batterySoC !== null && batterySoC < 50) {
        desiredValue = PEAK_VALLEY_CHARGING;
        schedulerLog('In charge slot with battery SoC ' + batterySoC + '% < 50%, disabling peak/valley');
      } else {
        desiredValue = PEAK_VALLEY_NORMAL;
        if (batterySoC !== null) {
          schedulerLog('In charge slot but battery SoC ' + batterySoC + '% >= 50%, keeping peak/valley enabled');
        } else {
          schedulerLog('In charge slot but battery SoC unavailable, keeping peak/valley enabled');
        }
      }
    } else {
      desiredValue = PEAK_VALLEY_NORMAL;
    }

    const currentValue = appState.currentSettings?.peakAndVallery;
    const desiredUseTimer = peakAndValleryToUseTimer(desiredValue);
    const currentUseTimer = peakAndValleryToUseTimer(currentValue);

    schedulerLog(
      'Dispatch slots: ' + slots.length +
      ', In slot: ' + inSlot +
      ', Battery SoC: ' + (batterySoC !== null ? batterySoC + '%' : 'N/A') +
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

    appState.controlMode = inSlot ? 'charging' : 'discharging';
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

  // Load persisted slot history so fulfilled slots survive restarts
  appState.slotHistory = loadSlotHistory();
  schedulerLog(
    'Loaded slot history: ' +
    appState.slotHistory.fulfilled.length + ' fulfilled, ' +
    appState.slotHistory.active.length + ' active, ' +
    appState.slotHistory.futurePlanned.length + ' future planned',
  );

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
