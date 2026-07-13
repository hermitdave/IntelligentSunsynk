/**
 * Unit tests for the charge scheduler core logic.
 */
import { isInChargeSlot, isOvernightTimerWindow } from './chargeScheduler';
import { DispatchSlot } from '../types';

function makeSlot(startIso: string, endIso: string): DispatchSlot {
  return { start: startIso, end: endIso, source: 'smart-charge', deltaKwh: -10, location: null };
}

describe('isInChargeSlot', () => {
  const slot: DispatchSlot = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');

  it('returns true when now is exactly at slot start', () => {
    expect(isInChargeSlot(new Date('2026-01-02T20:00:00Z'), [slot])).toBe(true);
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
