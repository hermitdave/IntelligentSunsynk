/**
 * Charge slot history tracking and persistence.
 *
 * Responsibilities:
 *  1. Build a stable fingerprint for each dispatch slot so the same logical
 *     slot can be matched across scheduler runs.
 *  2. Merge freshly-fetched Octopus slots into the existing history.
 *  3. Classify slots into `futurePlanned`, `active`, and `fulfilled`.
 *  4. Persist the history to disk so it survives server restarts.
 *
 * IMPORTANT RULE: A slot is only moved to `fulfilled` if the scheduler
 * observed it as active at least once (i.e. `isInChargeSlot` was true during
 * its window). Slots that Octopus planned but never became active — because
 * they were cancelled, moved, or the server was offline — are NOT recorded as
 * fulfilled. This keeps the history truthful to what actually happened.
 */
import fs from 'fs';
import path from 'path';
import { DispatchSlot, SlotHistory, TrackedSlot } from '../types';

/** Default path for the persisted history file (relative to server cwd). */
const DEFAULT_HISTORY_FILE = path.resolve(process.cwd(), 'data', 'slot-history.json');

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
 *    history). Slots that were only ever "upcoming" and then disappeared or
 *    jumped straight to past without being observed active are dropped.
 *  - Slots currently in their window → `active`.
 *  - Slots starting in the future → `futurePlanned`.
 *
 * @param freshSlots   Raw dispatch slots from Octopus this run.
 * @param existing     The current persisted history.
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
        // Slot already ended and we never saw it — skip unless we are
        // currently in a charge slot (edge case: slot just ended this run)
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
  // existing history) OR wasInChargeSlot is true this run for this slot.
  // Slots that disappeared from the fresh list (cancelled/moved by Octopus)
  // are marked as "removed" so users can see what was cancelled.
  const fulfilled: TrackedSlot[] = [...existing.fulfilled];
  const removed: TrackedSlot[] = [...existing.removed];

  for (const [fp, tracked] of existingByFp) {
    if (seenFps.has(fp)) continue; // still in fresh list, handled above
    const end = new Date(tracked.end).getTime();
    if (now >= end) {
      // Slot has ended. Only persist as fulfilled if it was observed active.
      if (tracked.status === 'active' || wasInChargeSlot) {
        const fulfilledSlot: TrackedSlot = {
          ...tracked,
          status: 'fulfilled',
          lastSeen: nowIso,
        };
        // Avoid duplicates in fulfilled
        if (!fulfilled.some((f) => f.fingerprint === fp)) {
          fulfilled.push(fulfilledSlot);
        }
      }
      // If not observed active, drop it silently (already ended)
    } else {
      // Slot hasn't ended yet but disappeared from Octopus — mark as removed
      const removedSlot: TrackedSlot = {
        ...tracked,
        status: 'removed',
        lastSeen: nowIso,
      };
      if (!removed.some((r) => r.fingerprint === fp)) {
        removed.push(removedSlot);
      }
    }
  }

  // Sort each bucket by start time
  fulfilled.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  active.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  futurePlanned.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  removed.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  return { fulfilled, active, futurePlanned, removed };
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

// =============================================================================
// Persistence
// =============================================================================

/**
 * Load slot history from disk. Returns an empty history if the file does not
 * exist or cannot be parsed.
 */
export function loadSlotHistory(filePath: string = DEFAULT_HISTORY_FILE): SlotHistory {
  try {
    if (!fs.existsSync(filePath)) {
      return { fulfilled: [], active: [], futurePlanned: [], removed: [] };
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as SlotHistory;
    return {
      fulfilled: Array.isArray(parsed.fulfilled) ? parsed.fulfilled : [],
      active: Array.isArray(parsed.active) ? parsed.active : [],
      futurePlanned: Array.isArray(parsed.futurePlanned) ? parsed.futurePlanned : [],
      removed: Array.isArray(parsed.removed) ? parsed.removed : [],
    };
  } catch (err) {
    console.error('[SlotHistory] Failed to load history file:', err);
    return { fulfilled: [], active: [], futurePlanned: [], removed: [] };
  }
}

/**
 * Save slot history to disk. Creates the parent directory if needed.
 * Writes atomically by writing to a temp file then renaming.
 */
export function saveSlotHistory(
  history: SlotHistory,
  filePath: string = DEFAULT_HISTORY_FILE,
): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    console.error('[SlotHistory] Failed to save history file:', err);
  }
}
