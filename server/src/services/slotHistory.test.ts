/**
 * Unit tests for the slot view derivation.
 */
import {
  slotFingerprint,
  trackSlot,
  classifySlot,
  buildSlotView,
  yesterdaySlots,
} from './slotHistory';
import { DispatchSlot, SlotHistory } from '../types';

function makeSlot(startIso: string, endIso: string, source = 'smart-charge'): DispatchSlot {
  return { start: startIso, end: endIso, source, deltaKwh: -10, location: null };
}

describe('slotFingerprint', () => {
  it('produces identical fingerprints for the same slot', () => {
    const s1 = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');
    const s2 = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');
    expect(slotFingerprint(s1)).toBe(slotFingerprint(s2));
  });

  it('produces different fingerprints for different start times', () => {
    const s1 = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');
    const s2 = makeSlot('2026-01-02T21:00:00Z', '2026-01-02T21:30:00Z');
    expect(slotFingerprint(s1)).not.toBe(slotFingerprint(s2));
  });

  it('produces different fingerprints for different sources', () => {
    const s1 = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z', 'smart-charge');
    const s2 = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z', 'unknown');
    expect(slotFingerprint(s1)).not.toBe(slotFingerprint(s2));
  });
});

describe('classifySlot', () => {
  it('returns "upcoming" when now is before slot start', () => {
    const slot = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');
    expect(classifySlot(slot, '2026-01-02T19:00:00Z')).toBe('upcoming');
  });

  it('returns "active" when now is inside the slot', () => {
    const slot = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');
    expect(classifySlot(slot, '2026-01-02T20:30:00Z')).toBe('active');
  });

  it('returns "active" exactly at slot start', () => {
    const slot = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');
    expect(classifySlot(slot, '2026-01-02T20:00:00Z')).toBe('active');
  });

  it('returns "fulfilled" when now is after slot end', () => {
    const slot = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');
    expect(classifySlot(slot, '2026-01-02T22:00:00Z')).toBe('fulfilled');
  });

  it('returns "fulfilled" exactly at slot end', () => {
    const slot = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');
    expect(classifySlot(slot, '2026-01-02T21:30:00Z')).toBe('fulfilled');
  });
});

describe('trackSlot', () => {
  it('creates a TrackedSlot with all required fields', () => {
    const slot = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');
    const tracked = trackSlot(slot, '2026-01-02T19:00:00Z');
    expect(tracked.fingerprint).toBe(slotFingerprint(slot));
    expect(tracked.status).toBe('upcoming');
    expect(tracked.start).toBe(slot.start);
    expect(tracked.end).toBe(slot.end);
    expect(tracked.source).toBe(slot.source);
  });
});

describe('buildSlotView', () => {
  const nowIso = '2026-01-02T20:15:00Z';

  it('splits planned slots into active and futurePlanned', () => {
    const planned = [
      makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:00:00Z'), // active now
      makeSlot('2026-01-02T22:00:00Z', '2026-01-02T23:00:00Z'), // upcoming
    ];
    const view = buildSlotView(planned, [], nowIso);
    expect(view.active).toHaveLength(1);
    expect(view.active[0].start).toBe('2026-01-02T20:00:00Z');
    expect(view.active[0].status).toBe('active');
    expect(view.futurePlanned).toHaveLength(1);
    expect(view.futurePlanned[0].start).toBe('2026-01-02T22:00:00Z');
    expect(view.futurePlanned[0].status).toBe('upcoming');
    expect(view.fulfilled).toHaveLength(0);
  });

  it('maps completed slots to fulfilled', () => {
    const completed = [
      makeSlot('2026-01-02T18:00:00Z', '2026-01-02T18:30:00Z', 'unknown'),
      makeSlot('2026-01-02T18:30:00Z', '2026-01-02T19:00:00Z', 'unknown'),
    ];
    const view = buildSlotView([], completed, nowIso);
    expect(view.fulfilled).toHaveLength(2);
    expect(view.fulfilled.every((s) => s.status === 'fulfilled')).toBe(true);
    expect(view.active).toHaveLength(0);
    expect(view.futurePlanned).toHaveLength(0);
  });

  it('ignores planned slots that have already ended (completed covers them)', () => {
    const planned = [makeSlot('2026-01-02T10:00:00Z', '2026-01-02T11:00:00Z')]; // past
    const view = buildSlotView(planned, [], nowIso);
    expect(view.active).toHaveLength(0);
    expect(view.futurePlanned).toHaveLength(0);
    expect(view.fulfilled).toHaveLength(0);
  });

  it('sorts each bucket by start time', () => {
    const planned = [
      makeSlot('2026-01-02T23:00:00Z', '2026-01-02T23:30:00Z'),
      makeSlot('2026-01-02T21:00:00Z', '2026-01-02T21:30:00Z'),
      makeSlot('2026-01-02T22:00:00Z', '2026-01-02T22:30:00Z'),
    ];
    const view = buildSlotView(planned, [], nowIso);
    expect(view.futurePlanned.map((s) => s.start)).toEqual([
      '2026-01-02T21:00:00Z',
      '2026-01-02T22:00:00Z',
      '2026-01-02T23:00:00Z',
    ]);
  });
});

describe('yesterdaySlots', () => {
  it('returns fulfilled slots that ended yesterday', () => {
    // If now is 2026-01-03, yesterday is 2026-01-02
    const history: SlotHistory = {
      fulfilled: [
        { ...makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z'), fingerprint: 'a', status: 'fulfilled', firstSeen: '2026-01-02T19:00:00Z', lastSeen: '2026-01-02T22:00:00Z' },
        { ...makeSlot('2026-01-03T20:00:00Z', '2026-01-03T21:30:00Z'), fingerprint: 'b', status: 'fulfilled', firstSeen: '2026-01-03T19:00:00Z', lastSeen: '2026-01-03T22:00:00Z' },
        { ...makeSlot('2026-01-01T20:00:00Z', '2026-01-01T21:30:00Z'), fingerprint: 'c', status: 'fulfilled', firstSeen: '2026-01-01T19:00:00Z', lastSeen: '2026-01-01T22:00:00Z' },
      ],
      active: [],
      futurePlanned: [],
    };
    const result = yesterdaySlots(history, '2026-01-03T12:00:00Z');
    expect(result).toHaveLength(1);
    expect(result[0].fingerprint).toBe('a');
  });

  it('returns empty array when no slots ended yesterday', () => {
    const history: SlotHistory = {
      fulfilled: [
        { ...makeSlot('2026-01-03T20:00:00Z', '2026-01-03T21:30:00Z'), fingerprint: 'b', status: 'fulfilled', firstSeen: '2026-01-03T19:00:00Z', lastSeen: '2026-01-03T22:00:00Z' },
      ],
      active: [],
      futurePlanned: [],
    };
    const result = yesterdaySlots(history, '2026-01-03T12:00:00Z');
    expect(result).toHaveLength(0);
  });
});
