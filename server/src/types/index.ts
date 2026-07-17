/**
 * Shared type definitions for IntelligentSunsynk server.
 */

// =============================================================================
// SUNSYNK TYPES
// =============================================================================

export interface SunsynkToken {
  access_token: string;
  token_type: string;
  refresh_token: string;
  expires_in: number;
}

/**
 * Subset of Sunsynk inverter settings that this application reads and writes.
 * Based on the golden_settings.json reference from SunSynk-Octopus.
 */
export interface InverterSettings {
  /** Peak and valley time-of-use mode: "0" = disabled, "1" = enabled */
  peakAndVallery: string;
  /** System work mode: "0" = Selling First, "1" = Zero Export, "2" = Battery First */
  sysWorkMode?: string;
  /** Grid charge enable: "0" = off, "1" = on */
  sdChargeOn?: string;
  /** Time slot end times (HH:MM) */
  sellTime1?: string;
  sellTime2?: string;
  sellTime3?: string;
  sellTime4?: string;
  sellTime5?: string;
  sellTime6?: string;
  /** Time slot enabled flags */
  time1on?: string;
  time2on?: string;
  time3on?: string;
  time4on?: string;
  time5on?: string;
  time6on?: string;
  /** Time slot target SOC (%) */
  cap1?: string;
  cap2?: string;
  cap3?: string;
  cap4?: string;
  cap5?: string;
  cap6?: string;
  /** Other settings (read-only, not modified by this app) */
  [key: string]: string | undefined;
}

/**
 * Plant overview payload from SunSynk Cloud.
 * The schema may evolve, so this is intentionally open-ended.
 */
export interface SunsynkPlantOverview {
  [key: string]: unknown;
}

/**
 * Plant storage power graph payload from SunSynk Cloud.
 */
export interface SunsynkPowerGraph {
  plantId: number;
  date: string;
  graph: PowerGraphSeries[];
}

export interface PowerGraphRecord {
  time: string;
  value: string;
  updateTime: string | null;
}

export interface PowerGraphSeries {
  unit: string;
  records: PowerGraphRecord[];
  id: string | null;
  label: string;
  sn: string | null;
  groupCode: string | null;
  name: string;
  attribute: string | null;
}

/**
 * Plant energy flow payload from SunSynk Cloud.
 * The schema may evolve, so this is intentionally open-ended.
 */
export interface SunsynkEnergyFlow {
  [key: string]: unknown;
}

// =============================================================================
// OCTOPUS TYPES
// =============================================================================

export interface DispatchSlot {
  /** ISO 8601 datetime string (UTC) */
  start: string;
  /** ISO 8601 datetime string (UTC) */
  end: string;
  /** Source: "smart-charge" or "bump-charge" */
  source: string;
  /** Energy delta in kWh (negative = charging) */
  deltaKwh: number;
  /** Location (home / away) */
  location: string | null;
}

/**
 * Lifecycle status of a dispatch slot relative to the current time.
 * - "upcoming"  – slot has not started yet
 * - "active"    – current time is within the slot window
 * - "fulfilled" – slot end time has passed (was tracked while active)
 * - "removed"   – slot was planned by Octopus but later disappeared from the
 *                 dispatch list (cancelled, moved, or superseded)
 */
export type SlotStatus = 'upcoming' | 'active' | 'fulfilled' | 'removed';

/**
 * A dispatch slot enriched with lifecycle metadata.
 *
 * `fingerprint` is a stable identifier derived from start/end/source so the
 * same logical slot can be matched across scheduler runs even if Octopus
 * re-orders or re-issues its planned dispatch list.
 */
export interface TrackedSlot extends DispatchSlot {
  /** Stable hash of start + end + source for deduplication */
  fingerprint: string;
  /** Current lifecycle status */
  status: SlotStatus;
  /** ISO timestamp of the first scheduler run that observed this slot */
  firstSeen: string;
  /** ISO timestamp of the most recent scheduler run that observed this slot */
  lastSeen: string;
}

/**
 * Persisted charge slot history.
 *
 * `fulfilled` is append-only: once a slot's end time has passed it is moved
 * here and never removed. `yesterday` is a convenience view of fulfilled
 * slots whose end time fell on the previous calendar day. `futurePlanned`
 * holds upcoming slots that have not yet started. `removed` holds slots that
 * were planned by Octopus but later disappeared from the dispatch list.
 */
export interface SlotHistory {
  /** Slots that have completed (end time in the past). Append-only. */
  fulfilled: TrackedSlot[];
  /** Slots scheduled to start in the future. */
  futurePlanned: TrackedSlot[];
  /** Slots currently in their active window. */
  active: TrackedSlot[];
  /** Slots that were planned but later disappeared from Octopus. */
  removed: TrackedSlot[];
}

// =============================================================================
// APPLICATION STATE
// =============================================================================

export type ControlMode = 'charging' | 'discharging' | 'unknown';

export interface AppState {
  /** Whether we have a valid Sunsynk API token */
  isAuthenticated: boolean;
  /** Inverter serial number */
  inverterSerial: string | null;
  /** Plant ID */
  plantId: number | null;
  /** Full inverter settings read on startup (saved snapshot) */
  savedSettings: InverterSettings | null;
  /** Current inverter settings (refreshed after each write) */
  currentSettings: InverterSettings | null;
  /** Latest Intelligent Go dispatch slots from Octopus */
  chargeSlots: DispatchSlot[];
  /** Whether the current time is within an active dispatch slot */
  isInChargeSlot: boolean;
  /** Persisted charge slot history (fulfilled, active, future planned, removed) */
  slotHistory: SlotHistory;
  /** Current control mode applied to the inverter */
  controlMode: ControlMode;
  /** ISO timestamp of last successful scheduler run */
  lastUpdated: string | null;
  /** Error message from the last scheduler run (null if no error) */
  lastError: string | null;
  /** Total number of scheduler runs */
  runCount: number;
}
