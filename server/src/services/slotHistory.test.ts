/**
 * Unit tests for the slot history service.
 */
import {
  slotFingerprint,
  trackSlot,
  classifySlot,
  mergeSlots,
  yesterdaySlots,
  createEmptyHistory,
} from './slotHistory';
import { DispatchSlot, SlotHistory } from '../types';

function makeSlot(startIso: string, endIso: string, source = 'smart-charge'): DispatchSlot {
  return { start: startIso, end: endIso, source, deltaKwh: -10, location: null };
}

function emptyHistory(): SlotHistory {
  return createEmptyHistory();
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
    const s2 = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z', 'agile-charging');
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
    expect(tracked.firstSeen).toBe('2026-01-02T19:00:00Z');
    expect(tracked.lastSeen).toBe('2026-01-02T19:00:00Z');
    expect(tracked.start).toBe(slot.start);
    expect(tracked.end).toBe(slot.end);
    expect(tracked.source).toBe(slot.source);
  });
});

describe('mergeSlots', () => {
  it('adds a new upcoming slot to futurePlanned', () => {
    const fresh = [makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z')];
    const result = mergeSlots(fresh, emptyHistory(), '2026-01-02T10:00:00Z', false);
    expect(result.futurePlanned).toHaveLength(1);
    expect(result.active).toHaveLength(0);
    expect(result.fulfilled).toHaveLength(0);
  });

  it('adds a new active slot to active', () => {
    const fresh = [makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z')];
    const result = mergeSlots(fresh, emptyHistory(), '2026-01-02T20:15:00Z', true);
    expect(result.active).toHaveLength(1);
    expect(result.futurePlanned).toHaveLength(0);
  });

  it('updates lastSeen when re-seeing an existing slot', () => {
    const slot = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');
    const existing: SlotHistory = {
      fulfilled: [],
      active: [{ ...trackSlot(slot, '2026-01-02T20:00:00Z'), status: 'active' }],
      futurePlanned: [],
    };
    const result = mergeSlots([slot], existing, '2026-01-02T20:15:00Z', true);
    expect(result.active[0].lastSeen).toBe('2026-01-02T20:15:00Z');
  });

  it('DOES NOT promote a slot to fulfilled if it was never observed active', () => {
    // Slot was only ever upcoming and was never observed active
    const slot = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');
    const existing: SlotHistory = {
      fulfilled: [],
      active: [],
      futurePlanned: [{ ...trackSlot(slot, '2026-01-02T10:00:00Z'), status: 'upcoming' }],
    };
    // Now the slot has ended and wasInChargeSlot is false
    const result = mergeSlots([], existing, '2026-01-02T22:00:00Z', false);
    expect(result.fulfilled).toHaveLength(0);
  });

  it('promotes a slot to fulfilled if wasInChargeSlot is true', () => {
    // Slot ended and was observed active
    const slot = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');
    const existing: SlotHistory = {
      fulfilled: [],
      active: [{ ...trackSlot(slot, '2026-01-02T20:00:00Z'), status: 'active' }],
      futurePlanned: [],
    };
    // Now the slot has ended and wasInChargeSlot is true
    const result = mergeSlots([], existing, '2026-01-02T22:00:00Z', true);
    expect(result.fulfilled).toHaveLength(1);
    expect(result.fulfilled[0].status).toBe('fulfilled');
  });

  it('promotes a slot to fulfilled if it was active in the existing history', () => {
    const slot = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');
    const existing: SlotHistory = {
      fulfilled: [],
      active: [{ ...trackSlot(slot, '2026-01-02T20:00:00Z'), status: 'active' }],
      futurePlanned: [],
    };
    // wasInChargeSlot false but slot was active before
    const result = mergeSlots([], existing, '2026-01-02T22:00:00Z', false);
    expect(result.fulfilled).toHaveLength(1);
  });

  it('drops a slot that was always upcoming and is now past without being active', () => {
    const slot = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');
    const existing: SlotHistory = {
      fulfilled: [],
      active: [],
      futurePlanned: [{ ...trackSlot(slot, '2026-01-02T10:00:00Z'), status: 'upcoming' }],
    };
    // Slot ended and was never active
    const result = mergeSlots([], existing, '2026-01-02T22:00:00Z', false);
    expect(result.fulfilled).toHaveLength(0);
    expect(result.active).toHaveLength(0);
    expect(result.futurePlanned).toHaveLength(0);
  });

  it('drops a planned slot that disappears from Octopus before it starts', () => {
    const slot = makeSlot('2026-01-03T20:00:00Z', '2026-01-03T21:30:00Z');
    const existing: SlotHistory = {
      fulfilled: [],
      active: [],
      futurePlanned: [{ ...trackSlot(slot, '2026-01-02T10:00:00Z'), status: 'upcoming' }],
    };
    // Slot hasn't ended yet but Octopus removed it from the dispatch list
    const result = mergeSlots([], existing, '2026-01-02T12:00:00Z', false);
    expect(result.futurePlanned).toHaveLength(0);
    expect(result.active).toHaveLength(0);
    expect(result.fulfilled).toHaveLength(0);
  });

  it('drops an active slot that disappears from Octopus before it ends', () => {
    const slot = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');
    const existing: SlotHistory = {
      fulfilled: [],
      active: [{ ...trackSlot(slot, '2026-01-02T20:00:00Z'), status: 'active' }],
      futurePlanned: [],
    };
    // Slot is still in its window but disappeared from fresh list
    const result = mergeSlots([], existing, '2026-01-02T20:15:00Z', false);
    expect(result.active).toHaveLength(0);
    expect(result.fulfilled).toHaveLength(0);
  });

  it('keeps a slot in active if it is currently in its window', () => {
    const slot = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');
    const existing: SlotHistory = {
      fulfilled: [],
      active: [{ ...trackSlot(slot, '2026-01-02T20:00:00Z'), status: 'active' }],
      futurePlanned: [],
    };
    const result = mergeSlots([slot], existing, '2026-01-02T20:15:00Z', true);
    expect(result.active).toHaveLength(1);
  });

  it('prunes fulfilled slots whose end is more than 24h in the past', () => {
    const now = '2026-01-03T12:00:00Z';
    const recent = {
      ...makeSlot('2026-01-03T09:00:00Z', '2026-01-03T10:00:00Z'),
      fingerprint: 'recent',
      status: 'fulfilled' as const,
      firstSeen: '2026-01-03T08:00:00Z',
      lastSeen: '2026-01-03T10:00:00Z',
    };
    const old = {
      ...makeSlot('2026-01-02T09:00:00Z', '2026-01-02T10:00:00Z'),
      fingerprint: 'old',
      status: 'fulfilled' as const,
      firstSeen: '2026-01-02T08:00:00Z',
      lastSeen: '2026-01-02T10:00:00Z',
    };
    const existing: SlotHistory = { fulfilled: [recent, old], active: [], futurePlanned: [] };
    // 'old' ended 26h before now → pruned; 'recent' ended 2h before now → kept.
    const result = mergeSlots([], existing, now, false);
    expect(result.fulfilled.map((s) => s.fingerprint)).toEqual(['recent']);
  });

  it('sorts each bucket by start time', () => {
    const slots = [
      makeSlot('2026-01-02T22:00:00Z', '2026-01-02T23:00:00Z'),
      makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:00:00Z'),
      makeSlot('2026-01-02T21:00:00Z', '2026-01-02T22:00:00Z'),
    ];
    const result = mergeSlots(slots, emptyHistory(), '2026-01-02T10:00:00Z', false);
    expect(result.futurePlanned[0].start).toBe('2026-01-02T20:00:00Z');
    expect(result.futurePlanned[1].start).toBe('2026-01-02T21:00:00Z');
    expect(result.futurePlanned[2].start).toBe('2026-01-02T22:00:00Z');
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
