/**
 * Unit tests for the charge scheduler core logic.
 */
import {
  isInChargeSlot,
  isOvernightTimerWindow,
  runChargeCheck,
  socThresholdForMinutes,
} from './chargeScheduler';
import { DispatchSlot } from '../types';
import { appState } from '../state';
import { DEFAULT_SOC_THRESHOLD_SCHEDULE, parseSocThresholdSchedule } from '../config';

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

describe('parseSocThresholdSchedule', () => {
  it('parses the default schedule sorted by start time', () => {
    expect(parseSocThresholdSchedule(DEFAULT_SOC_THRESHOLD_SCHEDULE)).toEqual([
      { startMinutes: 9 * 60, threshold: 90 },
      { startMinutes: 12 * 60, threshold: 75 },
      { startMinutes: 15 * 60, threshold: 60 },
      { startMinutes: 18 * 60, threshold: 45 },
    ]);
  });

  it('sorts out-of-order entries and tolerates whitespace', () => {
    expect(parseSocThresholdSchedule('18:00=45, 09:00=90')).toEqual([
      { startMinutes: 9 * 60, threshold: 90 },
      { startMinutes: 18 * 60, threshold: 45 },
    ]);
  });

  it('throws on a malformed entry', () => {
    expect(() => parseSocThresholdSchedule('09:00-90')).toThrow(/Invalid SOC_THRESHOLD_SCHEDULE/);
  });

  it('throws on an out-of-range time or threshold', () => {
    expect(() => parseSocThresholdSchedule('25:00=50')).toThrow(/Invalid time/);
    expect(() => parseSocThresholdSchedule('09:00=150')).toThrow(/Invalid threshold/);
  });

  it('throws on an empty schedule', () => {
    expect(() => parseSocThresholdSchedule('   ')).toThrow(/at least one/);
  });
});

describe('socThresholdForMinutes', () => {
  const schedule = parseSocThresholdSchedule(DEFAULT_SOC_THRESHOLD_SCHEDULE);

  it('returns the threshold for the band containing the time', () => {
    expect(socThresholdForMinutes(9 * 60, schedule)).toBe(90); // exactly 09:00
    expect(socThresholdForMinutes(10 * 60, schedule)).toBe(90);
    expect(socThresholdForMinutes(12 * 60, schedule)).toBe(75); // exactly 12:00
    expect(socThresholdForMinutes(14 * 60 + 59, schedule)).toBe(75);
    expect(socThresholdForMinutes(15 * 60, schedule)).toBe(60);
    expect(socThresholdForMinutes(18 * 60, schedule)).toBe(45);
    expect(socThresholdForMinutes(23 * 60, schedule)).toBe(45);
  });

  it('wraps the last entry across midnight for early-morning times', () => {
    expect(socThresholdForMinutes(0, schedule)).toBe(45); // 00:00
    expect(socThresholdForMinutes(8 * 60 + 59, schedule)).toBe(45); // just before 09:00
  });

  it('falls back to a default threshold for an empty schedule', () => {
    expect(socThresholdForMinutes(12 * 60, [])).toBe(50);
  });
});

// =============================================================================
// runChargeCheck integration tests
// =============================================================================

/**
 * Build mock Sunsynk and Octopus services for runChargeCheck tests.
 * `batterySoC` controls the value returned by getBatterySoC.
 */
function makeMocks(batterySoC: number | null = 80) {
  const sunsynk = {
    getBatterySoC: jest.fn().mockResolvedValue(batterySoC),
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
  appState.controlMode = 'unknown';
  appState.lastError = null;
  appState.runCount = 0;
  // Default schedule: 09:00=90, 12:00=75, 15:00=60, 18:00=45 (wraps to 09:00).
  appState.socThresholdSchedule = parseSocThresholdSchedule(DEFAULT_SOC_THRESHOLD_SCHEDULE);
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

    const { sunsynk, octopus } = makeMocks(80);
    await runChargeCheck(
      sunsynk as unknown as never,
      octopus as unknown as never,
      'TEST-SERIAL',
    );

    // Already '1', so no write needed; control mode reflects overnight charging.
    expect(sunsynk.updateSettings).not.toHaveBeenCalled();
    expect(appState.controlMode).toBe('charging');
    // SoC is not consulted during the overnight window.
    expect(sunsynk.getBatterySoC).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('keeps Use Timer enabled overnight even when a slot is active, without checking SoC', async () => {
    const fixedDate = new Date('2026-01-03T02:00:00');
    jest.useFakeTimers();
    jest.setSystemTime(fixedDate);

    // Slot covers the current fake time
    const slot = makeSlot('2026-01-03T01:00:00Z', '2026-01-03T03:00:00Z');
    const { sunsynk, octopus } = makeMocks(80);
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

  it('sets peakAndVallery to "0" when in a charge slot and battery SoC below the threshold', async () => {
    // Daytime, outside overnight window
    const fixedDate = new Date('2026-01-03T12:00:00Z');
    jest.useFakeTimers();
    jest.setSystemTime(fixedDate);

    const slot = makeSlot('2026-01-03T11:00:00Z', '2026-01-03T13:00:00Z');
    const { sunsynk, octopus } = makeMocks(30); // battery SoC 30%
    octopus.getPlannedDispatchSlots.mockResolvedValue([slot]);
    // Fixed 50% threshold all day, so this test is independent of time-of-day.
    appState.socThresholdSchedule = [{ startMinutes: 0, threshold: 50 }];

    await runChargeCheck(
      sunsynk as unknown as never,
      octopus as unknown as never,
      'TEST-SERIAL',
    );

    expect(sunsynk.getBatterySoC).toHaveBeenCalledWith(123);
    expect(sunsynk.updateSettings).toHaveBeenCalledWith('TEST-SERIAL', { peakAndVallery: '0' });
    expect(appState.controlMode).toBe('charging');
    jest.useRealTimers();
  });

  it('keeps peakAndVallery at "1" when in a charge slot but battery SoC at or above the threshold', async () => {
    const fixedDate = new Date('2026-01-03T12:00:00Z');
    jest.useFakeTimers();
    jest.setSystemTime(fixedDate);

    const slot = makeSlot('2026-01-03T11:00:00Z', '2026-01-03T13:00:00Z');
    const { sunsynk, octopus } = makeMocks(65); // battery SoC 65%
    octopus.getPlannedDispatchSlots.mockResolvedValue([slot]);
    // Fixed 50% threshold all day, so this test is independent of time-of-day.
    appState.socThresholdSchedule = [{ startMinutes: 0, threshold: 50 }];

    await runChargeCheck(
      sunsynk as unknown as never,
      octopus as unknown as never,
      'TEST-SERIAL',
    );

    expect(sunsynk.getBatterySoC).toHaveBeenCalledWith(123);
    expect(sunsynk.updateSettings).not.toHaveBeenCalled();
    // Not force-charging (SoC at/above threshold) and not overnight → discharging.
    expect(appState.controlMode).toBe('discharging');
    jest.useRealTimers();
  });

  it('keeps peakAndVallery at "1" when in a charge slot but battery SoC unavailable', async () => {
    const fixedDate = new Date('2026-01-03T12:00:00Z');
    jest.useFakeTimers();
    jest.setSystemTime(fixedDate);

    const slot = makeSlot('2026-01-03T11:00:00Z', '2026-01-03T13:00:00Z');
    const { sunsynk, octopus } = makeMocks(null); // SoC unavailable
    octopus.getPlannedDispatchSlots.mockResolvedValue([slot]);

    await runChargeCheck(
      sunsynk as unknown as never,
      octopus as unknown as never,
      'TEST-SERIAL',
    );

    expect(sunsynk.updateSettings).not.toHaveBeenCalled();
    // SoC unavailable → do not force charge; not overnight → discharging.
    expect(appState.controlMode).toBe('discharging');
    jest.useRealTimers();
  });

  it('keeps peakAndVallery at "1" and controlMode discharging when outside a charge slot and outside overnight window', async () => {
    const fixedDate = new Date('2026-01-03T12:00:00Z');
    jest.useFakeTimers();
    jest.setSystemTime(fixedDate);

    const { sunsynk, octopus } = makeMocks(30);
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

  it('applies a time-dependent SoC threshold: charges at 10:00 but not at 20:00 for the same SoC', async () => {
    // Default schedule: 10:00 -> 90% threshold, 20:00 -> 45% threshold.
    // Local-time strings (no trailing Z) keep this independent of machine tz.
    const soc = 80;

    // Morning: 80% is below the 90% threshold -> charge.
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-03T10:00:00'));
    const morning = makeMocks(soc);
    morning.octopus.getPlannedDispatchSlots.mockResolvedValue([
      makeSlot('2026-01-03T09:30:00', '2026-01-03T11:00:00'),
    ]);
    await runChargeCheck(
      morning.sunsynk as unknown as never,
      morning.octopus as unknown as never,
      'TEST-SERIAL',
    );
    expect(morning.sunsynk.updateSettings).toHaveBeenCalledWith('TEST-SERIAL', { peakAndVallery: '0' });
    jest.useRealTimers();

    resetAppState();

    // Evening: 80% is at/above the 45% threshold -> stay in normal mode.
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-03T20:00:00'));
    const evening = makeMocks(soc);
    evening.octopus.getPlannedDispatchSlots.mockResolvedValue([
      makeSlot('2026-01-03T19:30:00', '2026-01-03T21:00:00'),
    ]);
    await runChargeCheck(
      evening.sunsynk as unknown as never,
      evening.octopus as unknown as never,
      'TEST-SERIAL',
    );
    expect(evening.sunsynk.updateSettings).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});
