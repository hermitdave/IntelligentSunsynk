/**
 * Unit tests for the charge scheduler core logic.
 */
import { isInChargeSlot, isOvernightTimerWindow, runChargeCheck } from './chargeScheduler';
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
    getDispatchSlots: jest.fn().mockResolvedValue([] as DispatchSlot[]),
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
  appState.slotHistory = {
    fulfilled: [],
    futurePlanned: [],
    active: [],
    removed: [],
  };
}

describe('runChargeCheck', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetAppState();
  });

  it('sets peakAndVallery to "0" (charging) during overnight window regardless of slot', async () => {
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

    expect(sunsynk.updateSettings).toHaveBeenCalledWith('TEST-SERIAL', { peakAndVallery: '0' });
    jest.useRealTimers();
  });

  it('sets peakAndVallery to "0" (charging) during overnight window even when in a slot', async () => {
    const fixedDate = new Date('2026-01-03T02:00:00');
    jest.useFakeTimers();
    jest.setSystemTime(fixedDate);

    // Slot covers the current fake time
    const slot = makeSlot('2026-01-03T01:00:00Z', '2026-01-03T03:00:00Z');
    const { sunsynk, octopus } = makeMocks(80);
    octopus.getDispatchSlots.mockResolvedValue([slot]);

    await runChargeCheck(
      sunsynk as unknown as never,
      octopus as unknown as never,
      'TEST-SERIAL',
    );

    expect(sunsynk.updateSettings).toHaveBeenCalledWith('TEST-SERIAL', { peakAndVallery: '0' });
    jest.useRealTimers();
  });

  it('sets peakAndVallery to "0" when in a charge slot and battery SoC < 50', async () => {
    // Daytime, outside overnight window
    const fixedDate = new Date('2026-01-03T12:00:00Z');
    jest.useFakeTimers();
    jest.setSystemTime(fixedDate);

    const slot = makeSlot('2026-01-03T11:00:00Z', '2026-01-03T13:00:00Z');
    const { sunsynk, octopus } = makeMocks(30); // battery SoC 30%
    octopus.getDispatchSlots.mockResolvedValue([slot]);

    await runChargeCheck(
      sunsynk as unknown as never,
      octopus as unknown as never,
      'TEST-SERIAL',
    );

    expect(sunsynk.getBatterySoC).toHaveBeenCalledWith(123);
    expect(sunsynk.updateSettings).toHaveBeenCalledWith('TEST-SERIAL', { peakAndVallery: '0' });
    jest.useRealTimers();
  });

  it('keeps peakAndVallery at "1" when in a charge slot but battery SoC >= 50', async () => {
    const fixedDate = new Date('2026-01-03T12:00:00Z');
    jest.useFakeTimers();
    jest.setSystemTime(fixedDate);

    const slot = makeSlot('2026-01-03T11:00:00Z', '2026-01-03T13:00:00Z');
    const { sunsynk, octopus } = makeMocks(65); // battery SoC 65%
    octopus.getDispatchSlots.mockResolvedValue([slot]);

    await runChargeCheck(
      sunsynk as unknown as never,
      octopus as unknown as never,
      'TEST-SERIAL',
    );

    expect(sunsynk.getBatterySoC).toHaveBeenCalledWith(123);
    expect(sunsynk.updateSettings).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('keeps peakAndVallery at "1" when in a charge slot but battery SoC unavailable', async () => {
    const fixedDate = new Date('2026-01-03T12:00:00Z');
    jest.useFakeTimers();
    jest.setSystemTime(fixedDate);

    const slot = makeSlot('2026-01-03T11:00:00Z', '2026-01-03T13:00:00Z');
    const { sunsynk, octopus } = makeMocks(null); // SoC unavailable
    octopus.getDispatchSlots.mockResolvedValue([slot]);

    await runChargeCheck(
      sunsynk as unknown as never,
      octopus as unknown as never,
      'TEST-SERIAL',
    );

    expect(sunsynk.updateSettings).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('keeps peakAndVallery at "1" when outside a charge slot and outside overnight window', async () => {
    const fixedDate = new Date('2026-01-03T12:00:00Z');
    jest.useFakeTimers();
    jest.setSystemTime(fixedDate);

    const { sunsynk, octopus } = makeMocks(30);
    octopus.getDispatchSlots.mockResolvedValue([]);

    await runChargeCheck(
      sunsynk as unknown as never,
      octopus as unknown as never,
      'TEST-SERIAL',
    );

    expect(sunsynk.getBatterySoC).not.toHaveBeenCalled();
    expect(sunsynk.updateSettings).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('holds charge mode when a tracked slot is active but Octopus has dropped it from the list', async () => {
    // Regression: Octopus removes a dispatch from plannedDispatches the moment
    // it activates. The slot was tracked as upcoming on an earlier run, so the
    // merge promotes it to active from its window — charge mode must hold even
    // though the fresh list is now empty.
    const fixedDate = new Date('2026-01-03T12:00:00Z');
    jest.useFakeTimers();
    jest.setSystemTime(fixedDate);

    const slot = makeSlot('2026-01-03T11:00:00Z', '2026-01-03T13:00:00Z');
    appState.slotHistory.futurePlanned = [
      {
        ...slot,
        fingerprint: [slot.start, slot.end, slot.source].join('|'),
        status: 'upcoming',
        firstSeen: '2026-01-03T10:00:00Z',
        lastSeen: '2026-01-03T10:55:00Z',
      },
    ];

    const { sunsynk, octopus } = makeMocks(30); // SoC 30% (< 50)
    octopus.getDispatchSlots.mockResolvedValue([]); // dropped from planned list

    await runChargeCheck(
      sunsynk as unknown as never,
      octopus as unknown as never,
      'TEST-SERIAL',
    );

    expect(appState.isInChargeSlot).toBe(true);
    expect(appState.slotHistory.active).toHaveLength(1);
    expect(sunsynk.getBatterySoC).toHaveBeenCalledWith(123);
    expect(sunsynk.updateSettings).toHaveBeenCalledWith('TEST-SERIAL', { peakAndVallery: '0' });
    jest.useRealTimers();
  });
});
