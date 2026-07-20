/**
 * Charge slot history tracking (in-memory only).
 *
 * Responsibilities:
 *  1. Build a stable fingerprint for each dispatch slot so the same logical
 *     slot can be matched across scheduler runs.
 *  2. Merge freshly-fetched Octopus slots into the existing history.
 *  3. Classify slots into `futurePlanned`, `active`, and `fulfilled`.
 *  4. Prune slots whose end time is more than 24 hours in the past.
 *
 * History is kept in memory only (in `appState`) and is intentionally NOT
 * persisted to disk — it is rebuilt from Octopus on each scheduler run and only
 * needs to cover the recent window.
 *
 * IMPORTANT RULE: A slot is only moved to `fulfilled` if the scheduler observed
 * it as active at least once (i.e. `isInChargeSlot` was true during its
 * window). Slots that Octopus planned but never became active — because they
 * were cancelled, moved, or the server was offline — are NOT recorded as
 * fulfilled. This keeps the history truthful to what actually happened.
 */
import { DispatchSlot, SlotHistory, TrackedSlot } from '../types';

/** Slots whose end time is older than this are dropped from the history. */
export const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;

/** An empty in-memory history. */
export function createEmptyHistory(): SlotHistory {
  return { fulfilled: [], active: [], futurePlanned: [] };
}

/**
 * Build a stable fingerprint for a dispatch slot.
 *
 * Uses start + end + source so the same logical slot is matched even if
 * Octopus re-issues its planned dispatch list with re-ordered entries.
 */
export function slotFingerprint(slot: DispatchSlot): string {
  return [slot.start, slot.end, slot.source].join('|');
}

/**
 * Create a TrackedSlot from a raw DispatchSlot.
 */
export function trackSlot(slot: DispatchSlot, now: string): TrackedSlot {
  return {
    ...slot,
    fingerprint: slotFingerprint(slot),
    status: classifySlot(slot, now),
    firstSeen: now,
    lastSeen: now,
  };
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

function byStart(a: TrackedSlot, b: TrackedSlot): number {
  return new Date(a.start).getTime() - new Date(b.start).getTime();
}

/**
 * Merge freshly-fetched slots into the existing history.
 *
 * Algorithm:
 *  - Build a map of existing tracked slots keyed by fingerprint.
 *  - For each fresh slot:
 *      • If seen before → update `lastSeen` and reclassify status.
 *      • If new        → add as a new TrackedSlot.
 *  - Promote active slots whose end time has passed to `fulfilled`, BUT only
 *    if they were observed as active (status was "active" in the existing
 *    history) or `wasInChargeSlot` is true this run. Slots that were only ever
 *    "upcoming" and then disappeared, or jumped straight to past without being
 *    observed active, are dropped.
 *  - Slots currently in their window → `active`.
 *  - Slots starting in the future → `futurePlanned`.
 *  - Finally, prune any slot whose end time is more than 24 hours in the past.
 *
 * @param freshSlots   Raw dispatch slots from Octopus this run.
 * @param existing     The current in-memory history.
 * @param nowIso       ISO timestamp of this scheduler run.
 * @param wasInChargeSlot  Whether the scheduler detected an active slot this
 *                          run (used to confirm a slot was actually observed
 *                          active before it can be fulfilled).
 */
export function mergeSlots(
  freshSlots: DispatchSlot[],
  existing: SlotHistory,
  nowIso: string,
  wasInChargeSlot: boolean,
): SlotHistory {
  const now = new Date(nowIso).getTime();

  // Index existing tracked slots by fingerprint for quick lookup
  const existingByFp = new Map<string, TrackedSlot>();
  for (const s of [...existing.fulfilled, ...existing.active, ...existing.futurePlanned]) {
    existingByFp.set(s.fingerprint, s);
  }

  // Track which fingerprints we've seen this run
  const seenFps = new Set<string>();

  // Process fresh slots from Octopus
  const active: TrackedSlot[] = [];
  const futurePlanned: TrackedSlot[] = [];

  for (const raw of freshSlots) {
    const fp = slotFingerprint(raw);
    seenFps.add(fp);
    const status = classifySlot(raw, nowIso);

    const prev = existingByFp.get(fp);
    if (prev) {
      // Update existing tracked slot
      const updated: TrackedSlot = {
        ...prev,
        ...raw,
        fingerprint: fp,
        status,
        lastSeen: nowIso,
      };
      existingByFp.set(fp, updated);
      if (status === 'active') active.push(updated);
      else if (status === 'upcoming') futurePlanned.push(updated);
      // fulfilled fresh slots are handled below via promotion
    } else {
      // New slot — only track if upcoming or active (not already past)
      if (status === 'fulfilled') {
        // Slot already ended and we never saw it — skip it.
        continue;
      }
      const tracked = trackSlot(raw, nowIso);
      if (status === 'active') active.push(tracked);
      else futurePlanned.push(tracked);
      existingByFp.set(fp, tracked);
    }
  }

  // Promote previously-active slots whose end has now passed to fulfilled.
  // Only promote if the slot was observed as active (status was "active" in
  // existing history) OR wasInChargeSlot is true this run. Slots that
  // disappeared from the fresh list before ending are simply dropped.
  const fulfilled: TrackedSlot[] = [...existing.fulfilled];

  for (const [fp, tracked] of existingByFp) {
    if (seenFps.has(fp)) continue; // still in fresh list, handled above
    const end = new Date(tracked.end).getTime();
    if (now >= end && (tracked.status === 'active' || wasInChargeSlot)) {
      // Slot has ended and was observed active — record it as fulfilled.
      if (!fulfilled.some((f) => f.fingerprint === fp)) {
        fulfilled.push({ ...tracked, status: 'fulfilled', lastSeen: nowIso });
      }
    }
    // Otherwise drop it (never observed active, or cancelled before ending).
  }

  // Prune anything whose end time is more than 24 hours in the past.
  const cutoff = now - HISTORY_RETENTION_MS;
  const isRecent = (s: TrackedSlot) => new Date(s.end).getTime() >= cutoff;

  return {
    fulfilled: fulfilled.filter(isRecent).sort(byStart),
    active: active.filter(isRecent).sort(byStart),
    futurePlanned: futurePlanned.filter(isRecent).sort(byStart),
  };
}

/**
 * Filter fulfilled slots to those whose end time fell on the previous
 * calendar day (relative to `nowIso`), in the server's local timezone.
 */
export function yesterdaySlots(history: SlotHistory, nowIso: string): TrackedSlot[] {
  const now = new Date(nowIso);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate()).getTime();
  const yEnd = yStart + 24 * 60 * 60 * 1000;

  return history.fulfilled.filter((s) => {
    const end = new Date(s.end).getTime();
    return end >= yStart && end < yEnd;
  });
}
