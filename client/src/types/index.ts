/**
 * Shared types for the React client – mirrors the server type definitions.
 */

export interface DispatchSlot {
  start: string;
  end: string;
  source: string;
  deltaKwh: number;
  location: string | null;
}

export type ControlMode = 'charging' | 'discharging' | 'unknown';

export interface AppState {
  isAuthenticated: boolean;
  inverterSerial: string | null;
  plantId: number | null;
  savedSettings: Record<string, string> | null;
  currentSettings: Record<string, string> | null;
  chargeSlots: DispatchSlot[];
  isInChargeSlot: boolean;
  controlMode: ControlMode;
  lastUpdated: string | null;
  lastError: string | null;
  runCount: number;
}

export interface ApiStatusResponse extends AppState {}

export interface ApiChargeSlotsResponse {
  slots: DispatchSlot[];
  isInChargeSlot: boolean;
}

export interface ApiSettingsResponse {
  saved: Record<string, string> | null;
  current: Record<string, string> | null;
}

export interface ApiPlantOverviewResponse {
  plantId: number;
  overview: Record<string, unknown>;
}

export interface ApiPowerGraphResponse {
  plantId: number;
  date: string;
  graph: Record<string, unknown>;
}

export interface ApiEnergyFlowResponse {
  plantId: number;
  flow: Record<string, unknown>;
}
