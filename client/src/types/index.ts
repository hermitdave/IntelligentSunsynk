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

export type PowerGraphLabel = 'PV' | 'Battery' | 'SOC' | 'Load' | 'Grid';

export const POWER_GRAPH_LABELS: PowerGraphLabel[] = ['PV', 'Battery', 'SOC', 'Load', 'Grid'];

export const POWER_GRAPH_COLOURS: Record<PowerGraphLabel, string> = {
  PV: '#f59e0b',
  Battery: '#22c55e',
  SOC: '#3b82f6',
  Load: '#ef4444',
  Grid: '#8b5cf6',
};

export interface ApiEnergyFlowResponse {
  plantId: number;
  flow: Record<string, unknown>;
}
