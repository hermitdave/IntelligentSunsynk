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

export interface SunsynkPlant {
  id: number;
  name: string;
}

export interface SunsynkInverter {
  sn: string;
  alias?: string;
  plantId?: number;
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
  /** Current control mode applied to the inverter */
  controlMode: ControlMode;
  /** ISO timestamp of last successful scheduler run */
  lastUpdated: string | null;
  /** Error message from the last scheduler run (null if no error) */
  lastError: string | null;
  /** Total number of scheduler runs */
  runCount: number;
}
