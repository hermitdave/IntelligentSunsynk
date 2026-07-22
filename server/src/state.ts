/**
 * Global application state (in-memory).
 *
 * Holds the current status of the scheduler, inverter settings snapshot,
 * and the latest Octopus dispatch slots.
 */
import { AppState } from './types';

export const appState: AppState = {
  isAuthenticated: false,
  inverterSerial: null,
  plantId: null,
  savedSettings: null,
  currentSettings: null,
  chargeSlots: [],
  isInChargeSlot: false,
  isInOvernightWindow: false,
  controlMode: 'unknown',
  lastUpdated: null,
  lastError: null,
  runCount: 0,
};
