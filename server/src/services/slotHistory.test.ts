/**
 * Unit tests for the slot history service.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  slotFingerprint,
  trackSlot,
  classifySlot,
  mergeSlots,
  yesterdaySlots,
  loadSlotHistory,
  saveSlotHistory,
} from './slotHistory';
import { DispatchSlot, SlotHistory } from '../types';

function makeSlot(startIso: string, endIso: string, source = 'smart-charge'): DispatchSlot {
  return { start: startIso, end: endIso, source, deltaKwh: -10, location: null };
}

function emptyHistory(): SlotHistory {
  return { fulfilled: [], active: [], futurePlanned: [], removed: [] };
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
      removed: [],
    };
    const result = mergeSlots([slot], existing, '2026-01-02T20:15:00Z', true);
    expect(result.active[0].lastSeen).toBe('2026-01-02T20:15:00Z');
  });

  it('DOES NOT promote a slot to fulfilled if wasInChargeSlot is false', () => {
    // Slot was only ever upcoming and was never observed active
    const slot = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');
    const existing: SlotHistory = {
      fulfilled: [],
      active: [],
      futurePlanned: [{ ...trackSlot(slot, '2026-01-02T10:00:00Z'), status: 'upcoming' }],
      removed: [],
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
      removed: [],
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
      removed: [],
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
      removed: [],
    };
    // Slot ended and was never active
    const result = mergeSlots([], existing, '2026-01-02T22:00:00Z', false);
    expect(result.fulfilled).toHaveLength(0);
    expect(result.active).toHaveLength(0);
    expect(result.futurePlanned).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  it('marks a disappeared upcoming slot as removed', () => {
    const slot = makeSlot('2026-01-03T20:00:00Z', '2026-01-03T21:30:00Z');
    const existing: SlotHistory = {
      fulfilled: [],
      active: [],
      futurePlanned: [{ ...trackSlot(slot, '2026-01-02T10:00:00Z'), status: 'upcoming' }],
      removed: [],
    };
    // Slot hasn't ended yet but Octopus removed it from the dispatch list
    const result = mergeSlots([], existing, '2026-01-02T12:00:00Z', false);
    expect(result.futurePlanned).toHaveLength(0);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].fingerprint).toBe(slotFingerprint(slot));
    expect(result.removed[0].status).toBe('removed');
  });

  it('keeps an active slot active when it drops from the fresh list mid-window', () => {
    // Octopus removes a dispatch from plannedDispatches the moment it activates,
    // so a slot that is currently within its window can vanish from the fresh
    // list. It must NOT be treated as removed — it is still charging.
    const slot = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');
    const existing: SlotHistory = {
      fulfilled: [],
      active: [{ ...trackSlot(slot, '2026-01-02T20:00:00Z'), status: 'active' }],
      futurePlanned: [],
      removed: [],
    };
    // Slot is still in its window but disappeared from fresh list
    const result = mergeSlots([], existing, '2026-01-02T20:15:00Z', false);
    expect(result.removed).toHaveLength(0);
    expect(result.active).toHaveLength(1);
    expect(result.active[0].fingerprint).toBe(slotFingerprint(slot));
    expect(result.active[0].observedActive).toBe(true);
  });

  it('promotes a slot to fulfilled even if it is still present in the fresh list after ending', () => {
    // Regression: a slot Octopus still lists after its end must reach fulfilled.
    const slot = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');
    const existing: SlotHistory = {
      fulfilled: [],
      active: [{ ...trackSlot(slot, '2026-01-02T20:00:00Z'), status: 'active', observedActive: true }],
      futurePlanned: [],
      removed: [],
    };
    // Slot has ended but Octopus still returns it in the dispatch list
    const result = mergeSlots([slot], existing, '2026-01-02T22:00:00Z', false);
    expect(result.fulfilled).toHaveLength(1);
    expect(result.fulfilled[0].fingerprint).toBe(slotFingerprint(slot));
    expect(result.active).toHaveLength(0);
  });

  it('recovers a slot from removed and fulfils it once its window passes', () => {
    // Regression for the plannedDispatches drop: slot goes active off-list,
    // then ends, across successive runs — it must end up fulfilled, not stuck.
    const slot = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');
    const existing: SlotHistory = {
      fulfilled: [],
      active: [],
      futurePlanned: [{ ...trackSlot(slot, '2026-01-02T10:00:00Z'), status: 'upcoming' }],
      removed: [],
    };
    // Run 1: window has begun but Octopus already dropped it from the list.
    const run1 = mergeSlots([], existing, '2026-01-02T20:15:00Z', false);
    expect(run1.active).toHaveLength(1);
    expect(run1.removed).toHaveLength(0);

    // Run 2: still off-list, still within window.
    const run2 = mergeSlots([], run1, '2026-01-02T21:00:00Z', false);
    expect(run2.active).toHaveLength(1);

    // Run 3: window has ended → fulfilled.
    const run3 = mergeSlots([], run2, '2026-01-02T22:00:00Z', false);
    expect(run3.fulfilled).toHaveLength(1);
    expect(run3.active).toHaveLength(0);
    expect(run3.removed).toHaveLength(0);
  });

  it('does not duplicate removed slots on repeated runs', () => {
    const slot = makeSlot('2026-01-03T20:00:00Z', '2026-01-03T21:30:00Z');
    // First run: slot disappears
    const existing1: SlotHistory = {
      fulfilled: [],
      active: [],
      futurePlanned: [{ ...trackSlot(slot, '2026-01-02T10:00:00Z'), status: 'upcoming' }],
      removed: [],
    };
    const result1 = mergeSlots([], existing1, '2026-01-02T12:00:00Z', false);
    expect(result1.removed).toHaveLength(1);

    // Second run: slot still gone, should not duplicate
    const result2 = mergeSlots([], result1, '2026-01-02T14:00:00Z', false);
    expect(result2.removed).toHaveLength(1);
  });

  it('keeps a slot in active if it is currently in its window', () => {
    const slot = makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z');
    const existing: SlotHistory = {
      fulfilled: [],
      active: [{ ...trackSlot(slot, '2026-01-02T20:00:00Z'), status: 'active' }],
      futurePlanned: [],
      removed: [],
    };
    const result = mergeSlots([slot], existing, '2026-01-02T20:15:00Z', true);
    expect(result.active).toHaveLength(1);
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
      removed: [],
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
      removed: [],
    };
    const result = yesterdaySlots(history, '2026-01-03T12:00:00Z');
    expect(result).toHaveLength(0);
  });
});

describe('loadSlotHistory / saveSlotHistory', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-history-test-'));
  const tmpFile = path.join(tmpDir, 'slot-history.json');

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves and loads a history round-trip correctly', () => {
    const history: SlotHistory = {
      fulfilled: [
        { ...makeSlot('2026-01-02T20:00:00Z', '2026-01-02T21:30:00Z'), fingerprint: 'fp1', status: 'fulfilled', firstSeen: '2026-01-02T19:00:00Z', lastSeen: '2026-01-02T22:00:00Z' },
      ],
      active: [],
      futurePlanned: [
        { ...makeSlot('2026-01-03T20:00:00Z', '2026-01-03T21:30:00Z'), fingerprint: 'fp2', status: 'upcoming', firstSeen: '2026-01-02T10:00:00Z', lastSeen: '2026-01-02T10:00:00Z' },
      ],
      removed: [],
    };

    saveSlotHistory(history, tmpFile);
    const loaded = loadSlotHistory(tmpFile);

    expect(loaded.fulfilled).toHaveLength(1);
    expect(loaded.fulfilled[0].fingerprint).toBe('fp1');
    expect(loaded.futurePlanned).toHaveLength(1);
    expect(loaded.futurePlanned[0].fingerprint).toBe('fp2');
  });

  it('loadSlotHistory returns empty history for non-existent file', () => {
    const result = loadSlotHistory('/non/existent/path.json');
    expect(result.fulfilled).toHaveLength(0);
    expect(result.active).toHaveLength(0);
    expect(result.futurePlanned).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  it('loadSlotHistory returns empty history for invalid JSON', () => {
    const badFile = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(badFile, 'not valid json {{{', 'utf-8');
    const result = loadSlotHistory(badFile);
    expect(result.fulfilled).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  it('saves and loads removed slots correctly', () => {
    const history: SlotHistory = {
      fulfilled: [],
      active: [],
      futurePlanned: [],
      removed: [
        { ...makeSlot('2026-01-03T20:00:00Z', '2026-01-03T21:30:00Z'), fingerprint: 'fp-removed', status: 'removed', firstSeen: '2026-01-02T10:00:00Z', lastSeen: '2026-01-02T12:00:00Z' },
      ],
    };

    saveSlotHistory(history, tmpFile);
    const loaded = loadSlotHistory(tmpFile);

    expect(loaded.removed).toHaveLength(1);
    expect(loaded.removed[0].fingerprint).toBe('fp-removed');
    expect(loaded.removed[0].status).toBe('removed');
  });
});