import { PowerGraphSeries } from '../types';
import { PowerGraphChart } from './PowerGraphChart';

interface PortalDataViewProps {
  selectedDate: string;
  onDateChange: (date: string) => void;
  onRefresh: () => void;
  isLoading: boolean;
  error: string | null;
  powerGraph: PowerGraphSeries[] | null;
}

export function PortalDataView({
  selectedDate,
  onDateChange,
  onRefresh,
  isLoading,
  error,
  powerGraph,
}: PortalDataViewProps) {
  return (
    <div className="card">
      <div className="card-header">
        <h2>SunSynk Portal Data</h2>
        <div className="portal-controls">
          <div className="date-control">
            <label htmlFor="powerGraphDate">Power Graph Date</label>
            <input
              id="powerGraphDate"
              type="date"
              value={selectedDate}
              onChange={(event) => onDateChange(event.target.value)}
            />
          </div>
          <button className="btn-refresh" onClick={onRefresh} disabled={isLoading}>
            {isLoading ? 'Refreshing…' : '↻ Refresh Portal Data'}
          </button>
        </div>
      </div>

      {isLoading && <p className="loading-inline">Loading portal data…</p>}

      {error && (
        <div className="error-banner" role="alert">
          ⚠ {error}
        </div>
      )}

      <div className="portal-grid">
        <section className="portal-full-width">
          <h3>Power Graph ({selectedDate})</h3>
          {powerGraph && powerGraph.length > 0 ? (
            <PowerGraphChart data={powerGraph} />
          ) : (
            <p className="chart-empty">No data loaded yet.</p>
          )}
        </section>
      </div>
    </div>
  );
}