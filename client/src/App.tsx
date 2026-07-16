import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, PowerGraphSeries } from './types';
import { fetchEnergyFlow, fetchPlantOverview, fetchPowerGraph, fetchStatus, triggerRefresh } from './services/api';
import { StatusCard } from './components/StatusCard';
import { LoadRechargeCard } from './components/LoadRechargeCard';
import { IOGCard } from './components/IOGCard';
import { ChargeSlots } from './components/ChargeSlots';
import { SettingsView } from './components/SettingsView';
import { PortalDataView } from './components/PortalDataView';
import './App.css';

const POLL_INTERVAL_MS = 30_000; // Auto-refresh every 30 seconds

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function findValueByKeys(
  input: unknown,
  candidateKeys: string[],
): string | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const wanted = new Set(candidateKeys.map(normalizeKey));
  const queue: unknown[] = [input];

  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') {
      continue;
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        queue.push(item);
      }
      continue;
    }

    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      if (wanted.has(normalizeKey(key)) && value !== null && value !== undefined) {
        return String(value);
      }

      if (typeof value === 'object' && value !== null) {
        queue.push(value);
      }
    }
  }

  return null;
}

function getUseTimerLabel(value: string | undefined): string {
  if (value === '0') return 'Disabled (charging mode)';
  if (value === '1') return 'Enabled (normal)';
  return '—';
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [portalError, setPortalError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isPortalLoading, setIsPortalLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'slots' | 'settings' | 'portal'>('dashboard');
  const [powerGraphDate, setPowerGraphDate] = useState(new Date().toISOString().slice(0, 10));
  const [hasLoadedPortalData, setHasLoadedPortalData] = useState(false);
  const [dashboardOverview, setDashboardOverview] = useState<Record<string, unknown> | null>(null);
  const [dashboardFlow, setDashboardFlow] = useState<Record<string, unknown> | null>(null);
  const [powerGraph, setPowerGraph] = useState<PowerGraphSeries[] | null>(null);
  const pollerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const [data, overviewData, flowData] = await Promise.all([
        fetchStatus(),
        fetchPlantOverview(),
        fetchEnergyFlow(),
      ]);
      setState(data);
      setDashboardOverview(overviewData.overview);
      setDashboardFlow(flowData.flow);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect to server');
    }
  }, []);

  const loadPortalData = useCallback(async (date: string) => {
    setIsPortalLoading(true);
    try {
      const graphData = await fetchPowerGraph(date);
      setPowerGraph(graphData.graph);
      setPortalError(null);
    } catch (err) {
      setPortalError(err instanceof Error ? err.message : 'Failed to load portal data');
    } finally {
      setIsPortalLoading(false);
    }
  }, []);

  const handlePortalRefresh = useCallback(() => {
    void loadPortalData(powerGraphDate);
  }, [loadPortalData, powerGraphDate]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const [data, overviewData, flowData] = await Promise.all([
        triggerRefresh(),
        fetchPlantOverview(),
        fetchEnergyFlow(),
      ]);
      setState(data);
      setDashboardOverview(overviewData.overview);
      setDashboardFlow(flowData.flow);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const loadValue =
    findValueByKeys(dashboardOverview, ['load', 'loadPower', 'loadPowerW', 'homeLoad']) ?? '—';
  const rechargeValue =
    findValueByKeys(dashboardOverview, ['recharge', 'chargePower', 'batteryCharge', 'batteryChargePower']) ?? '—';
  const battPower =
    findValueByKeys(dashboardFlow, ['battPower', 'batteryPower']) ?? '—';
  const gridOrMeterPower =
    findValueByKeys(dashboardFlow, ['gridOrMeterPower', 'gridPower', 'meterPower']) ?? '—';
  const loadOrEpsPower =
    findValueByKeys(dashboardFlow, ['loadOrEpsPower', 'loadPower', 'epsPower']) ?? '—';
  const soc =
    findValueByKeys(dashboardFlow, ['soc', 'batterySoc']) ?? '—';
  const useTimerLabel = getUseTimerLabel(state?.currentSettings?.peakAndVallery);

  useEffect(() => {
    if (activeTab !== 'portal' || hasLoadedPortalData) {
      return;
    }

    void loadPortalData(powerGraphDate);
    setHasLoadedPortalData(true);
  }, [activeTab, hasLoadedPortalData, loadPortalData, powerGraphDate]);

  // Auto-poll every 30s
  useEffect(() => {
    pollerRef.current = setInterval(loadStatus, POLL_INTERVAL_MS);
    return () => {
      if (pollerRef.current) clearInterval(pollerRef.current);
    };
  }, [loadStatus]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-inner">
          <div className="header-title">
            <span className="header-icon">☀️</span>
            <h1>IntelligentSunsynk</h1>
            <span className="header-subtitle">Intelligent Octopus Go + SunSynk</span>
          </div>
          {state && (
            <div className="header-status">
              <span className={state.isInChargeSlot ? 'pill pill-green' : 'pill pill-amber'}>
                {state.isInChargeSlot ? '⚡ Charging' : '🔋 Discharging'}
              </span>
            </div>
          )}
        </div>
      </header>

      <nav className="tab-nav">
        <button
          className={activeTab === 'dashboard' ? 'tab active' : 'tab'}
          onClick={() => setActiveTab('dashboard')}
        >
          Dashboard
        </button>
        <button
          className={activeTab === 'slots' ? 'tab active' : 'tab'}
          onClick={() => setActiveTab('slots')}
        >
          Charge Slots
        </button>
        <button
          className={activeTab === 'settings' ? 'tab active' : 'tab'}
          onClick={() => setActiveTab('settings')}
        >
          Settings
        </button>
        <button
          className={activeTab === 'portal' ? 'tab active' : 'tab'}
          onClick={() => setActiveTab('portal')}
        >
          Portal Data
        </button>
      </nav>

      <main className="app-main">
        {error && (
          <div className="error-banner" role="alert">
            ⚠ {error}
          </div>
        )}

        {!state && !error && (
          <div className="loading">
            <div className="spinner" />
            <p>Connecting to server…</p>
          </div>
        )}

        {state && activeTab === 'dashboard' && (
          <>
            <StatusCard
              state={state}
              onRefresh={handleRefresh}
              isRefreshing={isRefreshing}
              battPower={battPower}
              gridOrMeterPower={gridOrMeterPower}
              loadOrEpsPower={loadOrEpsPower}
              soc={soc}
            />
            <IOGCard
              isInChargeSlot={state.isInChargeSlot}
              useTimerLabel={useTimerLabel}
              schedulerRuns={state.runCount}
            />
            <LoadRechargeCard loadValue={loadValue} rechargeValue={rechargeValue} />
          </>
        )}

        {state && activeTab === 'slots' && (
          <ChargeSlots slots={state.chargeSlots} isInChargeSlot={state.isInChargeSlot} />
        )}

        {state && activeTab === 'settings' && (
          <SettingsView saved={state.savedSettings} current={state.currentSettings} />
        )}

        {activeTab === 'portal' && (
          <PortalDataView
            selectedDate={powerGraphDate}
            onDateChange={setPowerGraphDate}
            onRefresh={handlePortalRefresh}
            isLoading={isPortalLoading}
            error={portalError}
            powerGraph={powerGraph}
          />
        )}
      </main>

      <footer className="app-footer">
        <p>Auto-refreshes every 30 seconds · {state ? `Last poll: ${new Date().toLocaleTimeString()}` : 'Waiting…'}</p>
      </footer>
    </div>
  );
}
