/**
 * Client-side API service – proxied to the Express server via Vite dev proxy.
 */
import axios from 'axios';
import { AppState, ApiChargeSlotsResponse, ApiSettingsResponse } from '../types';

const api = axios.create({ baseURL: '/api', timeout: 15_000 });

export async function fetchStatus(): Promise<AppState> {
  const { data } = await api.get<AppState>('/status');
  return data;
}

export async function fetchChargeSlots(): Promise<ApiChargeSlotsResponse> {
  const { data } = await api.get<ApiChargeSlotsResponse>('/charge-slots');
  return data;
}

export async function fetchSettings(): Promise<ApiSettingsResponse> {
  const { data } = await api.get<ApiSettingsResponse>('/settings');
  return data;
}

export async function triggerRefresh(): Promise<AppState> {
  const { data } = await api.post<{ ok: boolean; state: AppState }>('/refresh');
  return data.state;
}
