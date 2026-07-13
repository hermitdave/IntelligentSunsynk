import { AppState } from '../types';

interface StatusCardProps {
  state: AppState;
  onRefresh: () => void;
  isRefreshing: boolean;
}

function formatTime(isoString: string | null): string {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleString();
}

function ModeBadge({ mode }: { mode: AppState['controlMode'] }) {
  const colours: Record<AppState['controlMode'], string> = {
    charging: '#22c55e',
    discharging: '#f59e0b',
    unknown: '#94a3b8',
  };
  const labels: Record<AppState['controlMode'], string> = {
    charging: '⚡ Charging',
    discharging: '🔋 Discharging',
    unknown: '❓ Unknown',
  };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '4px 12px',
        borderRadius: 9999,
        backgroundColor: colours[mode],
        color: '#fff',
        fontWeight: 600,
        fontSize: 14,
      }}
    >
      {labels[mode]}
    </span>
  );
}

function getPeakValleyLabel(value: string): string {
  if (value === '0') return 'Disabled (charging mode)';
  if (value === '1') return 'Enabled (normal)';
  return '—';
}

export function StatusCard({ state, onRefresh, isRefreshing }: StatusCardProps) {
  const peakAndVallery = state.currentSettings?.peakAndVallery ?? '—';
  const peakLabel = getPeakValleyLabel(peakAndVallery);

  return (
    <div className="card">
      <div className="card-header">
        <h2>Current Status</h2>
        <button className="btn-refresh" onClick={onRefresh} disabled={isRefreshing}>
          {isRefreshing ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      <div className="status-grid">
        <div className="status-item">
          <span className="label">Control Mode</span>
          <ModeBadge mode={state.controlMode} />
        </div>

        <div className="status-item">
          <span className="label">In Charge Slot</span>
          <span className={state.isInChargeSlot ? 'value-yes' : 'value-no'}>
            {state.isInChargeSlot ? 'Yes' : 'No'}
          </span>
        </div>

        <div className="status-item">
          <span className="label">Use Timer</span>
          <span className="value">{peakLabel}</span>
        </div>

        <div className="status-item">
          <span className="label">Inverter Serial</span>
          <span className="value mono">{state.inverterSerial ?? '—'}</span>
        </div>

        <div className="status-item">
          <span className="label">Plant ID</span>
          <span className="value">{state.plantId ?? '—'}</span>
        </div>

        <div className="status-item">
          <span className="label">API Authenticated</span>
          <span className={state.isAuthenticated ? 'value-yes' : 'value-no'}>
            {state.isAuthenticated ? 'Yes' : 'No'}
          </span>
        </div>

        <div className="status-item">
          <span className="label">Scheduler Runs</span>
          <span className="value">{state.runCount}</span>
        </div>

        <div className="status-item">
          <span className="label">Last Updated</span>
          <span className="value">{formatTime(state.lastUpdated)}</span>
        </div>
      </div>

      {state.lastError && (
        <div className="error-banner" role="alert">
          <strong>⚠ Last Error:</strong> {state.lastError}
        </div>
      )}
    </div>
  );
}
