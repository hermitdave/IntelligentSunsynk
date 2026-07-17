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
 * IMPORTANT RULE: A slot is only moved to `fulfilled` if a scheduler run's
 * clock fell within its [start, end) window at least once (tracked via the
 * sticky `observedActive` flag). Slots that Octopus planned but were cancelled
 * or moved before their window, or that the server never ran during — are NOT
 * recorded as fulfilled. This keeps the history truthful to what happened, and
 * does not rely on the slot still appearing in Octopus's `plannedDispatches`
 * (which drops a dispatch the moment it activates).
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
 * Every previously-tracked slot (from ALL buckets, including `removed`) plus
 * every fresh slot is folded into a single fingerprint-keyed map, then each is
 * re-bucketed from its start/end times relative to `now`:
 *
 *  - Within its window ([start, end)) → `active`, and permanently flagged
 *    `observedActive`. This holds even if the slot has dropped out of the fresh
 *    Octopus list: `plannedDispatches` removes a dispatch the moment it
 *    activates, so presence in the fresh list is NOT a reliable "is active"
 *    signal — the clock is.
 *  - Ended (now ≥ end):
 *      • `observedActive` (ever reached its window) → `fulfilled`.
 *      • otherwise, if it was previously `removed` → stays `removed`.
 *      • otherwise (only ever upcoming, never reached) → dropped, keeping the
 *        history truthful about what actually happened.
 *  - Still upcoming and still advertised by Octopus → `futurePlanned`.
 *  - Still upcoming but gone from the fresh list → `removed` (cancelled/moved).
 *
 * Because slots are re-derived from the map each run, a slot that briefly
 * vanished (and was parked in `removed`) can recover once it is seen again or
 * its window arrives — the previous implementation lost such slots forever.
 *
 * @param freshSlots   Raw dispatch slots from Octopus this run.
 * @param existing     The current persisted history.
 * @param nowIso       ISO timestamp of this scheduler run.
 * @param wasInChargeSlot  Whether the scheduler detected an active slot this
 *                          run. Retained for API compatibility; slot activeness
 *                          is now determined from the clock, not this flag.
 */
export function mergeSlots(
  freshSlots: DispatchSlot[],
  existing: SlotHistory,
  nowIso: string,
  wasInChargeSlot: boolean,
): SlotHistory {
  void wasInChargeSlot; // activeness is derived from slot windows, see below
  const now = new Date(nowIso).getTime();

  // Index every previously-tracked slot by fingerprint. `removed` is included
  // so a slot that briefly disappeared from Octopus can recover rather than
  // being stranded. Later buckets overwrite earlier ones, so the most
  // authoritative state wins and `observedActive` is preserved for slots that
  // were already active or fulfilled.
  const tracked = new Map<string, TrackedSlot>();
  for (const s of existing.removed) tracked.set(s.fingerprint, s);
  for (const s of existing.futurePlanned) tracked.set(s.fingerprint, s);
  for (const s of existing.active) tracked.set(s.fingerprint, { ...s, observedActive: true });
  for (const s of existing.fulfilled) tracked.set(s.fingerprint, { ...s, observedActive: true });

  // Fold in fresh slots: refresh fields + lastSeen, preserving firstSeen and
  // the sticky observedActive flag.
  const seenFps = new Set<string>();
  for (const raw of freshSlots) {
    const fp = slotFingerprint(raw);
    seenFps.add(fp);
    const prev = tracked.get(fp);
    tracked.set(fp, {
      ...raw,
      fingerprint: fp,
      status: prev?.status ?? classifySlot(raw, nowIso),
      firstSeen: prev?.firstSeen ?? nowIso,
      lastSeen: nowIso,
      observedActive: prev?.observedActive,
    });
  }

  const fulfilled: TrackedSlot[] = [];
  const active: TrackedSlot[] = [];
  const futurePlanned: TrackedSlot[] = [];
  const removed: TrackedSlot[] = [];

  for (const [fp, slot] of tracked) {
    const start = new Date(slot.start).getTime();
    const end = new Date(slot.end).getTime();
    const inWindow = now >= start && now < end;
    const ended = now >= end;
    const seen = seenFps.has(fp);
    // Sticky: once we have been inside the window, it stays observed active.
    const observedActive = Boolean(slot.observedActive) || inWindow;
    const lastSeen = seen ? nowIso : slot.lastSeen;

    if (inWindow) {
      // Currently charging — active even if it dropped from the fresh list.
      active.push({ ...slot, status: 'active', observedActive: true, lastSeen });
    } else if (ended) {
      if (observedActive) {
        fulfilled.push({ ...slot, status: 'fulfilled', observedActive: true, lastSeen });
      } else if (slot.status === 'removed') {
        // Was cancelled before it started; keep it visible in removed.
        removed.push({ ...slot, status: 'removed', lastSeen });
      }
      // else: only ever upcoming and never reached → drop silently.
    } else if (seen) {
      // Still upcoming and still advertised by Octopus.
      futurePlanned.push({ ...slot, status: 'upcoming', lastSeen: nowIso });
    } else {
      // Upcoming but no longer advertised → cancelled/moved before starting.
      removed.push({ ...slot, status: 'removed', lastSeen: nowIso });
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
