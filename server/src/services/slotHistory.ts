/**
 * Charge slot view derivation.
 *
 * The slot view is derived directly from Octopus on demand — there is no
 * persisted or in-memory history. `plannedDispatches` provides the active and
 * upcoming slots; `completedDispatches` provides the fulfilled slots.
 */
import { DispatchSlot, SlotHistory, TrackedSlot } from '../types';

/**
 * Build a stable fingerprint for a dispatch slot (start + end + source).
 * Used as a React key on the client.
 */
export function slotFingerprint(slot: DispatchSlot): string {
  return [slot.start, slot.end, slot.source].join('|');
}

/**
 * Classify a slot's lifecycle status relative to `now`.
 */
export function classifySlot(slot: DispatchSlot, nowIso: string): TrackedSlot['status'] {
  const now = new Date(nowIso).getTime();
  const start = new Date(slot.start).getTime();
  const end = new Date(slot.end).getTime();

  if (now < start) return 'upcoming';
  if (now >= start && now < end) return 'active';
  return 'fulfilled';
}

/** Wrap a raw dispatch slot with lifecycle metadata. */
export function trackSlot(slot: DispatchSlot, nowIso: string): TrackedSlot {
  return {
    ...slot,
    fingerprint: slotFingerprint(slot),
    status: classifySlot(slot, nowIso),
    firstSeen: nowIso,
    lastSeen: nowIso,
  };
}

function byStart(a: TrackedSlot, b: TrackedSlot): number {
  return new Date(a.start).getTime() - new Date(b.start).getTime();
}

/**
 * Build the slot view straight from Octopus data:
 *  - planned slots currently within their window → `active`
 *  - planned slots starting in the future        → `futurePlanned`
 *  - completed slots                             → `fulfilled`
 *
 * Planned slots that have already ended are ignored (they are represented by
 * the completed list instead).
 */
export function buildSlotView(
  planned: DispatchSlot[],
  completed: DispatchSlot[],
  nowIso: string,
): SlotHistory {
  const active: TrackedSlot[] = [];
  const futurePlanned: TrackedSlot[] = [];

  for (const slot of planned) {
    const tracked = trackSlot(slot, nowIso);
    if (tracked.status === 'active') active.push(tracked);
    else if (tracked.status === 'upcoming') futurePlanned.push(tracked);
  }

  const fulfilled: TrackedSlot[] = completed.map((slot) => ({
    ...trackSlot(slot, nowIso),
    status: 'fulfilled',
  }));

  return {
    fulfilled: fulfilled.sort(byStart),
    active: active.sort(byStart),
    futurePlanned: futurePlanned.sort(byStart),
  };
}

/**
 * Filter fulfilled slots to those whose start time fell on the previous
 * calendar day (relative to `nowIso`), in the server's local timezone — i.e.
 * every slot that started yesterday, including one that ran past midnight.
 */
export function yesterdaySlots(history: SlotHistory, nowIso: string): TrackedSlot[] {
  const now = new Date(nowIso);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate()).getTime();
  const yEnd = yStart + 24 * 60 * 60 * 1000;

  return history.fulfilled.filter((s) => {
    const start = new Date(s.start).getTime();
    return start >= yStart && start < yEnd;
  });
}
