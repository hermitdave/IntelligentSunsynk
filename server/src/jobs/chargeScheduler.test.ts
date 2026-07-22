/**
 * Unit tests for the charge scheduler core logic.
 */
import {
  isChargePhase,
  isInChargeSlot,
  isOvernightTimerWindow,
  runChargeCheck,
} from './chargeScheduler';
import { DispatchSlot } from '../types';
import { appState } from '../state';

function makeSlot(startIso: string, endIso: string): DispatchSlot {
  return { start: startIso, end: endIso, source: 'smart-charge', deltaKwh: -10, location: null };
}

describe('isInChargeSlot', () => {
  const slot: DispatchSlot = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');

  it('returns true when now is exactly at slot start', () => {
    expect(isInChargeSlot(new Date('2026-01-02T20:00:00Z'), [slot])).toBe(true);
  });

  it('returns true when now is inside the slot', () => {
    expect(isInChargeSlot(new Date('2026-01-02T20:45:00Z'), [slot])).toBe(true);
  });

  it('returns false when now is before the slot', () => {
    expect(isInChargeSlot(new Date('2026-01-02T19:59:59Z'), [slot])).toBe(false);
  });

  it('returns false when now is exactly at slot end (exclusive)', () => {
    expect(isInChargeSlot(new Date('2026-01-02T21:30:00Z'), [slot])).toBe(false);
  });

  it('returns false when now is after the slot', () => {
    expect(isInChargeSlot(new Date('2026-01-02T22:00:00Z'), [slot])).toBe(false);
  });

  it('returns false when no slots', () => {
    expect(isInChargeSlot(new Date('2026-01-02T20:30:00Z'), [])).toBe(false);
  });

  it('returns true if time falls within any of multiple slots', () => {
    const slot2 = makeSlot('2026-01-02T22:00:00Z', '2026-01-02T23:00:00Z');
    expect(isInChargeSlot(new Date('2026-01-02T22:30:00Z'), [slot, slot2])).toBe(true);
  });

  it('returns false when now is between two non-overlapping slots', () => {
    const slot2 = makeSlot('2026-01-02T22:00:00Z', '2026-01-02T23:00:00Z');
    expect(isInChargeSlot(new Date('2026-01-02T21:45:00Z'), [slot, slot2])).toBe(false);
  });

  it('handles slots with timezone offset strings', () => {
    const tzSlot = makeSlot('2026-01-02T20:30:00+00:00', '2026-01-02T21:30:00+00:00');
    expect(isInChargeSlot(new Date('2026-01-02T21:00:00Z'), [tzSlot])).toBe(true);
  });
});

describe('isOvernightTimerWindow', () => {
  it('returns true exactly at 23:30', () => {
    expect(isOvernightTimerWindow(new Date('2026-01-02T23:30:00'))).toBe(true);
  });

  it('returns true during the overnight lock window', () => {
    expect(isOvernightTimerWindow(new Date('2026-01-03T02:15:00'))).toBe(true);
  });

  it('returns true before 05:30', () => {
    expect(isOvernightTimerWindow(new Date('2026-01-03T05:29:00'))).toBe(true);
  });

  it('returns false exactly at 05:30', () => {
    expect(isOvernightTimerWindow(new Date('2026-01-03T05:30:00'))).toBe(false);
  });

  it('returns false during daytime', () => {
    expect(isOvernightTimerWindow(new Date('2026-01-03T12:00:00'))).toBe(false);
  });
});

describe('isChargePhase', () => {
  // Local-time strings (no trailing Z) keep these independent of machine tz.
  it('discharges on an even 5-minute block', () => {
    // 12:00 -> block 144 (even) -> discharge.
    expect(isChargePhase(new Date('2026-01-03T12:00:00'))).toBe(false);
    expect(isChargePhase(new Date('2026-01-03T12:04:59'))).toBe(false);
  });

  it('charges on an odd 5-minute block', () => {
    // 12:05 -> block 145 (odd) -> charge.
    expect(isChargePhase(new Date('2026-01-03T12:05:00'))).toBe(true);
    expect(isChargePhase(new Date('2026-01-03T12:09:59'))).toBe(true);
  });

  it('alternates every 5 minutes', () => {
    expect(isChargePhase(new Date('2026-01-03T12:10:00'))).toBe(false);
    expect(isChargePhase(new Date('2026-01-03T12:15:00'))).toBe(true);
  });
});

// =============================================================================
// runChargeCheck integration tests
// =============================================================================

/** Build mock Sunsynk and Octopus services for runChargeCheck tests. */
function makeMocks() {
  const sunsynk = {
    getBatterySoC: jest.fn().mockResolvedValue(80),
    getSettings: jest.fn().mockResolvedValue({ peakAndVallery: '1' }),
    updateSettings: jest.fn().mockResolvedValue(undefined),
  };
  const octopus = {
    getPlannedDispatchSlots: jest.fn().mockResolvedValue([] as DispatchSlot[]),
  };
  return { sunsynk, octopus };
}

/** Reset appState between tests to avoid cross-test contamination. */
function resetAppState(): void {
  appState.plantId = 123;
  appState.currentSettings = { peakAndVallery: '1' };
  appState.chargeSlots = [];
  appState.isInChargeSlot = false;
  appState.isInOvernightWindow = false;
  appState.controlMode = 'unknown';
  appState.lastError = null;
  appState.runCount = 0;
}

describe('runChargeCheck', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetAppState();
  });

  it('keeps Use Timer enabled ("1") and reports charging during the overnight window', async () => {
    // Mock Date to be 02:00 local time (inside overnight window 23:30-05:30)
    const fixedDate = new Date('2026-01-03T02:00:00');
    jest.useFakeTimers();
    jest.setSystemTime(fixedDate);

    const { sunsynk, octopus } = makeMocks();
    await runChargeCheck(
      sunsynk as unknown as never,
      octopus as unknown as never,
      'TEST-SERIAL',
    );

    // Already '1', so no write needed; control mode reflects overnight charging.
    expect(sunsynk.updateSettings).not.toHaveBeenCalled();
    expect(appState.controlMode).toBe('charging');
    // SoC is never consulted.
    expect(sunsynk.getBatterySoC).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('keeps Use Timer enabled overnight even when a slot is active', async () => {
    const fixedDate = new Date('2026-01-03T02:00:00');
    jest.useFakeTimers();
    jest.setSystemTime(fixedDate);

    // Slot covers the current fake time
    const slot = makeSlot('2026-01-03T01:00:00Z', '2026-01-03T03:00:00Z');
    const { sunsynk, octopus } = makeMocks();
    octopus.getPlannedDispatchSlots.mockResolvedValue([slot]);

    await runChargeCheck(
      sunsynk as unknown as never,
      octopus as unknown as never,
      'TEST-SERIAL',
    );

    expect(sunsynk.updateSettings).not.toHaveBeenCalled();
    expect(appState.controlMode).toBe('charging');
    expect(sunsynk.getBatterySoC).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('charges (peakAndVallery "0") during a charge block of a peak-hour slot', async () => {
    // 12:05 local -> odd 5-min block -> charge phase, outside overnight window.
    const fixedDate = new Date('2026-01-03T12:05:00');
    jest.useFakeTimers();
    jest.setSystemTime(fixedDate);

    const slot = makeSlot('2026-01-03T11:00:00', '2026-01-03T13:00:00');
    const { sunsynk, octopus } = makeMocks();
    octopus.getPlannedDispatchSlots.mockResolvedValue([slot]);

    await runChargeCheck(
      sunsynk as unknown as never,
      octopus as unknown as never,
      'TEST-SERIAL',
    );

    expect(sunsynk.getBatterySoC).not.toHaveBeenCalled();
    expect(sunsynk.updateSettings).toHaveBeenCalledWith('TEST-SERIAL', { peakAndVallery: '0' });
    expect(appState.controlMode).toBe('charging');
    jest.useRealTimers();
  });

  it('discharges (keeps peakAndVallery "1") during a discharge block of a peak-hour slot', async () => {
    // 12:00 local -> even 5-min block -> discharge phase, outside overnight window.
    const fixedDate = new Date('2026-01-03T12:00:00');
    jest.useFakeTimers();
    jest.setSystemTime(fixedDate);

    const slot = makeSlot('2026-01-03T11:00:00', '2026-01-03T13:00:00');
    const { sunsynk, octopus } = makeMocks();
    octopus.getPlannedDispatchSlots.mockResolvedValue([slot]);

    await runChargeCheck(
      sunsynk as unknown as never,
      octopus as unknown as never,
      'TEST-SERIAL',
    );

    expect(sunsynk.getBatterySoC).not.toHaveBeenCalled();
    expect(sunsynk.updateSettings).not.toHaveBeenCalled();
    expect(appState.controlMode).toBe('discharging');
    jest.useRealTimers();
  });

  it('keeps peakAndVallery at "1" and controlMode discharging when outside a charge slot and outside overnight window', async () => {
    const fixedDate = new Date('2026-01-03T12:00:00');
    jest.useFakeTimers();
    jest.setSystemTime(fixedDate);

    const { sunsynk, octopus } = makeMocks();
    octopus.getPlannedDispatchSlots.mockResolvedValue([]);

    await runChargeCheck(
      sunsynk as unknown as never,
      octopus as unknown as never,
      'TEST-SERIAL',
    );

    expect(sunsynk.getBatterySoC).not.toHaveBeenCalled();
    expect(sunsynk.updateSettings).not.toHaveBeenCalled();
    expect(appState.controlMode).toBe('discharging');
    jest.useRealTimers();
  });

  it('re-reads inverter state on slot exit and corrects a drifted value the stale cache would have hidden', async () => {
    // Slot just ended (was in slot, now no active slot), outside overnight.
    const fixedDate = new Date('2026-01-03T14:00:00');
    jest.useFakeTimers();
    jest.setSystemTime(fixedDate);

    const { sunsynk, octopus } = makeMocks();
    octopus.getPlannedDispatchSlots.mockResolvedValue([]);
    appState.isInChargeSlot = true; // previous tick was inside a slot
    // Local cache wrongly believes the inverter is already at "1" (desired
    // outside a slot). Without a re-read the write would be skipped, leaving
    // the inverter stuck where it actually is: "0".
    appState.currentSettings = { peakAndVallery: '1' };
    sunsynk.getSettings.mockResolvedValue({ peakAndVallery: '0' });

    await runChargeCheck(
      sunsynk as unknown as never,
      octopus as unknown as never,
      'TEST-SERIAL',
    );

    // Boundary re-read happened, exposing the drift, so we write "1".
    expect(sunsynk.getSettings).toHaveBeenCalledWith('TEST-SERIAL');
    expect(sunsynk.updateSettings).toHaveBeenCalledWith('TEST-SERIAL', { peakAndVallery: '1' });
    jest.useRealTimers();
  });

  it('re-reads inverter state on entering the overnight window and corrects a drifted value', async () => {
    // 23:35 local -> just entered the 23:30-05:30 overnight window, no slot.
    const fixedDate = new Date('2026-01-03T23:35:00');
    jest.useFakeTimers();
    jest.setSystemTime(fixedDate);

    const { sunsynk, octopus } = makeMocks();
    octopus.getPlannedDispatchSlots.mockResolvedValue([]);
    appState.isInOvernightWindow = false; // previous tick was outside the window
    // Cache wrongly believes the inverter is already at "1"; it drifted to "0".
    appState.currentSettings = { peakAndVallery: '1' };
    sunsynk.getSettings.mockResolvedValue({ peakAndVallery: '0' });

    await runChargeCheck(
      sunsynk as unknown as never,
      octopus as unknown as never,
      'TEST-SERIAL',
    );

    expect(sunsynk.getSettings).toHaveBeenCalledWith('TEST-SERIAL');
    expect(sunsynk.updateSettings).toHaveBeenCalledWith('TEST-SERIAL', { peakAndVallery: '1' });
    expect(appState.controlMode).toBe('charging');
    jest.useRealTimers();
  });

  it('does not re-read inverter state mid-window when no boundary was crossed', async () => {
    // 02:00 local, already inside the overnight window on the previous tick.
    const fixedDate = new Date('2026-01-03T02:00:00');
    jest.useFakeTimers();
    jest.setSystemTime(fixedDate);

    const { sunsynk, octopus } = makeMocks();
    octopus.getPlannedDispatchSlots.mockResolvedValue([]);
    appState.isInOvernightWindow = true; // no boundary this tick
    appState.currentSettings = { peakAndVallery: '1' }; // already correct

    await runChargeCheck(
      sunsynk as unknown as never,
      octopus as unknown as never,
      'TEST-SERIAL',
    );

    expect(sunsynk.getSettings).not.toHaveBeenCalled();
    expect(sunsynk.updateSettings).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('does not re-read inverter state mid-slot when no slot boundary was crossed', async () => {
    // 12:05 charge phase, already inside the slot on the previous tick.
    const fixedDate = new Date('2026-01-03T12:05:00');
    jest.useFakeTimers();
    jest.setSystemTime(fixedDate);

    const slot = makeSlot('2026-01-03T11:00:00', '2026-01-03T13:00:00');
    const { sunsynk, octopus } = makeMocks();
    octopus.getPlannedDispatchSlots.mockResolvedValue([slot]);
    appState.isInChargeSlot = true; // no boundary this tick
    appState.currentSettings = { peakAndVallery: '0' }; // already charging

    await runChargeCheck(
      sunsynk as unknown as never,
      octopus as unknown as never,
      'TEST-SERIAL',
    );

    // No boundary and no write -> no extra GET against the inverter.
    expect(sunsynk.getSettings).not.toHaveBeenCalled();
    expect(sunsynk.updateSettings).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});
