/**
 * Global application state (in-memory).
 *
 * Holds the current status of the scheduler, inverter settings snapshot,
 * and the latest Octopus dispatch slots.
 */
import { AppState } from './types';
import { DEFAULT_SOC_THRESHOLD_SCHEDULE, parseSocThresholdSchedule } from './config';

export const appState: AppState = {
  isAuthenticated: false,
  inverterSerial: null,
  plantId: null,
  savedSettings: null,
  currentSettings: null,
  chargeSlots: [],
  isInChargeSlot: false,
  slotHistory: {
    fulfilled: [],
    futurePlanned: [],
    active: [],
    removed: [],
  },
  socThresholdSchedule: parseSocThresholdSchedule(DEFAULT_SOC_THRESHOLD_SCHEDULE),
  controlMode: 'unknown',
  lastUpdated: null,
  lastError: null,
  runCount: 0,
};
