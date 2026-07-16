import { AppState } from '../types';
interface StatusCardProps {
  state: AppState;
  onRefresh: () => void;
  isRefreshing: boolean;
  battPower: string;
  gridOrMeterPower: string;
  loadOrEpsPower: string;
  soc: string;
}

function formatTime(isoString: string | null): string {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleString();
}

function ModeBadge({ mode, soc }: { mode: AppState['controlMode']; soc: string }) {
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
  const socText = soc.endsWith('%') ? soc : soc + '%';
  const suffix = soc !== '—' ? ' - ' + socText : '';
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
      {labels[mode] + suffix}
    </span>
  );
}

export function StatusCard({
  state,
  onRefresh,
  isRefreshing,
  battPower,
  gridOrMeterPower,
  loadOrEpsPower,
  soc,
}: StatusCardProps) {
  return (
    <div className="card">
      <div className="card-header">
        <h2>Current Status</h2>
        <h6>{formatTime(state.lastUpdated)}</h6>
        <button className="btn-refresh" onClick={onRefresh} disabled={isRefreshing}>
          {isRefreshing ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      <div className="status-grid">
        <div className="status-item">
          <span className="label">Control Mode</span>
          <ModeBadge mode={state.controlMode} soc={soc} />
        </div>

        <div className="status-item">
          <span className="label">Load</span>
          <span className="value">{loadOrEpsPower}W</span>
        </div>

        <div className="status-item">
          <span className="label">Battery Power</span>
          <span className="value">{battPower}W</span>
        </div>

        <div className="status-item">
          <span className="label">Grid Power</span>
          <span className="value">{gridOrMeterPower}W</span>
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
