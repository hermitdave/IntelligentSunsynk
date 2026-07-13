import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from './types';
import { fetchStatus, triggerRefresh } from './services/api';
import { StatusCard } from './components/StatusCard';
import { ChargeSlots } from './components/ChargeSlots';
import { SettingsView } from './components/SettingsView';
import './App.css';

const POLL_INTERVAL_MS = 30_000; // Auto-refresh every 30 seconds

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'slots' | 'settings'>('dashboard');
  const pollerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const data = await fetchStatus();
      setState(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect to server');
    }
  }, []);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const data = await triggerRefresh();
      setState(data);
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
          <StatusCard state={state} onRefresh={handleRefresh} isRefreshing={isRefreshing} />
        )}

        {state && activeTab === 'slots' && (
          <ChargeSlots slots={state.chargeSlots} isInChargeSlot={state.isInChargeSlot} />
        )}

        {state && activeTab === 'settings' && (
          <SettingsView saved={state.savedSettings} current={state.currentSettings} />
        )}
      </main>

      <footer className="app-footer">
        <p>Auto-refreshes every 30 seconds · {state ? `Last poll: ${new Date().toLocaleTimeString()}` : 'Waiting…'}</p>
      </footer>
    </div>
  );
}
